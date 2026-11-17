import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DARK_PACK_KEY,
  ENABLED_KEY,
  LEGACY_ACCENT_KEY,
  LIGHT_PACK_KEY,
  createAppearanceStore,
} from '../client/appearance-store.js';

/** @returns {{ getItem: Function, setItem: Function, removeItem: Function, values: Map }} Fake storage area. */
function fakeStorage() {
  const values = new Map();
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe('appearance store', () => {
  it('defaults to enabled with the sprout-paper light pack and deep-sea dark pack', () => {
    const store = createAppearanceStore({ storage: { local: fakeStorage() } });
    assert.deepEqual(store.snapshot, { enabled: true, lightPack: 'sprout-paper', darkPack: 'deep-sea' });
  });

  it('reads and writes the toggle and both palette packs', () => {
    const local = fakeStorage();
    local.setItem(ENABLED_KEY, '0');
    local.setItem(LIGHT_PACK_KEY, 'mint-mist');
    local.setItem(DARK_PACK_KEY, 'starry-blue');
    const store = createAppearanceStore({ storage: { local } });
    assert.deepEqual(store.snapshot, { enabled: false, lightPack: 'mint-mist', darkPack: 'starry-blue' });

    store.setEnabled(true);
    store.setLightPack('celadon-page');
    store.setDarkPack('midnight-indigo');
    assert.deepEqual(store.snapshot, { enabled: true, lightPack: 'celadon-page', darkPack: 'midnight-indigo' });
    assert.equal(local.getItem(ENABLED_KEY), '1');
    assert.equal(local.getItem(LIGHT_PACK_KEY), 'celadon-page');
    assert.equal(local.getItem(DARK_PACK_KEY), 'midnight-indigo');
    assert.equal(store.source.getSnapshot(), store.snapshot);
  });

  it('ignores the retired accent key instead of crashing or migrating it', () => {
    const local = fakeStorage();
    local.setItem(LEGACY_ACCENT_KEY, 'pear');
    const store = createAppearanceStore({ storage: { local } });
    assert.deepEqual(store.snapshot, { enabled: true, lightPack: 'sprout-paper', darkPack: 'deep-sea' });
    assert.equal(local.getItem(LEGACY_ACCENT_KEY), 'pear', 'the retired value is left untouched');

    store.setLightPack('mint-mist');
    store.setDarkPack('starry-blue');
    assert.equal(local.getItem(LEGACY_ACCENT_KEY), 'pear');
    assert.equal(local.getItem(LIGHT_PACK_KEY), 'mint-mist');
    assert.equal(local.getItem(DARK_PACK_KEY), 'starry-blue');
  });

  it('normalizes unknown or wrong-family stored packs to the defaults', () => {
    const local = fakeStorage();
    local.setItem(LIGHT_PACK_KEY, 'deep-sea');
    local.setItem(DARK_PACK_KEY, 'mint-mist');
    const store = createAppearanceStore({ storage: { local } });
    assert.equal(store.snapshot.lightPack, 'sprout-paper');
    assert.equal(store.snapshot.darkPack, 'deep-sea');

    store.setLightPack('unknown');
    store.setDarkPack('unknown');
    assert.equal(store.snapshot.lightPack, 'sprout-paper');
    assert.equal(store.snapshot.darkPack, 'deep-sea');
  });

  it('publishes immutable snapshots and notifies subscribers until disposed', () => {
    const store = createAppearanceStore({ storage: { local: fakeStorage() } });
    const seen = [];
    const off = store.source.subscribe(() => { seen.push(store.source.getSnapshot()); });
    store.setEnabled(false);
    assert.equal(seen.length, 1);
    assert.equal(Object.isFrozen(seen[0]), true);
    assert.equal(seen[0].enabled, false);

    store.setLightPack('mint-mist');
    store.setDarkPack('starry-blue');
    assert.equal(seen.length, 3);
    assert.equal(seen[2].lightPack, 'mint-mist');
    assert.equal(seen[2].darkPack, 'starry-blue');
    off();
    store.setEnabled(true);
    assert.equal(seen.length, 3);

    store.dispose();
    store.setLightPack('sprout-paper');
    assert.equal(seen.length, 3);
  });

  it('ignores no-op writes', () => {
    const store = createAppearanceStore({ storage: { local: fakeStorage() } });
    let notified = 0;
    const off = store.source.subscribe(() => { notified += 1; });
    store.setEnabled(true);
    store.setLightPack('sprout-paper');
    store.setDarkPack('deep-sea');
    assert.equal(notified, 0);
    off();
  });

  it('degrades to memory when storage access throws', () => {
    const store = createAppearanceStore({
      storage: {
        get local() { throw new Error('blocked'); },
      },
    });
    assert.equal(store.snapshot.enabled, true);
    store.setEnabled(false);
    store.setLightPack('mint-mist');
    assert.equal(store.snapshot.enabled, false);
    assert.equal(store.snapshot.lightPack, 'mint-mist');
  });
});
