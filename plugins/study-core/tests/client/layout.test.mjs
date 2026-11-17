/**
 * Study layout preferences: the last main-panel page and the Web Storage
 * fallback. The install path runs on plain objects under the React stub, so no
 * browser or renderer is involved.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createStorageArea, removeValue, writeValue } from '../../client/lib/storage.js';
import {
  PAGE_KEY,
  installStudyPageRestore,
  readLastPage,
  rememberLastPage,
  restoreLastStudyPage,
} from '../../client/lib/study-page.js';

/** A Web Storage stand-in backed by a Map. */
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
  };
}

/** A `ctx.layout` face with a driven panel source. */
function fakeLayout() {
  const listeners = new Set();
  let snapshot = { activePanelId: null };
  return {
    selected: [],
    panelInfo: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      emit(info) { snapshot = info; for (const listener of [...listeners]) listener(); },
    },
    selectPanel(id) { this.selected.push(id); },
  };
}

/**
 * A client context whose in-place injection runs immediately.
 * @param {{ layout?: object, mainEntries?: object[] }} options - Service stand-ins.
 * @returns {object} Bench with the fake context and its ledgers.
 */
function fakeContext({ layout = fakeLayout(), mainEntries = [] } = {}) {
  const slots = {
    mainEntries: [...mainEntries],
    effects: [],
    mainListener: undefined,
    entries(key) { return key === 'main' ? this.mainEntries : []; },
    subscribe(key, listener) { this.mainListener = listener; return () => { this.mainListener = undefined; }; },
  };
  const ctx = {
    injected: [],
    slots,
    inject(dependencies, callback) {
      ctx.injected.push(dependencies);
      callback({
        layout,
        slots,
        effect(run) { const dispose = run(); slots.effects.push(dispose); return dispose; },
      });
    },
    effect(run) { return run(); },
  };
  return { ctx, layout, slots };
}

const installs = [];
afterEach(() => {
  for (const restore of installs.splice(0).reverse()) restore();
});

/**
 * Expose one storage area as the window's `localStorage`.
 * @param {object} storage - Storage stand-in.
 */
function stubLocalStorage(storage) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  installs.push(() => {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', descriptor);
  });
}

describe('storage fallback', () => {
  it('falls back to an in-memory area when the window blocks storage', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked'); },
    });
    installs.push(() => {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', descriptor);
    });
    const storage = createStorageArea();
    assert.equal(writeValue(storage, 'study.test', '1'), true);
    assert.equal(storage.getItem('study.test'), '1');
    assert.equal(removeValue(storage, 'study.test'), true);
    assert.equal(storage.getItem('study.test'), null);
  });
});

describe('last page', () => {
  it('records this plugin’s pages and clears them for other panels', () => {
    const storage = fakeStorage();
    const layout = fakeLayout();
    const unsubscribe = rememberLastPage(layout, ['today', 'workbench'], storage);
    layout.panelInfo.emit({ activePanelId: 'plugins' });
    assert.equal(readLastPage(storage), null);
    layout.panelInfo.emit({ activePanelId: 'workbench' });
    assert.equal(readLastPage(storage), 'workbench');
    layout.panelInfo.emit({ activePanelId: null });
    assert.equal(readLastPage(storage), null);
    layout.panelInfo.emit({ activePanelId: 'today' });
    assert.equal(readLastPage(storage), 'today');
    unsubscribe();
    layout.panelInfo.emit({ activePanelId: 'workbench' });
    assert.equal(readLastPage(storage), 'today');
  });

  it('restores the saved page once its entry registers, and only once', () => {
    const storage = fakeStorage({ [PAGE_KEY]: 'workbench' });
    const { ctx, layout, slots } = fakeContext();
    const dispose = restoreLastStudyPage(ctx, layout, ['today', 'workbench'], storage);
    assert.deepEqual(layout.selected, []);
    slots.mainEntries.push({ options: { key: 'workbench' } });
    slots.mainListener();
    assert.deepEqual(layout.selected, ['workbench']);
    slots.mainListener();
    assert.deepEqual(layout.selected, ['workbench']);
    dispose();
    assert.equal(slots.mainListener, undefined);
  });

  it('leaves the Conversation selected when the saved page is unknown', () => {
    const storage = fakeStorage({ [PAGE_KEY]: 'uninstalled' });
    const { ctx, layout, slots } = fakeContext();
    restoreLastStudyPage(ctx, layout, ['today', 'workbench'], storage);
    assert.equal(slots.mainListener, undefined);
    assert.deepEqual(layout.selected, []);
  });

  it('retries after a rejected selection instead of crashing the boot', () => {
    const storage = fakeStorage({ [PAGE_KEY]: 'today' });
    const layout = fakeLayout();
    let failures = 0;
    layout.selectPanel = (id) => {
      if (failures === 0) { failures += 1; throw new Error('not ready'); }
      layout.selected.push(id);
    };
    const { ctx, slots } = fakeContext({ layout });
    restoreLastStudyPage(ctx, layout, ['today'], storage);
    slots.mainEntries.push({ options: { key: 'today' } });
    slots.mainListener();
    assert.deepEqual(layout.selected, []);
    slots.mainListener();
    assert.deepEqual(layout.selected, ['today']);
  });
});

describe('installStudyPageRestore', () => {
  it('installs the remember and restore effects on the layout service', () => {
    const storage = fakeStorage({ [PAGE_KEY]: 'workbench' });
    stubLocalStorage(storage);
    const { ctx, layout, slots } = fakeContext();
    installStudyPageRestore(ctx, { pageKeys: ['today', 'workbench'] });
    assert.deepEqual(ctx.injected, [['layout']]);
    assert.equal(slots.effects.length, 2);
    slots.mainEntries.push({ options: { key: 'workbench' } });
    slots.mainListener();
    assert.deepEqual(layout.selected, ['workbench']);
    layout.panelInfo.emit({ activePanelId: 'today' });
    assert.equal(storage.values.get(PAGE_KEY), 'today');
    for (const dispose of slots.effects) dispose();
    assert.equal(slots.mainListener, undefined);
  });

  it('stays off on a client context without in-place injection', () => {
    assert.equal(installStudyPageRestore({ effect: () => {} }, { pageKeys: ['today'] }), undefined);
  });
});
