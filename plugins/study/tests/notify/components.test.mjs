/**
 * In-app surfaces of the reminder: the overlay banner and the General settings
 * row. Both are pure functions of the props the render machinery supplies, so
 * the tests call them with a snapshot hook and assert the element tree.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';
import { DICTIONARY, translator } from './support.mjs';

installReactStub();

const { CompletionBanner, NotifyToggle } = await import('../../client/notify.js');

const t = translator('zh');
const tEn = translator('en');

/**
 * Collect element nodes from a rendered tree.
 * @param {unknown} tree - Element tree from a component.
 * @returns {Array<{ type: unknown, props: object, children: unknown[] }>} Element nodes.
 */
function elements(tree) {
  const found = [];
  const visit = (node) => {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== 'object') return;
    found.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return found;
}

/**
 * Concatenate the text a tree renders.
 * @param {unknown} tree - Element tree from a component.
 * @returns {string} All string children joined by spaces.
 */
function text(tree) {
  const parts = [];
  const visit = (node) => {
    if (node === null || node === undefined || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
      return;
    }
    if (typeof node !== 'object') return;
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return parts.join(' ');
}

/**
 * Find the first button whose label contains `fragment`.
 * @param {unknown} tree - Element tree.
 * @param {string} fragment - Expected label fragment.
 * @returns {object} The button element.
 */
function button(tree, fragment) {
  const found = elements(tree).find(node => node.type === 'button' && text(node).includes(fragment));
  assert.ok(found !== undefined, `缺少按钮：${fragment}；实际文案：${text(tree)}`);
  return found;
}

/**
 * Banner snapshot with the fields the component reads.
 * @param {object} [overrides] - Field overrides.
 * @returns {object} Snapshot.
 */
function bannerState(overrides = {}) {
  return {
    enabled: true,
    osStatus: 'denied',
    focusable: true,
    at: 10,
    seq: 1,
    entries: [{ sessionId: 's1', title: 'Algebra', completedAt: 10 }],
    ...overrides,
  };
}

/**
 * Render the banner with recorded callbacks.
 * The hook is the framework's selector form: `use<Name>(selector)`.
 * @param {object} state - Snapshot the hook selects from.
 * @param {object} [calls] - Recording arrays for the injected callbacks.
 * @returns {unknown} Element tree.
 */
function renderBanner(state, calls = {}) {
  const record = {
    focused: calls.focused ?? [],
    dismissed: calls.dismissed ?? [],
    disabled: calls.disabled ?? [],
  };
  const tree = CompletionBanner({
    t,
    useCompletion: selector => {
      assert.equal(typeof selector, 'function', 'hooks 隔间提供的是选择器 Hook，必须传入 selector');
      return selector(state);
    },
    focus: (sessionId) => { record.focused.push(sessionId); },
    dismiss: () => { record.dismissed.push(true); },
    setEnabled: (value) => { record.disabled.push(value); },
  });
  return { tree, record };
}

describe('completion banner', () => {
  it('renders nothing while there is no completion or reminders are off', () => {
    assert.equal(renderBanner(bannerState({ entries: [] })).tree, null);
    assert.equal(renderBanner(bannerState({ enabled: false })).tree, null);
  });

  it('names the finished session and keeps the in-app fallback note', () => {
    const { tree } = renderBanner(bannerState());
    assert.match(text(tree), /Algebra/);
    assert.equal(button(tree, DICTIONARY.zh['notify.banner.dismiss']).type, 'button');
    assert.ok(text(tree).includes(DICTIONARY.zh['notify.banner.fallback']), '无系统通知时必须说明降级');
  });

  it('drops the fallback note once system notifications work', () => {
    const { tree } = renderBanner(bannerState({ osStatus: 'granted' }));
    assert.ok(!text(tree).includes(DICTIONARY.zh['notify.banner.fallback']));
  });

  it('lists every merged session and opens the one the student picks', () => {
    const state = bannerState({
      entries: [
        { sessionId: 's1', title: 'Algebra', completedAt: 10 },
        { sessionId: 's2', title: 'Physics', completedAt: 11 },
        { sessionId: 's3', title: 'History', completedAt: 12 },
      ],
    });
    const { tree, record } = renderBanner(state);
    assert.ok(text(tree).includes('3'));
    button(tree, 'Physics').props.onClick();
    assert.deepEqual(record.focused, ['s2']);
  });

  it('opens the newest merged session from the primary action', () => {
    const state = bannerState({
      entries: [
        { sessionId: 's1', title: 'Algebra', completedAt: 10 },
        { sessionId: 's2', title: 'Physics', completedAt: 11 },
      ],
    });
    const { tree, record } = renderBanner(state);
    button(tree, DICTIONARY.zh['notify.banner.open']).props.onClick();
    assert.deepEqual(record.focused, ['s2']);
  });

  it('hides the open action when no session can be opened', () => {
    const { tree } = renderBanner(bannerState({ focusable: false }));
    const labels = elements(tree).filter(node => node.type === 'button').map(node => text(node));
    assert.ok(!labels.includes(DICTIONARY.zh['notify.banner.open']), `不应提供无法工作的入口：${labels.join('、')}`);
  });

  it('dismisses and can switch the reminders off', () => {
    const { tree, record } = renderBanner(bannerState());
    button(tree, DICTIONARY.zh['notify.banner.dismiss']).props.onClick();
    button(tree, DICTIONARY.zh['notify.banner.disable']).props.onClick();
    assert.deepEqual(record.dismissed, [true]);
    assert.deepEqual(record.disabled, [false]);
  });

  it('renders the English copy through the same keys', () => {
    const tree = CompletionBanner({
      t: tEn,
      useCompletion: selector => selector(bannerState({ osStatus: 'unsupported' })),
      focus: () => {},
      dismiss: () => {},
      setEnabled: () => {},
    });
    assert.match(text(tree), /Algebra finished replying/);
    assert.ok(text(tree).includes(DICTIONARY.en['notify.banner.fallback']));
  });
});

describe('settings row', () => {
  /**
   * Render the settings row with a snapshot hook.
   * @param {object} state - Snapshot the hook selects from.
   * @param {object[]} toggles - Recording array for `setEnabled`.
   * @returns {unknown} Element tree.
   */
  function renderToggle(state, toggles = []) {
    return NotifyToggle({
      t,
      useCompletion: selector => selector(state),
      setEnabled: (value) => { toggles.push(value); },
    });
  }

  it('states the preference and its current value', () => {
    const tree = renderToggle(bannerState({ osStatus: 'granted' }));
    assert.ok(text(tree).includes(DICTIONARY.zh['notify.setting.label']));
    assert.ok(text(tree).includes(DICTIONARY.zh['notify.setting.description']));
    assert.equal(button(tree, DICTIONARY.zh['notify.setting.on']).props['aria-pressed'], 'true');
    assert.ok(text(tree).includes(DICTIONARY.zh['notify.setting.osReady']));
  });

  it('writes the opposite value when pressed', () => {
    const toggles = [];
    const on = renderToggle(bannerState({ osStatus: 'granted' }), toggles);
    button(on, DICTIONARY.zh['notify.setting.on']).props.onClick();
    assert.deepEqual(toggles, [false]);

    const off = renderToggle(bannerState({ enabled: false }), toggles);
    button(off, DICTIONARY.zh['notify.setting.off']).props.onClick();
    assert.deepEqual(toggles, [false, true]);
  });

  it('explains the in-app-only mode when the system notification is blocked', () => {
    const blocked = renderToggle(bannerState({ osStatus: 'denied' }));
    assert.ok(text(blocked).includes(DICTIONARY.zh['notify.setting.osBlocked']));
    const missing = renderToggle(bannerState({ osStatus: 'unsupported' }));
    assert.ok(text(missing).includes(DICTIONARY.zh['notify.setting.osUnavailable']));
  });
});

describe('copy', () => {
  it('ships the same non-empty keys in both locales', () => {
    const en = Object.keys(DICTIONARY.en).sort();
    const zh = Object.keys(DICTIONARY.zh).sort();
    assert.deepEqual(en, zh);
    assert.ok(en.length > 0);
    for (const key of en) {
      assert.ok(DICTIONARY.en[key].trim() !== '', `en 缺文案：${key}`);
      assert.ok(DICTIONARY.zh[key].trim() !== '', `zh 缺文案：${key}`);
    }
  });
});
