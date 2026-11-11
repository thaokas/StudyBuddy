/**
 * The week-mode "this week's learning analysis" card: three bullets, expand,
 * generate, refresh, error, and no card outside week mode.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from './support/react-stub.mjs';

installReactStub();

const { OutcomesView } = await import('../../client/pages/outcomes.js');
const messages = (await import('../../client/messages/outcomes.js')).default;
const common = (await import('../../client/messages/common.js')).default;

const DICTIONARY = { ...messages.zh, ...common.zh };

function t(key, params) {
  const template = DICTIONARY[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

function create(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() };
}

function byTestId(tree, testId) {
  if (tree === null || tree === undefined) return null;
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = byTestId(child, testId);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof tree !== 'object') return null;
  if (tree.props?.['data-testid'] === testId) return tree;
  return byTestId(tree.children ?? [], testId);
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  return textOf(node.children ?? []);
}

/** A ready-but-empty week; the statistical body is irrelevant to the card. */
function emptyWeek() {
  return {
    phase: 'ready',
    value: {
      from: '2026-11-09',
      to: '2026-11-15',
      empty: true,
      state: 'empty',
      counts: { unplanned: 0 },
      items: [],
      days: [],
      materials: { advancedItemCount: 0, distinctMaterialCount: 0, items: [], taskReferenceCount: 0, taskReferences: [] },
      completion: {
        original: { planned: 0, completed: 0, cancelled: 0, pending: 0, unrecorded: 0, recorded: 0, rate: null },
        adjusted: { planned: 0, completed: 0, cancelled: 0, pending: 0, unrecorded: 0, recorded: 0, rate: null },
        cancelled: { originalCount: 0, adjustedCount: 0, originalShare: null, adjustedShare: null },
      },
    },
  };
}

const REPORT = {
  phase: 'ready',
  period: '2026-W46',
  report: {
    period: '2026-W46',
    bullets: ['本周 5 次问答、5 道题。', '重问集中在「函数可微」。', '同类反复：最近 7 天有 4 道重问。'],
    reportMd: '## 我看到的\n- 本周 5 次问答。\n\n## 我的解释\n- 你可能停在“看懂步骤”。',
  },
};

function render(overrides = {}) {
  const calls = [];
  const tree = OutcomesView({
    create,
    t,
    view: emptyWeek(),
    mode: 'week',
    onMode: value => calls.push(['mode', value]),
    onPrev: () => calls.push(['prev']),
    onNext: () => calls.push(['next']),
    onToday: () => calls.push(['today']),
    onRefresh: () => calls.push(['refresh']),
    onRetry: () => calls.push(['retry']),
    review: REPORT,
    reviewExpanded: false,
    onGenerateReview: () => calls.push(['generate']),
    onToggleReview: () => calls.push(['toggle']),
    onRetryReview: () => calls.push(['retryReview']),
    ...overrides,
  });
  return { tree, calls };
}

describe('outcomes weekly analysis card', () => {
  it('renders the three bullets and wires refresh and expand', () => {
    const { tree, calls } = render();
    const card = byTestId(tree, 'outcomes-review');
    assert.ok(card);
    const bullets = byTestId(tree, 'outcomes-review-bullets');
    assert.ok(bullets);
    assert.equal(bullets.children.length, 3);
    assert.ok(textOf(bullets).includes('本周 5 次问答'));
    assert.equal(byTestId(tree, 'outcomes-review-report'), null);
    byTestId(tree, 'outcomes-review-refresh').props.onClick();
    byTestId(tree, 'outcomes-review-toggle').props.onClick();
    assert.deepEqual(calls, [['generate'], ['toggle']]);
  });

  it('expands the full Markdown report in place', () => {
    const { tree } = render({ reviewExpanded: true });
    const report = byTestId(tree, 'outcomes-review-report');
    assert.ok(report);
    assert.ok(textOf(report).includes('## 我看到的'));
    assert.ok(textOf(report).includes('## 我的解释'));
  });

  it('offers a generate button when the week has no report yet', () => {
    const { tree, calls } = render({ review: { phase: 'ready', period: '2026-W46', report: null } });
    assert.ok(byTestId(tree, 'outcomes-review-empty'));
    const button = byTestId(tree, 'outcomes-review-generate');
    assert.ok(button);
    button.props.onClick();
    assert.deepEqual(calls, [['generate']]);
  });

  it('shows a retry action when the report read fails', () => {
    const { tree, calls } = render({ review: { phase: 'error', message: '读取失败' } });
    assert.ok(textOf(byTestId(tree, 'outcomes-review-error')).includes('读取失败'));
    byTestId(tree, 'outcomes-review-retry').props.onClick();
    assert.deepEqual(calls, [['retryReview']]);
  });

  it('does not render the card outside week mode', () => {
    const { tree } = render({ mode: 'day' });
    assert.equal(byTestId(tree, 'outcomes-review'), null);
  });
});
