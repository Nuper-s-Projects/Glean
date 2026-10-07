const MENTION_QUERY = /(^|[\s([{'"])@([\p{L}\p{M}\p{N}\p{S}_]{0,96})$/u;

export const EVERYONE_MENTION = Object.freeze({
  id: 'everyone',
  username: 'everyone',
  roleName: 'Notify everyone',
  mentionKind: 'everyone',
});

export function isEveryoneMention(value) {
  if (!value) return false;
  if (value.mentionKind === 'everyone' || value.id === 'everyone' || value.id === -1) return true;
  return String(value.username || value).replace(/^@/, '').toLowerCase() === 'everyone';
}

export function mentionsEveryone(body) {
  return /(^|[^\p{L}\p{M}\p{N}\p{S}_])@everyone(?![\p{L}\p{M}\p{N}\p{S}_])/iu.test(String(body || ''));
}

export function uniqueMentionUsers(users) {
  const seen = new Set();
  const next = [];
  for (const user of users || []) {
    const username = String(user?.username || '');
    if (!username) continue;
    const nameKey = `n:${username.toLowerCase()}`;
    const idKey = isEveryoneMention(user) ? 'everyone' : user?.id != null && user.id !== '' ? `i:${user.id}` : '';
    if (seen.has(nameKey) || (idKey && seen.has(idKey))) continue;
    seen.add(nameKey);
    if (idKey) seen.add(idKey);
    next.push(user);
  }
  return next;
}

export function mentionQueryAt(text, cursor, users) {
  const before = String(text || '').slice(0, cursor);
  const match = before.match(MENTION_QUERY);
  if (!match) return null;
  const query = match[2].toLowerCase();
  const start = cursor - match[2].length - 1;
  const matches = uniqueMentionUsers(users).filter((user) => String(user.username).toLowerCase().startsWith(query)).slice(0, 8);
  if (!matches.length) return null;
  return { start, query, matches };
}

export function insertMention(text, start, cursor, username) {
  const source = String(text || '');
  const after = source.slice(cursor).replace(/^[^\s]*/, '');
  const next = `${source.slice(0, start)}@${username} ${after}`;
  return { text: next, caret: start + String(username).length + 2 };
}

export function messageMentionsUser(body, username) {
  const text = String(body || '');
  if (mentionsEveryone(text)) return true;
  const name = String(username || '');
  if (!name) return false;
  const pattern = new RegExp(`(^|[^a-z0-9_])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`, 'i');
  return pattern.test(text);
}
