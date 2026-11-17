import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STYLE_ID, STYLE_TEXT, installStyleSheet } from '../client/style.js';

/** @returns {string} The reduced-motion media block. */
function reducedMotionBlock() {
  const start = STYLE_TEXT.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.notEqual(start, -1, 'the stylesheet carries a reduced-motion block');
  const end = STYLE_TEXT.indexOf('@media (prefers-contrast: more)', start);
  assert.notEqual(end, -1, 'the reduced-motion block precedes the contrast block');
  return STYLE_TEXT.slice(start, end);
}

/** @returns {{ doc: object, styles: object[] }} Fake document. */
function fakeDocument() {
  const styles = [];
  return {
    styles,
    doc: {
      head: { appendChild(element) { styles.push(element); } },
      createElement() {
        const attributes = {};
        return {
          id: '',
          textContent: '',
          removed: false,
          setAttribute(name, value) { attributes[name] = value; },
          getAttribute(name) { return attributes[name]; },
          remove() { this.removed = true; },
        };
      },
    },
  };
}

describe('pet stylesheet', () => {
  it('uses no !important overrides', () => {
    assert.ok(!STYLE_TEXT.includes('!important'), 'accessibility fallbacks win by specificity, not !important');
  });

  it('keeps the plush image fitted, mirrored by position, and minimally animated', () => {
    assert.match(STYLE_TEXT, /object-fit:\s*contain/);
    assert.match(STYLE_TEXT, /\[data-study-pet\]\[data-mirror='true'\]/);
    assert.match(STYLE_TEXT, /--sp-flip:\s*-1/);
    assert.match(STYLE_TEXT, /scaleX\(var\(--sp-flip\)\)/);
    assert.match(STYLE_TEXT, /sp-photo-breathe/);
    assert.match(STYLE_TEXT, /sp-photo-squash/);
    assert.match(STYLE_TEXT, /\[data-study-pet\]\[data-dragging='true'\]/);
    assert.equal(STYLE_TEXT.includes('sp-think-dots'), false, 'state-specific SVG poses are gone');
    assert.equal(STYLE_TEXT.includes('sp-sparkles'), false, 'state-specific SVG poses are gone');
  });

  it('stops the remaining motion under prefers-reduced-motion', () => {
    const block = reducedMotionBlock();
    for (const selector of [
      '[data-study-pet] .sp-photo',
      '[data-study-pet] .sp-photo-frame',
      "[data-study-pet][data-squash='true'] .sp-photo",
      "[data-study-pet][data-happy='true'] .sp-photo",
      '[data-study-pet] .sp-bubble',
      '[data-study-pet] .sp-panel',
    ]) {
      assert.ok(block.includes(selector), `reduced motion covers ${selector}`);
    }
    assert.match(block, /animation:\s*none/);
    assert.match(block, /transition:\s*none/);
    assert.match(block, /transform:\s*scaleX\(var\(--sp-flip\)\)/, 'the drag tilt is dropped with reduced motion');
  });

  it('installs one removable style element', () => {
    const { doc, styles } = fakeDocument();
    const dispose = installStyleSheet(doc);
    assert.equal(styles.length, 1);
    assert.equal(styles[0].id, STYLE_ID);
    assert.equal(styles[0].getAttribute('data-study-pet-styles'), 'stylesheet');
    assert.equal(styles[0].textContent, STYLE_TEXT);
    dispose();
    assert.equal(styles[0].removed, true);

    let called = false;
    const empty = { head: undefined, createElement() { called = true; } };
    const noop = installStyleSheet(empty);
    assert.equal(called, false);
    assert.equal(typeof noop, 'function');
    assert.equal(typeof installStyleSheet(undefined), 'function');
  });
});
