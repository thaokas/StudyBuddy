import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PET_ID,
  PET_SLOT,
  SETTINGS_ID,
  SETTINGS_ORDER,
  SETTINGS_SLOT,
  TIMER_POLL_MS,
  createPlugin,
} from '../client/apply.js';
import { DICTIONARY, NS } from '../client/dictionary.js';
import { CHATTER_KEY, ENABLED_KEY, SIZE_KEY } from '../client/store.js';

/** @returns {{ getItem: Function, setItem: Function, removeItem: Function, values: Map }} Fake storage. */
function fakeStorage() {
  const values = new Map();
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
  };
}

/** @returns {{ doc: object, styles: object[] }} Fake document target. */
function fakeDocument() {
  const styles = [];
  return {
    styles,
    doc: {
      head: { appendChild(element) { styles.push(element); } },
      createElement() {
        return { id: '', textContent: '', setAttribute() {}, remove() {} };
      },
    },
  };
}

/**
 * Context stub recording the pet contributions.
 * @param {{ studyClient?: object }} [options] - Optional service stubs.
 * @returns {object} Stub context plus captures.
 */
function fakeContext(options = {}) {
  const effects = [];
  const slots = [];
  const locale = [];
  const services = new Map();
  if (Object.hasOwn(options, 'studyClient')) services.set('studyClient', options.studyClient);
  const ctx = {
    services,
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    get(name) {
      return services.get(name);
    },
    locale: {
      register(namespace, dictionary) {
        locale.push({ namespace, dictionary });
        return () => {};
      },
      getSnapshot: () => ({ active: 'zh', revision: 0 }),
      subscribe: () => () => {},
    },
    slots: {
      inject(name, install) {
        return install();
      },
      register(registration, component) {
        const record = { options: registration, component, disposed: false };
        slots.push(record);
        return () => { record.disposed = true; };
      },
    },
  };
  return { ctx, effects, slots, locale };
}

const COMPONENTS = {
  PetOverlay: () => null,
  PetSettings: () => null,
};

/**
 * Apply the plugin into a stub context.
 * @param {{ storage?: object, studyClient?: object }} [options] - Edges.
 * @returns {object} Capture.
 */
function mount(options = {}) {
  const local = fakeStorage();
  const { doc, styles } = fakeDocument();
  const capture = fakeContext(options);
  const plugin = createPlugin({
    ...COMPONENTS,
    documentTarget: doc,
    storeOptions: { storage: { local } },
  });
  plugin.apply(capture.ctx);
  return { ...capture, local, styles, plugin };
}

describe('pet plugin assembly', () => {
  it('registers one locale namespace, one stylesheet, the overlay pet and the settings row', () => {
    const mounted = mount();
    assert.deepEqual(mounted.plugin.inject, ['slots', 'locale']);
    assert.equal(mounted.locale.length, 1);
    assert.equal(mounted.locale[0].namespace, NS);
    assert.equal(mounted.locale[0].dictionary.en['pet.setting.label'], 'StudyBuddy buddy');
    assert.equal(mounted.locale[0].dictionary.zh['pet.setting.label'], '小搭宠物');
    assert.deepEqual(Object.keys(DICTIONARY.en).sort(), Object.keys(DICTIONARY.zh).sort());
    assert.equal(mounted.styles.length, 1);

    assert.deepEqual(mounted.slots.map(entry => entry.options.name), [PET_SLOT, SETTINGS_SLOT]);
    const pet = mounted.slots[0];
    assert.equal(pet.options.id, PET_ID);
    assert.equal(pet.options.locale, NS);
    const settings = mounted.slots[1];
    assert.equal(settings.options.id, SETTINGS_ID);
    assert.equal(settings.options.order, SETTINGS_ORDER);
    assert.equal(settings.options.order, 36);
    assert.equal(settings.options.locale, NS);
  });

  it('shares one store between the pet and the settings row', () => {
    const mounted = mount();
    const petFace = mounted.slots[0].options.inject();
    const settingsFace = mounted.slots[1].options.inject();
    assert.equal(typeof petFace.hooks.pet.getSnapshot, 'function');
    assert.equal(petFace.hooks.locale, mounted.ctx.locale);
    assert.equal(petFace.actions.setEnabled, settingsFace.setEnabled);

    assert.equal(petFace.hooks.pet.getSnapshot().enabled, true);
    settingsFace.setEnabled(false);
    assert.equal(petFace.hooks.pet.getSnapshot().enabled, false);
    settingsFace.setSize('1.2');
    assert.equal(petFace.hooks.pet.getSnapshot().size, '1.2');
    settingsFace.setChatter(false);
    assert.equal(petFace.hooks.pet.getSnapshot().chatter, false);
    assert.equal(mounted.local.getItem(ENABLED_KEY), '0');
    assert.equal(mounted.local.getItem(SIZE_KEY), '1.2');
    assert.equal(mounted.local.getItem(CHATTER_KEY), '0');
  });

  it('reads a voice pack through the shared storage edge', () => {
    const mounted = mount();
    const face = mounted.slots[0].options.inject();
    assert.equal(face.readVoice(), null);
    mounted.local.setItem('study-pet:voice', JSON.stringify({ click: ['自定义'] }));
    const pack = face.readVoice();
    assert.deepEqual(pack.click, ['自定义']);
  });

  it('degrades the optional timer poll silently when studyClient is absent or fails', async () => {
    assert.equal(TIMER_POLL_MS >= 15_000, true);
    const absent = mount().slots[0].options.inject();
    assert.equal(await absent.pollTimer(), null);

    const calls = [];
    const working = mount({
      studyClient: {
        async call(namespace, method) {
          calls.push([namespace, method]);
          return { ok: true, value: { session: { id: 'timer_1' }, lastFinished: null } };
        },
      },
    }).slots[0].options.inject();
    assert.deepEqual(await working.pollTimer(), { session: { id: 'timer_1' }, lastFinished: null });
    assert.deepEqual(calls, [['timer', 'status']]);

    const failing = mount({
      studyClient: {
        async call() {
          throw Object.assign(new Error('missing'), { code: 'network' });
        },
      },
    }).slots[0].options.inject();
    assert.equal(await failing.pollTimer(), null);

    const malformed = mount({
      studyClient: { async call() { return { ok: true, value: 'nope' }; } },
    }).slots[0].options.inject();
    assert.equal(await malformed.pollTimer(), null);
  });

  it('unwinds its store and stylesheet on dispose', async () => {
    const mounted = mount();
    const face = mounted.slots[0].options.inject();
    let notified = 0;
    face.hooks.pet.subscribe(() => { notified += 1; });
    for (const effect of mounted.effects) await effect.dispose?.();
    mounted.local.setItem('x', 'y');
    face.actions.setEnabled(false);
    assert.equal(notified, 0);
  });
});
