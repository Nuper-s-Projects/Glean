import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';

const DEAD = new Set([404, 410, 403]);

function loadKeys(dataDirectory) {
  const path = join(dataDirectory, 'vapid.json');
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    if (stored?.publicKey && stored?.privateKey) return stored;
  }
  const generated = webpush.generateVAPIDKeys();
  writeFileSync(path, JSON.stringify(generated), { mode: 0o600 });
  return generated;
}

export function createPushService({ database, dataDirectory, canNotify = () => true }) {
  const keys = loadKeys(dataDirectory);
  webpush.setVapidDetails('mailto:glean@local', keys.publicKey, keys.privateKey);

  const upsert = database.prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at
  `);
  const remove = database.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const removeForUser = database.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?');
  const listForUser = database.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?');
  const listUserIds = database.prepare('SELECT DISTINCT user_id FROM push_subscriptions');
  const getPrivacyMode = database.prepare('SELECT keep_information_secret FROM users WHERE id = ?');
  const isServerMuted = database.prepare('SELECT 1 FROM user_server_mutes WHERE user_id = ? AND server_id = ?');

  const drop = (endpoint) => {
    try { remove.run(endpoint); } catch { /* ignore */ }
  };

  const sendToUser = async (userId, payload) => {
    const serverId = Number(payload?.serverId);
    if (serverId > 0 && isServerMuted.get(Number(userId), serverId)) return;
    const rows = listForUser.all(Number(userId));
    if (!rows.length) return;
    if (!canNotify(Number(userId), payload)) return;
    const privateMode = Boolean(Number(getPrivacyMode.get(Number(userId))?.keep_information_secret));
    const safePayload = privateMode ? {
      kind: payload?.kind === 'loop' ? 'loop' : 'activity',
      title: payload?.kind === 'loop' ? 'Loop' : 'Glean',
      body: 'You have new activity.',
      url: payload?.kind === 'loop' ? '/loop' : '/dms',
      tag: payload?.kind === 'loop' ? 'loop-private-activity' : 'glean-private-activity',
    } : payload;
    const body = JSON.stringify(safePayload);
    await Promise.all(rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
          { TTL: 60 * 60 * 12, urgency: 'high', vapidDetails: { subject: 'mailto:glean@local', publicKey: keys.publicKey, privateKey: keys.privateKey } },
        );
      } catch (error) {
        if (DEAD.has(Number(error?.statusCode))) drop(row.endpoint);
      }
    }));
  };

  return {
    publicKey: keys.publicKey,
    subscribe(userId, subscription, now) {
      const endpoint = String(subscription?.endpoint || '').trim();
      const p256dh = String(subscription?.keys?.p256dh || '').trim();
      const auth = String(subscription?.keys?.auth || '').trim();
      if (!/^https:\/\//i.test(endpoint) || endpoint.length > 2048) throw new Error('Invalid push endpoint.');
      if (!p256dh || !auth || p256dh.length > 256 || auth.length > 256) throw new Error('Invalid push keys.');
      upsert.run(endpoint, Number(userId), p256dh, auth, now);
    },
    unsubscribe(userId, endpoint) {
      const value = String(endpoint || '').trim();
      if (!value) return;
      removeForUser.run(value, Number(userId));
    },
    notifyUsers(userIds, payload, exceptUserId) {
      const skip = Number(exceptUserId);
      const targets = [...new Set((userIds || []).map(Number))].filter((id) => id && id !== skip);
      if (!targets.length) return 0;
      setImmediate(() => {
        for (const id of targets) sendToUser(id, payload).catch(() => {});
      });
      return targets.length;
    },
    notifyAll(payload) {
      const ids = listUserIds.all().map((row) => Number(row.user_id)).filter(Boolean);
      return this.notifyUsers(ids, payload);
    },
  };
}
