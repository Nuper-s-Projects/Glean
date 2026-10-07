import assert from 'node:assert/strict';
import { createLiveMessageJournal } from '../src/app/liveMessages.js';

const journal = createLiveMessageJournal();
const scope = 'dm:9';
const first = [{ id: 1, body: 'old' }];

let snapshot = journal.revision();
journal.record(scope, 'created', { id: 2, body: 'arrived over websocket' });
assert.deepEqual(journal.mergeSnapshot(scope, [], first, snapshot).map((item) => item.id), [1, 2]);

snapshot = journal.revision();
journal.record(scope, 'edited', { id: 1, body: 'live edit' });
assert.equal(journal.mergeSnapshot(scope, [], [{ id: 1, body: 'stale fetch' }], snapshot)[0].body, 'live edit');

snapshot = journal.revision();
journal.record(scope, 'deleted', null, 1);
assert.deepEqual(journal.mergeSnapshot(scope, [], [{ id: 1, body: 'stale fetch' }], snapshot), []);

snapshot = journal.revision();
assert.equal(journal.mergeSnapshot(scope, [], [{ id: 1, body: 'fresh fetch' }], snapshot)[0].body, 'fresh fetch');

const retained = journal.mergeSnapshot(scope, [{ id: 1, body: 'loaded older history' }], [{ id: 3, body: 'latest' }], snapshot, { retainCurrent: true });
assert.deepEqual(retained.map((item) => item.id), [1, 3]);

console.log('Live message snapshot smoke test passed.');
