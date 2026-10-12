import assert from 'node:assert/strict';
import { matchingBotCommands } from '../src/features/dm/botCommands.js';

const bots = [{ id: 'nura', name: 'Nura' }];
assert.deepEqual(matchingBotCommands(bots, '/').map(({ name }) => name), ['chat', 'activate', 'deactivate']);
assert.equal(matchingBotCommands(bots, '/ac')[0].name, 'activate');
assert.equal(matchingBotCommands(bots, '/CHAT')[0].name, 'chat');
for (const draft of ['', 'hello /', '/chat hello', '/unknown', '/chat\n']) {
  assert.equal(matchingBotCommands(bots, draft).length, 0, draft);
}
assert.equal(matchingBotCommands([], '/').length, 0);
assert.equal(matchingBotCommands([{ id: 'unknown' }], '/').length, 0);
assert.equal(matchingBotCommands(bots, '/chat', 1).length, 0);
assert.equal(matchingBotCommands(bots, '/')[0].bot, bots[0]);
console.log('Bot command filtering checks passed.');
