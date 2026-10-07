import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { createScheduledNotifications, scheduledNotificationAt } from '../server/scheduledNotifications.mjs';

assert.equal(scheduledNotificationAt(new Date('2026-09-21T13:15:00Z'), () => 0).payload.body, 'Good morning, I wish you the best!');
assert.equal(scheduledNotificationAt(new Date('2026-09-24T21:00:00Z'), () => 0).payload.body, 'Stay safe out there!');
assert.equal(scheduledNotificationAt(new Date('2026-09-25T21:00:00Z'), () => 0).payload.body, 'You made it in the week!');
assert.equal(scheduledNotificationAt(new Date('2026-09-26T13:15:00Z')), null);
assert.equal(scheduledNotificationAt(new Date('2026-09-27T21:00:00Z')), null);
assert.equal(scheduledNotificationAt(new Date('2026-09-21T13:14:59Z')), null);

const database = new DatabaseSync(':memory:');
const sent = [];
let current = new Date('2026-09-21T13:15:00Z');
const scheduler = createScheduledNotifications({ database, now: () => current, pushService: { notifyAll: (payload) => sent.push(payload) } });
assert.equal(scheduler.tick(), true);
assert.equal(scheduler.tick(), false);
current = new Date('2026-09-22T13:15:00Z');
assert.equal(scheduler.tick(), true);
assert.equal(sent.length, 2);
database.close();
console.log('Scheduled notification smoke test passed.');
