/**
 * T14 feedback view: the completion toast and the stage card rendered from a
 * plain state. Copy comes from the shipped dictionary (never from host
 * sentences when a translation exists), nothing is modal, and both surfaces
 * expose an explicit dismiss.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';
import feedbackMessages from '../../client/messages/feedback.js';

installReactStub();

const { FeedbackView, MilestoneFeedback } = await import('../../client/components/feedback.js');

const DICTIONARY = { en: feedbackMessages.en, zh: feedbackMessages.zh };

/**
 * Build a translator over the shipped dictionary.
 * @param {string} [locale] - Dictionary to read.
 * @returns {(key: string, params?: Record<string, unknown>) => string} Translator.
 */
function translator(locale = 'zh') {
  const table = DICTIONARY[locale] ?? DICTIONARY.zh;
  return (key, params) => {
    const template = table[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

/** Build one element node like the React stub. */
function create(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() };
}

/** Collect element nodes from a rendered tree. */
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

/** Concatenate the text content of a subtree. */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  return textOf(node.children ?? []);
}

/** Depth-first search for the first element with a test id. */
function byTestId(tree, testId) {
  return elements(tree).find(node => node.props?.['data-testid'] === testId) ?? null;
}

/** One record toast entry. */
function recordToast(overrides = {}) {
  return { token: 'record:task:7', type: 'record', title: '习题 1-10', recordDate: '2026-11-10', ...overrides };
}

/** One milestone toast entry. */
function milestoneToast(overrides = {}) {
  return { token: 'milestone:week.first@2026-11-10', type: 'milestone', id: 'week.first', title: '本周第一条完成记录', achievedOn: '2026-11-10', ...overrides };
}

/** A ready week card with dictionary-covered lines. */
function weekCard(overrides = {}) {
  return {
    key: 'week:2026-11-09',
    period: 'week',
    from: '2026-11-09',
    to: '2026-11-15',
    lines: [
      {
        key: 'planned',
        values: { planned: 4, completed: 1, cancelled: 1, pending: 1, unrecorded: 1 },
        text: 'HOST-PLANNED-SENTENCE',
      },
      { key: 'rate', values: { percent: 25, completed: 1, planned: 4 }, text: 'HOST-RATE-SENTENCE' },
    ],
    earned: [{ id: 'week.first', title: '本周第一条完成记录', achievedOn: '2026-11-10' }],
    next: { id: 'week.three', title: '本周完成 3 项', remaining: 2 },
    streak: { tracked: false, penalty: false, consecutive: null, resetOnMiss: false },
    ...overrides,
  };
}

/** Render one state. */
function render(state, { locale = 'zh', calls = [] } = {}) {
  const tree = FeedbackView({
    create,
    t: translator(locale),
    state,
    onDismissToast: () => calls.push('dismissToast'),
    onDismissCard: () => calls.push('dismissCard'),
    onRetry: () => calls.push('retry'),
  });
  return { tree, calls };
}

describe('milestone feedback view', () => {
  it('renders the completion toast as a polite status, never a dialog or alert', () => {
    const { tree, calls } = render({ toasts: [recordToast()], card: null, error: null });
    const toast = byTestId(tree, 'study-feedback-toast');
    assert.ok(toast);
    assert.equal(toast.props.role, 'status');
    assert.equal(toast.props['aria-live'], 'polite');
    assert.ok(textOf(toast).includes('已记录完成：习题 1-10'));
    assert.equal(textOf(tree).includes('Dialog'), false);
    assert.equal(elements(tree).some(node => node.props?.role === 'alert'), false);
    assert.equal(elements(tree).some(node => node.props?.role === 'dialog'), false);
    assert.equal(tree.props.style.pointerEvents, 'none', '容器不拦截桌面点击');

    byTestId(tree, 'study-feedback-toast-dismiss').props.onClick();
    assert.deepEqual(calls, ['dismissToast']);
  });

  it('localizes both the record line and the milestone line', () => {
    const { tree } = render({ toasts: [recordToast(), milestoneToast()], card: null, error: null }, { locale: 'en' });
    const text = textOf(tree);
    assert.ok(text.includes('Recorded as done: 习题 1-10'));
    assert.ok(text.includes('Milestone: First completion this week'));
  });

  it('falls back to a neutral label for an untitled completion', () => {
    const { tree } = render({ toasts: [recordToast({ title: null })], card: null, error: null });
    assert.ok(textOf(tree).includes('已记录完成：未命名条目'));
  });

  it('renders the stage card with dictionary copy, evidence, and next step', () => {
    const { tree, calls } = render({ toasts: [], card: weekCard(), error: null });
    const card = byTestId(tree, 'study-milestone-summary');
    assert.ok(card);
    assert.equal(card.props['data-period'], 'week');
    const text = textOf(card);
    assert.ok(text.includes('本周小结'));
    assert.ok(text.includes('2026-11-09 — 2026-11-15'));
    assert.ok(text.includes('计划 4 项：已确认完成 1 项'));
    assert.ok(text.includes('调整后完成率 25%'));
    assert.equal(text.includes('HOST-PLANNED-SENTENCE'), false, '字典优先于宿主句子');
    assert.equal(text.includes('HOST-RATE-SENTENCE'), false);
    assert.ok(text.includes('本周第一条完成记录'));
    assert.ok(text.includes('达成于 2026-11-10'));
    assert.ok(text.includes('下一步：本周完成 3 项（还差 2）'));
    assert.ok(text.includes('不计算连续打卡'));

    byTestId(tree, 'study-milestone-summary-dismiss').props.onClick();
    assert.deepEqual(calls, ['dismissCard']);
  });

  it('says so when a period has no milestone yet, and omits the next step when all are reached', () => {
    const { tree } = render({ toasts: [], card: weekCard({ earned: [], next: null }), error: null });
    assert.ok(textOf(byTestId(tree, 'study-milestone-none')).includes('还没有已确认完成的里程碑'));
    assert.equal(byTestId(tree, 'study-milestone-next'), null);
  });

  it('shows a quiet retry line for a failed read', () => {
    const { tree, calls } = render({ toasts: [], card: null, error: { scope: 'summary', message: 'boom' } });
    const error = byTestId(tree, 'study-feedback-error');
    assert.ok(error);
    assert.equal(error.props.role, 'status');
    assert.ok(textOf(error).includes('阶段小结暂时读取失败：boom'));
    byTestId(tree, 'study-feedback-retry').props.onClick();
    assert.deepEqual(calls, ['retry']);
  });

  it('renders nothing when there is nothing to show', () => {
    assert.equal(render({ toasts: [], card: null, error: null }).tree, null);
    assert.equal(render(undefined).tree, null);
  });

  it('wires the component to the injected observable selector', () => {
    const state = { toasts: [recordToast()], card: null, error: null };
    const tree = MilestoneFeedback({
      t: translator('zh'),
      useMilestones: selector => selector(state),
      dismissToast: () => {},
      dismissCard: () => {},
      retry: () => {},
    });
    assert.ok(byTestId(tree, 'study-feedback-toast'));
  });
});
