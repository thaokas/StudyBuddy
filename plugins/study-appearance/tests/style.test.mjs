import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STYLE_ID, STYLE_TEXT, installStyleSheet } from '../client/style.js';

/** @returns {{ doc: object, style: object }} Fake document and the created style element. */
function fakeDocument() {
  const style = {
    id: '',
    textContent: '',
    attributes: {},
    removed: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    remove() { this.removed = true; },
  };
  const doc = {
    documentElement: { dataset: {} },
    head: {
      children: [],
      appendChild(element) { this.children.push(element); },
    },
    createElement(tagName) {
      assert.equal(tagName, 'style');
      return style;
    },
  };
  return { doc, style };
}

/** @returns {object} Mutable store stub with the same source contract. */
function storeStub() {
  const snapshot = { enabled: true, lightPack: 'sprout-paper', darkPack: 'deep-sea' };
  const listeners = new Set();
  return {
    get snapshot() { return snapshot; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(patch) {
      Object.assign(snapshot, patch);
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('appearance stylesheet', () => {
  it('stays token-driven, additive, and accessibility-aware', () => {
    assert.ok(STYLE_TEXT.includes('var(--dsw-alias-bg-document-selection)'));
    assert.ok(STYLE_TEXT.includes('var(--dsw-alias-label-primary)'));
    assert.equal(STYLE_TEXT.includes('background-image'), false);
    assert.equal(STYLE_TEXT.includes('!important'), false);
    assert.ok(STYLE_TEXT.includes('prefers-reduced-transparency'));
    assert.ok(STYLE_TEXT.includes('prefers-reduced-motion'));
    assert.ok(STYLE_TEXT.includes('prefers-contrast'));
    assert.ok(STYLE_TEXT.includes('forced-colors'));
    assert.match(STYLE_TEXT, /data-study-appearance='on'/);
    // No global body selector and no DSH hashed class names: only stable DOM marks.
    assert.equal(STYLE_TEXT.includes('body'), false);
    // The conversation header is matched by its own published leading mark, so
    // entry-page drag headers (the Plugins page, onboarding) keep their surface.
    assert.match(STYLE_TEXT, /:root\[data-study-appearance='on'\] header\[data-window-drag\]:has\(\[data-conversation-header-leading\]\)/);
    assert.equal(STYLE_TEXT.includes('header[data-window-drag],'), false, 'the bare drag-header selector would paint unrelated entry pages');
    assert.match(STYLE_TEXT, /:root\[data-study-appearance='on'\] \[data-dockkit-strip\]/);
    assert.match(STYLE_TEXT, /background:\s*var\(--study-topbar\)/);
  });

  it('fades the top bar only while the layer is on and follows reduced motion', () => {
    assert.match(STYLE_TEXT, /transition:\s*background-color\s+\d+ms/);
    const reduced = STYLE_TEXT.slice(STYLE_TEXT.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.ok(reduced.indexOf('header[data-window-drag]') >= 0);
    assert.ok(reduced.indexOf('[data-dockkit-strip]') >= 0);
    assert.ok(reduced.indexOf('transition: none') >= 0);
  });

  it('installs one marked style element and mirrors the root state', () => {
    const { doc, style } = fakeDocument();
    const store = storeStub();
    const dispose = installStyleSheet(doc, store);

    assert.deepEqual(doc.head.children, [style]);
    assert.equal(style.id, STYLE_ID);
    assert.equal(style.textContent, STYLE_TEXT);
    assert.equal(style.attributes['data-study-appearance'], 'stylesheet');
    assert.equal(doc.documentElement.dataset.studyAppearance, 'on');
    assert.equal(doc.documentElement.dataset.studyLightPack, 'sprout-paper');
    assert.equal(doc.documentElement.dataset.studyDarkPack, 'deep-sea');

    store.set({ enabled: false, lightPack: 'mint-mist', darkPack: 'starry-blue' });
    assert.equal(doc.documentElement.dataset.studyAppearance, 'off');
    assert.equal(doc.documentElement.dataset.studyLightPack, 'mint-mist');
    assert.equal(doc.documentElement.dataset.studyDarkPack, 'starry-blue');

    dispose();
    assert.equal(style.removed, true);
    assert.equal('studyAppearance' in doc.documentElement.dataset, false);
    assert.equal('studyLightPack' in doc.documentElement.dataset, false);
    assert.equal('studyDarkPack' in doc.documentElement.dataset, false);
  });

  it('is a no-op without a document', () => {
    const dispose = installStyleSheet(undefined, storeStub());
    assert.equal(typeof dispose, 'function');
    assert.doesNotThrow(() => dispose());
  });
});
