import { useEffect, useRef, useState } from 'react';
import { createServerCategory, renameServerCategory, reorderServerCategories, reorderChannels, updateChannel } from '../../app/dmApi';
import './ServerCategories.css';

function CategoryEditor({ category, busy, onSave, onMove, first, last }) {
  const [name, setName] = useState(category.name);
  useEffect(() => setName(category.name), [category.name]);
  return <form className="server-category-editor" onSubmit={(event) => { event.preventDefault(); onSave(name); }}>
    <input aria-label={`Rename ${category.name}`} value={name} maxLength={60} disabled={busy} onChange={(event) => setName(event.target.value)} />
    <button type="submit" disabled={busy || !name.trim() || name.trim() === category.name}>Save</button>
    <button type="button" aria-label={`Move ${category.name} up`} disabled={busy || first} onClick={() => onMove(-1)}>↑</button>
    <button type="button" aria-label={`Move ${category.name} down`} disabled={busy || last} onClick={() => onMove(1)}>↓</button>
  </form>;
}

export default function ServerCategorySettings({ server, onServerUpdated }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const categories = server.categories || [];
  const groups = [{ id: null, name: 'Uncategorized' }, ...categories];
  async function save(operation) {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { await operation(); }
    catch (reason) { setError(reason.message); }
    finally { running.current = false; setBusy(false); }
  }
  function moveCategory(categoryId, direction) {
    const next = [...categories];
    const index = next.findIndex((category) => category.id === categoryId);
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    return save(async () => {
      const data = await reorderServerCategories(server.id, next.map((category) => category.id));
      onServerUpdated?.({ id: server.id, categories: data.categories });
    });
  }
  function moveChannel(channel, direction) {
    const all = [...server.channels];
    const group = all.filter((item) => (item.categoryId ?? null) === (channel.categoryId ?? null));
    const index = group.findIndex((item) => item.id === channel.id);
    [group[index], group[index + direction]] = [group[index + direction], group[index]];
    let slot = 0;
    const next = all.map((item) => (item.categoryId ?? null) === (channel.categoryId ?? null) ? group[slot++] : item);
    return save(async () => {
      await reorderChannels(server.id, next.map((item) => item.id), 'all');
      onServerUpdated?.({ id: server.id, channels: next.map((item, position) => ({ ...item, position })) });
    });
  }
  return <section className="server-category-settings" aria-label="Categories and channel order" aria-busy={busy}>
    <h3>Categories &amp; organization</h3>
    <p>Group text and voice channels. Rename categories, assign channels, and move them up or down.</p>
    <form className="server-category-create" onSubmit={(event) => { event.preventDefault(); save(async () => {
      const data = await createServerCategory(server.id, name.trim());
      onServerUpdated?.({ id: server.id, categories: data.categories }); setName('');
    }); }}>
      <input aria-label="New category name" placeholder="New category name" value={name} maxLength={60} disabled={busy} onChange={(event) => setName(event.target.value)} />
      <button type="submit" disabled={busy || !name.trim()}>Create category</button>
    </form>
    {error ? <p role="alert" className="server-category-error">{error}</p> : null}
    {groups.map((group) => {
      const channels = (server.channels || []).filter((channel) => (channel.categoryId ?? null) === group.id);
      const categoryIndex = categories.findIndex((category) => category.id === group.id);
      return <div className="server-category-settings-group" key={group.id ?? 'none'}>
        {group.id ? <CategoryEditor category={group} busy={busy} first={categoryIndex === 0} last={categoryIndex === categories.length - 1} onMove={(direction) => moveCategory(group.id, direction)} onSave={(value) => save(async () => {
          const data = await renameServerCategory(server.id, group.id, value.trim()); onServerUpdated?.({ id: server.id, categories: data.categories });
        })} /> : <h4>Uncategorized</h4>}
        {!channels.length ? <p className="server-category-empty">No channels in this category.</p> : null}
        {channels.map((channel, index) => <div className="server-category-channel" key={channel.id}>
          <span title={channel.name}>{channel.voice ? '◖' : '#'} {channel.name}</span>
          <select aria-label={`Category for ${channel.name}`} disabled={busy} value={channel.categoryId ?? ''} onChange={(event) => save(async () => {
            const data = await updateChannel(server.id, channel.id, { categoryId: event.target.value === '' ? null : Number(event.target.value) });
            onServerUpdated?.({ id: server.id, channels: server.channels.map((item) => item.id === channel.id ? { ...item, ...data.channel } : item) });
          })}>
            <option value="">Uncategorized</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
          <button type="button" disabled={busy || index === 0} aria-label={`Move ${channel.name} up`} onClick={() => moveChannel(channel, -1)}>↑</button>
          <button type="button" disabled={busy || index === channels.length - 1} aria-label={`Move ${channel.name} down`} onClick={() => moveChannel(channel, 1)}>↓</button>
        </div>)}
      </div>;
    })}
  </section>;
}
