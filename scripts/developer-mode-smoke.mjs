import assert from 'node:assert/strict';
import {
  estimateBodyBytes,
  getDeveloperTraffic,
  isDeveloperModeEnabled,
  recordDeveloperTraffic,
  setDeveloperModeEnabled,
  subscribeDeveloperMode,
} from '../src/app/developerMode.js';

assert.equal(isDeveloperModeEnabled(), false);
recordDeveloperTraffic('http', { uploaded: 10, downloaded: 20 });
assert.equal(getDeveloperTraffic().http.requests, 0, 'traffic is not collected while disabled');

let observed = null;
const unsubscribe = subscribeDeveloperMode((enabled) => { observed = enabled; });
setDeveloperModeEnabled(true);
assert.equal(observed, true);
recordDeveloperTraffic('http', { uploaded: 12, downloaded: 34 });
recordDeveloperTraffic('websocket', { uploaded: 8 });
recordDeveloperTraffic('websocket', { downloaded: 9 });
assert.deepEqual(getDeveloperTraffic(), {
  http: { requests: 1, uploaded: 12, downloaded: 34 },
  websocket: { sent: 1, received: 1, uploaded: 8, downloaded: 9 },
});
assert.equal(estimateBodyBytes('hello'), 5);
assert.equal(estimateBodyBytes(new URLSearchParams({ test: 'value' })), 10);
const form = new FormData();
form.append('name', 'glean');
assert.equal(estimateBodyBytes(form), 5);
setDeveloperModeEnabled(false);
assert.equal(observed, false);
recordDeveloperTraffic('http', { uploaded: 99, downloaded: 99 });
assert.equal(getDeveloperTraffic().http.requests, 1, 'traffic stops after disabling');
unsubscribe();

console.log('Developer Mode diagnostics smoke test passed.');
