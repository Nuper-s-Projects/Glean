import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const handlers = {}, shown = [], opened = [];
const context = vm.createContext({ URL, Date, Promise, setTimeout, clearTimeout, MessageChannel, self: {
  location: { origin: 'https://glean.test' },
  addEventListener: (type, handler) => { handlers[type] = handler; },
  clients: { matchAll: async () => [], openWindow: async url => opened.push(url) },
  registration: { getNotifications: async ({ tag }) => shown.filter(item => item.options.tag === tag).slice(-1).map(item => ({ data: item.options.data })), showNotification: async (title, options) => shown.push({ title, options }) },
} });
vm.runInContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
const push = async payload => { let pending; handlers.push({ data: { json: () => payload }, waitUntil: promise => { pending = promise; } }); await pending; };
await push({ kind: 'dm', title: 'Nura', body: 'hello\nthere', tag: 'dm:1', url: '/dms?c=1' });
assert.equal(shown[0].title, 'Nura · Direct message');
assert.equal(shown[0].options.body, 'hello there');
await Promise.all([push({ kind: 'dm', title: 'Nura', body: 'two', tag: 'dm:1' }), push({ kind: 'dm', title: 'Nura', body: 'three', tag: 'dm:1' })]);
assert.equal(shown.at(-1).options.data.notificationCount, 3);
assert.equal(shown.at(-1).options.renotify, false);
assert.match(shown.at(-1).options.body, /3 new messages/);
await push({ kind: 'friends', title: 'Sam', body: 'Sent you a friend request', tag: 'friends:2' });
assert.equal(shown.at(-1).title, 'Sam · Friend request');
assert.equal(shown.at(-1).options.actions[0].title, 'View request');
await push({ kind: 'channel', title: 'Sam in #general', body: 'hi', tag: 'ch:3' });
assert.equal(shown.at(-1).title, '#general · Glean');
assert.equal(shown.at(-1).options.body, 'Sam: hi');
await push({ kind: 'activity', title: 'Glean', body: 'You have new activity.', tag: 'glean-private-activity' });
assert.equal(shown.at(-1).options.body, 'You have new activity.');
handlers.notificationclick({ action: 'dismiss', notification: { close() {} }, waitUntil() { throw new Error('Dismiss must not navigate'); } });
let pending;
handlers.notificationclick({ action: 'open', notification: { close() {}, data: { url: '/dms?c=1' } }, waitUntil: value => { pending = value; } });
await pending;
assert.deepEqual(opened, ['/dms?c=1']);
console.log('PASS: notification labels, sanitized previews, concurrent grouping, private activity and open/dismiss actions.');
