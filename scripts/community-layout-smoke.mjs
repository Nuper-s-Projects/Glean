import assert from 'node:assert/strict';
import { buildMemberListRows, firstMemberRowAtOrAfter, MEMBER_OVERSCAN } from '../src/features/community/memberListLayout.js';

assert.deepEqual(buildMemberListRows([], []), []);
assert.equal(firstMemberRowAtOrAfter([], 500), 0);
const members = Array.from({ length: 1000 }, (_, id) => ({ id: id + 1 }));
const rows = buildMemberListRows([{ role: { id: 7, name: 'Members' }, totalCount: 1000, members }], [{ id: 1001 }]);
assert.equal(rows[0].label, 'Voice — 1');
assert.equal(rows[3].label, 'Members — 1000');
assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
for (let index = 1; index < rows.length; index++) assert.equal(rows[index].top, rows[index - 1].top + rows[index - 1].height);
for (let top = 0; top < 41000; top += 137) {
  const start = firstMemberRowAtOrAfter(rows, Math.max(0, top - MEMBER_OVERSCAN));
  const expected = rows.findIndex(row => row.top + row.height >= Math.max(0, top - MEMBER_OVERSCAN));
  assert.equal(start, expected < 0 ? rows.length : expected);
  const end = firstMemberRowAtOrAfter(rows, top + 800 + MEMBER_OVERSCAN);
  assert.ok(end - start < 32, 'A 1000-member server must render only the visible window');
}
console.log('PASS: member layout, role counts, voice rows, boundaries and 1000-member virtualization');
