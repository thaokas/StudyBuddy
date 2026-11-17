import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPlugin, SETTINGS_ID, SETTINGS_ORDER, SETTINGS_SLOT } from '../client/apply.js';
import { NS } from '../client/dictionary.js';
import { SOURCE, TOKEN_NAMES } from '../client/theme.js';

/** @returns {{ doc: object, styles: object[] }} Fake document target. */
function fakeDocument() {
  const styles = [];
  return {
    styles,
    doc: {
      documentElement: { dataset: {} },
      head: { appendChild(element) { styles.push(element); } },
      createElement() {
        return { id: '', textContent: '', removed: false, setAttribute() {}, remove() { this.removed = true; } };
      },
    },
  };
}

/**
 * Context stub recording the appearance contributions.
 * @param {object} doc - Document target.
 * @returns {object} Stub context plus captures.
 */
function fakeContext(doc) {
  const effects = [];
  const overrides = [];
  const slots = [];
  const locale = [];
  let settingsRegistration;
  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    locale: {
      register(namespace, dictionary) {
        locale.push({ namespace, dictionary });
        return () => {};
      },
    },
    theme: {
      overrideTokens(source, tokens) {
        const record = { source, tokens, disposed: false };
        overrides.push(record);
        return () => { record.disposed = true; };
      },
    },
    slots: {
      inject(name, install) {
        return install();
      },
      register(options, component) {
        const registration = { options, component, disposed: false };
        slots.push(registration);
        if (options.name === SETTINGS_SLOT) settingsRegistration = registration;
        return () => { registration.disposed = true; };
      },
    },
  };
  return { ctx, effects, overrides, slots, locale, document: doc, settings: () => settingsRegistration };
}

const COMPONENTS = {
  BrandMark: () => null,
  BrandName: () => null,
  HeroBrandMark: () => null,
  AppearanceSettings: () => null,
};

describe('appearance plugin assembly', () => {
  it('registers one locale namespace, one token layer, one stylesheet and four slots', () => {
    const { doc, styles } = fakeDocument();
    const capture = fakeContext(doc);
    const plugin = createPlugin({ ...COMPONENTS, documentTarget: doc, storeOptions: { storage: { local: new MapStore() } } });
    assert.deepEqual(plugin.inject, ['slots', 'theme', 'locale']);
    plugin.apply(capture.ctx);

    assert.equal(capture.locale.length, 1);
    assert.equal(capture.locale[0].namespace, NS);
    assert.equal(capture.locale[0].dictionary.en['appearance.setting.label'], 'StudyBuddy appearance');
    assert.equal(capture.locale[0].dictionary.zh['appearance.setting.label'], 'StudyBuddy 外观');
    assert.equal(capture.locale[0].dictionary.en['appearance.light.label'], 'Light palette');
    assert.equal(capture.locale[0].dictionary.zh['appearance.dark.label'], '深色组');
    for (const pack of ['sprout-paper', 'mint-mist', 'celadon-page', 'deep-sea', 'midnight-indigo', 'starry-blue']) {
      assert.equal(typeof capture.locale[0].dictionary.en[`appearance.pack.${pack}`], 'string');
      assert.equal(typeof capture.locale[0].dictionary.zh[`appearance.pack.${pack}`], 'string');
    }

    assert.equal(capture.overrides.length, 1);
    assert.equal(capture.overrides[0].source, SOURCE);
    assert.equal(Object.keys(capture.overrides[0].tokens).length, TOKEN_NAMES.length);
    for (const pair of Object.values(capture.overrides[0].tokens)) {
      assert.equal(typeof pair.light, 'string');
      assert.equal(typeof pair.dark, 'string');
    }

    assert.equal(styles.length, 1);
    assert.deepEqual(capture.slots.map(entry => entry.options.name), [
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      SETTINGS_SLOT,
    ]);
    const settings = capture.settings();
    assert.ok(settings !== undefined);
    assert.equal(settings.options.id, SETTINGS_ID);
    assert.equal(settings.options.order, SETTINGS_ORDER);
    assert.equal(settings.options.locale, NS);
  });

  it('restacks the token layer and root state when the settings row changes', () => {
    const { doc } = fakeDocument();
    const capture = fakeContext(doc);
    const plugin = createPlugin({ ...COMPONENTS, documentTarget: doc, storeOptions: { storage: { local: new MapStore() } } });
    plugin.apply(capture.ctx);

    const settings = capture.settings();
    const injected = settings.options.inject();
    assert.equal(typeof injected.hooks.appearance.getSnapshot, 'function');
    assert.equal(injected.hooks.appearance.getSnapshot().enabled, true);
    assert.equal(typeof injected.setLightPack, 'function');
    assert.equal(typeof injected.setDarkPack, 'function');

    injected.setLightPack('mint-mist');
    assert.equal(capture.overrides.length, 2);
    assert.equal(capture.overrides[1].tokens['--dsw-alias-bg-base'].light, '#EDF5E7');
    assert.equal(capture.overrides[1].tokens['--dsw-alias-bg-base'].dark, '#0F1A2A');
    assert.equal(doc.documentElement.dataset.studyLightPack, 'mint-mist');

    injected.setDarkPack('starry-blue');
    assert.equal(capture.overrides.length, 3);
    assert.equal(capture.overrides[2].tokens['--dsw-alias-bg-base'].dark, '#0D1728');
    assert.equal(capture.overrides[2].tokens['--study-topbar'].dark, '#1A2E4F');
    assert.equal(doc.documentElement.dataset.studyDarkPack, 'starry-blue');
    assert.equal(capture.overrides[1].disposed, true);

    injected.setEnabled(false);
    assert.equal(capture.overrides.length, 4);
    assert.deepEqual(capture.overrides[3].tokens, {});
    assert.equal(capture.overrides[2].disposed, true);
    assert.equal(doc.documentElement.dataset.studyAppearance, 'off');
  });

  it('unwinds every contribution when the plugin owner disposes', () => {
    const { doc, styles } = fakeDocument();
    const capture = fakeContext(doc);
    const plugin = createPlugin({ ...COMPONENTS, documentTarget: doc, storeOptions: { storage: { local: new MapStore() } } });
    plugin.apply(capture.ctx);
    for (const effect of capture.effects) effect.dispose?.();
    assert.equal(capture.overrides[0].disposed, true);
    assert.equal(styles[0].removed, true);
    assert.equal('studyAppearance' in doc.documentElement.dataset, false);
    assert.equal('studyLightPack' in doc.documentElement.dataset, false);
    assert.equal('studyDarkPack' in doc.documentElement.dataset, false);
  });
});

/** Minimal key/value storage used by the assembly tests. */
class MapStore {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
