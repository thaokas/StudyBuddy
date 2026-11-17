/**
 * The memory page: definition shape, the memory list, and the teaching-profile
 * tab in both locales. Requests are not issued here; the page body owns them
 * while MemoryView / ProfileView render from plain props.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../../../study-outcomes/tests/client/support/react-stub.mjs';

installReactStub();

const { default: page, MemoryView, ProfileView } = await import('../../client/pages/memory.js');
const { mergeMessages } = await import('../../../../packages/study-client/definitions.js');
const common = (await import('../../../../packages/study-messages/common.js')).default;
const memory = (await import('../../client/messages/memory.js')).default;

const dictionary = mergeMessages([
  { file: 'common', dictionary: common },
  { file: 'memory', dictionary: memory },
]);

function translator(locale) {
  return (key, params) => {
    const template = dictionary[locale][key] ?? dictionary.en[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

const create = (type, props, ...children) => ({ type, props: props ?? {}, children });

function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.children);
}

function find(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = find(child, predicate);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = find(child, predicate);
    if (match !== undefined) return match;
  }
  return undefined;
}

const noop = () => {};

it('shows scope and the session/message source of a memory', () => {
  const tree = MemoryView(viewProps({ view: { phase: 'ready', value: { items: [{
    id: 'mem_source', text: '需要分步解释', kind: 'observation', scope: 'goal', goalId: 'goal-math', sessionId: null,
    sourceRef: { sessionId: 'session-original', messageId: 'message-original', quote: '请分步' },
    source: { actor: 'agent' }, updatedAt: '2026-11-15T00:00:00Z', expiresAt: null,
  }] } } }));
  assert.match(text(tree), /goal-math/);
  assert.match(text(tree), /session-original/);
  assert.match(text(tree), /message-original/);
});

const TRAITS = [
  { key: 'explain_detail', level: 4, defaultLevel: 3, min: 1, max: 5, step: 1, sourceKind: 'inferred', evidenceCount: 23, text: '首讲偏详细：补前置 + 推导 + 例子', active: true },
  { key: 'hint_preference', level: 0, defaultLevel: 0.5, min: 0, max: 1, step: 0.5, sourceKind: 'user_edit', evidenceCount: 0, text: '先给下一步提示，不直接给答案', active: true },
  { key: 'pace', level: -1, defaultLevel: 0, min: -1, max: 1, step: 1, sourceKind: 'user_edit', evidenceCount: 2, text: '推进速度偏慢，多确认', active: true },
  { key: 'example_first', level: 0.5, defaultLevel: 0.5, min: 0, max: 1, step: 0.5, sourceKind: null, evidenceCount: 0, text: '推导中穿插例子', active: false },
  { key: 'step_granularity', level: 2, defaultLevel: 2, min: 1, max: 3, step: 1, sourceKind: null, evidenceCount: 0, text: '关键步骤分点', active: false },
  { key: 'check_frequency', level: 1, defaultLevel: 1, min: 0, max: 2, step: 1, sourceKind: null, evidenceCount: 0, text: '讲完一段确认一次', active: false },
];

function viewProps(overrides = {}) {
  return {
    create,
    t: translator('zh'),
    tab: 'memory',
    view: { phase: 'ready', value: { items: [] } },
    profile: { phase: 'ready', value: { traits: TRAITS } },
    actions: [],
    dispatch: noop,
    draft: '',
    draftKind: 'preference',
    editingId: null,
    editingText: '',
    onTab: noop,
    onDraft: noop,
    onDraftKind: noop,
    onEditStart: noop,
    onEditCancel: noop,
    onEditText: noop,
    onAdd: noop,
    onCorrect: noop,
    onRemove: noop,
    onRetry: noop,
    onProfileRetry: noop,
    onLevel: noop,
    ...overrides,
  };
}

describe('memory page definition', () => {
  it('keeps the panel contract', () => {
    assert.equal(page.key, 'memory');
    assert.equal(page.order, 80);
    assert.equal(page.label, 'memory.panel');
    assert.equal(typeof page.Page, 'function');
  });
});

describe('memory tabs', () => {
  it('renders both tabs and marks the active one', () => {
    const tree = MemoryView(viewProps());
    assert.notEqual(find(tree, node => node.props?.['data-testid'] === 'memory-tab-memory'), undefined);
    assert.notEqual(find(tree, node => node.props?.['data-testid'] === 'memory-tab-profile'), undefined);
    const tab = find(tree, node => node.props?.['data-testid'] === 'memory-tab-memory');
    assert.equal(tab.props['aria-selected'], true);
    assert.equal(tree.props['data-tab'], 'memory');
  });

  it('renders the profile tab when selected', () => {
    const tree = MemoryView(viewProps({ tab: 'profile' }));
    assert.equal(tree.props['data-tab'], 'profile');
    assert.notEqual(find(tree, node => node.props?.['data-testid'] === 'study-memory-profile'), undefined);
    assert.equal(find(tree, node => node.props?.['data-testid'] === 'memory-row-x'), undefined);
  });
});

describe('ProfileView', () => {
  it('shows level, evidence count, actions, and the manual badge', () => {
    const tree = ProfileView({ create, t: translator('zh'), profile: { phase: 'ready', value: { traits: TRAITS } }, onLevel: noop, onReset: noop, onRetry: noop });
    const detail = find(tree, node => node.props?.['data-testid'] === 'memory-trait-explain_detail');
    assert.notEqual(detail, undefined);
    assert.match(text(detail), /讲解详细度/);
    assert.match(text(detail), /补前置/);
    assert.match(text(detail), /23/);
    const hint = find(tree, node => node.props?.['data-testid'] === 'memory-trait-hint_preference');
    assert.match(text(hint), /手动设置/);
    assert.match(text(hint), /只给下一步提示/);
    const pace = find(tree, node => node.props?.['data-testid'] === 'memory-trait-pace');
    assert.match(text(pace), /偏慢/);
  });

  it('calls onLevel with the next grid step and onReset with the default', () => {
    const calls = [];
    const tree = ProfileView({
      create,
      t: translator('zh'),
      profile: { phase: 'ready', value: { traits: TRAITS } },
      onLevel: (key, level) => calls.push([key, level]),
      onReset: (key, level) => calls.push(['reset', key, level]),
      onRetry: noop,
    });
    const detail = find(tree, node => node.props?.['data-testid'] === 'memory-trait-explain_detail');
    const buttons = [];
    const collect = node => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (node.type === 'button') buttons.push(node);
      node.children.forEach(collect);
    };
    collect(detail);
    assert.equal(buttons.length, 3);
    buttons[0].props.onClick();
    buttons[1].props.onClick();
    buttons[2].props.onClick();
    assert.deepEqual(calls, [['explain_detail', 3], ['explain_detail', 5], ['reset', 'explain_detail', 3]]);
  });

  it('disables the lower button at the minimum and shows loading and error states', () => {
    const minTrait = { ...TRAITS[0], level: 1 };
    const tree = ProfileView({ create, t: translator('zh'), profile: { phase: 'ready', value: { traits: [minTrait] } }, onLevel: noop, onReset: noop, onRetry: noop });
    const row = find(tree, node => node.props?.['data-testid'] === 'memory-trait-explain_detail');
    const buttons = [];
    const collect = node => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (node.type === 'button') buttons.push(node);
      node.children.forEach(collect);
    };
    collect(row);
    assert.equal(buttons[0].props.disabled, true);
    assert.match(text(ProfileView({ create, t: translator('en'), profile: { phase: 'loading' }, onLevel: noop, onReset: noop, onRetry: noop })), /Loading teaching profile/);
    const failed = ProfileView({ create, t: translator('en'), profile: { phase: 'error', message: 'boom' }, onLevel: noop, onReset: noop, onRetry: noop });
    assert.match(text(failed), /boom/);
  });
});
