export function createServerCategories({ database, withTransaction, authorize, readJson, sendJson, notify, audit }) {
  database.exec(`CREATE TABLE IF NOT EXISTS server_categories (
    id INTEGER PRIMARY KEY, server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60), position INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS server_categories_name ON server_categories(server_id, name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS server_categories_order ON server_categories(server_id, position, id);`);
  if (!database.prepare('PRAGMA table_info(server_channels)').all().some((column) => column.name === 'category_id')) {
    database.exec('ALTER TABLE server_channels ADD COLUMN category_id INTEGER REFERENCES server_categories(id) ON DELETE SET NULL');
  }
  database.exec('CREATE INDEX IF NOT EXISTS server_channels_category ON server_channels(server_id, category_id, position)');
  const rows = database.prepare('SELECT id, name, position FROM server_categories WHERE server_id = ? ORDER BY position, id');
  const find = database.prepare('SELECT id, name, position FROM server_categories WHERE id = ? AND server_id = ?');
  const duplicate = database.prepare('SELECT id FROM server_categories WHERE server_id = ? AND name = ? COLLATE NOCASE');
  const insert = database.prepare('INSERT INTO server_categories (server_id, name, position) VALUES (?, ?, ?)');
  const rename = database.prepare('UPDATE server_categories SET name = ? WHERE id = ? AND server_id = ?');
  const position = database.prepare('UPDATE server_categories SET position = ? WHERE id = ? AND server_id = ?');
  const list = (serverId) => rows.all(serverId).map((row) => ({ id: Number(row.id), name: row.name, position: Number(row.position) }));
  const belongs = (serverId, categoryId) => categoryId === null || (Number.isSafeInteger(categoryId) && Boolean(find.get(categoryId, serverId)));
  const handle = async (request, response, path, method, user) => {
    const match = path.match(/^\/api\/servers\/(\d+)\/categories(?:\/(order|\d+))?$/);
    if (!match) return false;
    const serverId = Number(match[1]);
    if (!user || !authorize(user, serverId)) { sendJson(response, 403, { error: 'Manage channels permission required.' }); return true; }
    try {
      const input = await readJson(request);
      if (method === 'PATCH' && match[2] === 'order') {
        const ids = input.categoryIds;
        const current = list(serverId);
        if (!Array.isArray(ids) || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || !current.some((row) => row.id === id))) {
          sendJson(response, 400, { error: 'Include every category in this server exactly once.' }); return true;
        }
        withTransaction(() => ids.forEach((id, index) => position.run(index, id, serverId)));
        audit(serverId, user, 'category.reordered', { targetType: 'server', targetId: serverId, details: { categoryIds: ids } });
      } else if ((method === 'POST' && !match[2]) || (method === 'PATCH' && /^\d+$/.test(match[2] || ''))) {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) { sendJson(response, 400, { error: 'Use a category name with 1–60 characters.' }); return true; }
        const id = match[2] ? Number(match[2]) : null;
        if (id && !find.get(id, serverId)) { sendJson(response, 404, { error: 'Category not found.' }); return true; }
        const existing = duplicate.get(serverId, name);
        if (existing && Number(existing.id) !== id) { sendJson(response, 409, { error: 'A category with that name already exists.' }); return true; }
        if (!id && list(serverId).length >= 200) { sendJson(response, 400, { error: 'A server can have up to 200 categories.' }); return true; }
        const categoryId = id || Number(insert.run(serverId, name, list(serverId).length).lastInsertRowid);
        if (id) rename.run(name, id, serverId);
        audit(serverId, user, id ? 'category.updated' : 'category.created', { targetType: 'category', targetId: categoryId, targetName: name });
      } else { sendJson(response, 405, { error: 'Method not allowed.' }); return true; }
      notify(serverId, 'server-updated', { serverId, action: 'categories-updated' });
      sendJson(response, method === 'POST' ? 201 : 200, { categories: list(serverId) });
    } catch (error) { sendJson(response, 400, { error: error.message || 'Could not update categories.' }); }
    return true;
  };
  return { list, belongs, handle };
}
