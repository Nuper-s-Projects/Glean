import assert from 'node:assert/strict';
import { getManagedSchoolAccessState, getSchoolAccessState } from '../server/schoolSchedule.mjs';

const stateAt = (iso) => getSchoolAccessState(new Date(iso), 'America/Chicago');

assert.equal(stateAt('2026-09-21T13:14:59Z').available, true, 'Monday 8:14:59 AM is available');
assert.deepEqual(stateAt('2026-09-21T13:15:00Z'), {
  available: false,
  nextOpenAt: Date.parse('2026-09-21T21:00:00Z'),
  timeZone: 'America/Chicago',
});
assert.equal(stateAt('2026-09-21T20:59:59Z').nextOpenAt, Date.parse('2026-09-21T21:00:00Z'));
assert.equal(stateAt('2026-09-21T21:00:00Z').available, true, 'Monday 4:00 PM is available');
assert.equal(stateAt('2026-09-25T13:15:00Z').nextOpenAt, Date.parse('2026-09-25T19:15:00Z'), 'Friday opens at 2:15 PM');
assert.equal(stateAt('2026-09-25T19:14:59Z').available, false);
assert.equal(stateAt('2026-09-25T19:15:00Z').available, true);
assert.equal(stateAt('2026-09-26T13:15:00Z').available, true, 'weekends are available');
assert.equal(stateAt('2026-01-05T14:15:00Z').nextOpenAt, Date.parse('2026-01-05T22:00:00Z'), 'winter daylight offset is handled');
assert.deepEqual(getManagedSchoolAccessState(new Date('2026-09-21T15:00:00Z'), 'America/Chicago', true), {
  available: true,
  nextOpenAt: null,
  timeZone: 'America/Chicago',
  scheduleOverride: true,
}, 'the admin schedule override allows access during school hours');

console.log('School access schedule smoke tests passed.');
