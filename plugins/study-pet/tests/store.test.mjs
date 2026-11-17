import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHATTER_KEY,
  DEFAULT_SIZE,
  ENABLED_KEY,
  POSITION_KEY,
  SIZE_KEY,
  SIZES,
  createPetStore,
  normalizeSize,
  parsePosition,
} from '../client/store.js';

/** @param {object} [initial] @returns {{ getItem: Function, setItem: Function, removeItem: Function, values: Map }} Fake storage. */
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
  };
}

describe('pet store', () => {
  it('defaults to visible, chatter on, regular size, no stored position', () => {
    const store = createPetStore({ storage: { local: fakeStorage() } });
    assert.deepEqual(store.snapshot, { enabled: true, chatter: true, size: DEFAULT_SIZE, position: null });
    assert.deepEqual(SIZES, ['0.85', '1', '1.2']);
  });

  it('reads stored preferences including a dragged position', () => {
    const local = fakeStorage({
      [ENABLED_KEY]: '0',
      [CHATTER_KEY]: '0',
      [SIZE_KEY]: '1.2',
      [POSITION_KEY]: JSON.stringify({ left: 640, top: 320 }),
    });
    const store = createPetStore({ storage: { local } });
    assert.deepEqual(store.snapshot, {
      enabled: false,
      chatter: false,
      size: '1.2',
      position: { left: 640, top: 320 },
    });
  });

  it('writes preferences and publishes one immutable snapshot per change', () => {
    const local = fakeStorage();
    const store = createPetStore({ storage: { local } });
    const seen = [];
    const off = store.source.subscribe(() => { seen.push(store.source.getSnapshot()); });

    store.setEnabled(false);
    store.setChatter(false);
    store.setSize('0.85');
    store.setPosition({ left: 100.4, top: 200.6 });
    assert.equal(seen.length, 4);
    assert.equal(Object.isFrozen(seen[3]), true);
    assert.deepEqual(seen[3], {
      enabled: false,
      chatter: false,
      size: '0.85',
      position: { left: 100, top: 201 },
    });
    assert.equal(local.getItem(ENABLED_KEY), '0');
    assert.equal(local.getItem(CHATTER_KEY), '0');
    assert.equal(local.getItem(SIZE_KEY), '0.85');
    assert.equal(local.getItem(POSITION_KEY), '{"left":100,"top":201}');
    assert.equal(store.source.getSnapshot(), store.snapshot);

    const again = seen.length;
    store.setEnabled(false);
    store.setSize('0.85');
    store.setPosition({ left: 100, top: 201 });
    assert.equal(seen.length, again, 'same-value writes publish nothing');
    off();
    store.setEnabled(true);
    assert.equal(seen.length, again);
  });

  it('clears a stored position', () => {
    const local = fakeStorage({ [POSITION_KEY]: JSON.stringify({ left: 10, top: 20 }) });
    const store = createPetStore({ storage: { local } });
    store.clearPosition();
    assert.equal(store.snapshot.position, null);
    assert.equal(local.getItem(POSITION_KEY), null);
  });

  it('degrades corrupt values to defaults instead of throwing', () => {
    const local = fakeStorage({
      [ENABLED_KEY]: 'garbage',
      [CHATTER_KEY]: 'garbage',
      [SIZE_KEY]: '3.5',
      [POSITION_KEY]: '{"left":"nope"}',
    });
    const store = createPetStore({ storage: { local } });
    assert.deepEqual(store.snapshot, { enabled: true, chatter: true, size: '1', position: null });
    assert.equal(normalizeSize('1.2'), '1.2');
    assert.equal(normalizeSize(undefined), DEFAULT_SIZE);
    assert.equal(parsePosition('not json'), null);
    assert.equal(parsePosition('[]'), null);
    assert.equal(parsePosition(JSON.stringify({ left: 1 })), null);
    assert.deepEqual(parsePosition(JSON.stringify({ left: 1, top: 2 })), { left: 1, top: 2 });
  });

  it('falls back to memory when storage access throws or writes are blocked', () => {
    const store = createPetStore({
      storage: {
        get local() {
          throw new Error('blocked');
        },
      },
    });
    assert.equal(store.snapshot.enabled, true);
    store.setEnabled(false);
    assert.equal(store.snapshot.enabled, false);

    const denied = fakeStorage();
    denied.setItem = () => {
      throw new Error('quota exceeded');
    };
    const warnings = [];
    const blocked = createPetStore({ storage: { local: denied }, warn: message => warnings.push(message) });
    blocked.setSize('1.2');
    assert.equal(blocked.snapshot.size, '1.2', 'the in-session preference still applies');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /was not stored/);
  });

  it('stops notifying after dispose', () => {
    const store = createPetStore({ storage: { local: fakeStorage() } });
    let notified = 0;
    store.source.subscribe(() => { notified += 1; });
    store.dispose();
    store.setEnabled(false);
    assert.equal(notified, 0);
  });
});
