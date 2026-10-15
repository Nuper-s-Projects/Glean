import assert from 'node:assert/strict';

const savedWindow = globalThis.window;
const savedDocument = globalThis.document;
const storage = new Map();
let storageUnavailable = false;
globalThis.window = { localStorage: {
  getItem(key) { if (storageUnavailable) throw new Error('blocked'); return storage.get(key) ?? null; },
  setItem(key, value) { if (storageUnavailable) throw new Error('blocked'); storage.set(key, value); },
} };
globalThis.document = { documentElement: { dataset: {} } };
let load = 0;
const freshPage = () => import(`../src/app/hardwareAcceleration.js?page=${++load}`);
try {
  let app = await freshPage();
  assert.equal(app.isHardwareAccelerationEnabled(), true, 'default on');
  app.applyHardwareAcceleration();
  assert.equal(document.documentElement.dataset.gleanGpuEffects, 'on');
  app.saveHardwareAccelerationPreference(false);
  assert.equal(app.hardwareAccelerationPreference(), false, 'next-start preference saved');
  assert.equal(app.isHardwareAccelerationEnabled(), true, 'no live renderer changes');
  app.applyHardwareAcceleration();
  assert.equal(document.documentElement.dataset.gleanGpuEffects, 'on', 'reapplying does not bypass refresh');
  app = await freshPage();
  app.applyHardwareAcceleration();
  assert.equal(document.documentElement.dataset.gleanGpuEffects, 'off', 'reload applies saved setting');
  app.saveHardwareAccelerationPreference(true);
  assert.equal(app.isHardwareAccelerationEnabled(), false);
  app = await freshPage();
  assert.equal(app.isHardwareAccelerationEnabled(), true, 'reload re-enables effects');
  assert.throws(() => app.saveHardwareAccelerationPreference('false'), TypeError);
  storage.set(app.HARDWARE_ACCELERATION_KEY, 'invalid');
  app = await freshPage();
  assert.equal(app.isHardwareAccelerationEnabled(), true, 'invalid preference defaults on');
  storageUnavailable = true;
  assert.throws(() => app.saveHardwareAccelerationPreference(false), /Could not save/);
  assert.equal(app.isHardwareAccelerationEnabled(), true, 'failed writes cannot change live renderer');
  app = await freshPage();
  assert.equal(app.isHardwareAccelerationEnabled(), true, 'blocked storage defaults on');
  delete globalThis.document;
  assert.doesNotThrow(() => app.applyHardwareAcceleration());
  console.log('PASS: default on, persistence, refresh-only application in both directions, invalid values, storage failures, non-browser safety.');
} finally {
  if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
}
