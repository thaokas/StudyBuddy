/**
 * T13 page: the pure outcomes view. Every state, the three calibers, the
 * cancellation wording, the material summary, per-day rows, and the detail
 * list are asserted without a browser.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';

installReactStub();

const pageModule = await import('../../client/pages/outcomes.js');
const messages = (await import('../../client/messages/outcomes.js')).default;
const common = (await import('../../client/messages/common.js')).default;

const page = pageModule.default;
const { OutcomesView, shiftAnchor } = pageModule;

const DICTIONARY = { ...messages.zh, ...common.zh };

/**
 * Minimal translator over the shipped zh dictionary.
 * @param {string} key - Message key.
 * @param {object} [params] - Placeholder values.
 * @returns {string} Rendered copy.
 */
function t(key, params) {
  const template = DICTIONARY[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/** Build one element node like the React stub. */
function create(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() };
}

/** Depth-first search for the first element with a test id. */
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

/** Every element with a test id prefix. */
function byTestIdPrefix(tree, prefix) {
  const found = [];
  const visit = node => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== 'object') return;
    const testId = node.props?.['data-testid'];
    if (typeof testId === 'string' && testId.startsWith(prefix)) found.push(node);
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

/** Build the ready payload used across the assertions. */
function readyValue() {
  return {
    scope: 'week',
    from: '2026-11-09',
    to: '2026-11-15',
    today: '2026-11-10',
    generatedAt: '2026-11-10T01:00:00.000Z',
    empty: false,
    state: 'ready',
    notice: null,
    completion: {
      original: { planned: 4, completed: 1, cancelled: 1, pending: 0, unrecorded: 2, recorded: 2, rate: 0.25 },
      adjusted: { planned: 4, completed: 1, cancelled: 1, pending: 1, unrecorded: 1, recorded: 3, rate: 0.25 },
      cancelled: { originalCount: 1, adjustedCount: 1, originalShare: 0.25, adjustedShare: 0.25 },
      bySource: {
        tasks: {
          original: { planned: 2, completed: 1, cancelled: 0, pending: 0, unrecorded: 1, recorded: 1, rate: 0.5 },
          adjusted: { planned: 2, completed: 1, cancelled: 0, pending: 0, unrecorded: 1, recorded: 1, rate: 0.5 },
        },
        planItems: {
          original: { planned: 2, completed: 0, cancelled: 1, pending: 0, unrecorded: 1, recorded: 1, rate: 0 },
          adjusted: { planned: 2, completed: 0, cancelled: 1, pending: 1, unrecorded: 0, recorded: 2, rate: 0 },
        },
      },
    },
    counts: {
      totalUnits: 3, original: 4, adjusted: 4, recorded: 3, unrecorded: 2,
      completed: 1, cancelled: 1, pending: 1, unplanned: 1,
    },
    materials: {
      advancedItemCount: 2,
      distinctMaterialCount: 1,
      items: [{
        materialId: 'mat_1',
        title: '数学练习册',
        deleted: false,
        itemIds: ['item_1', 'item_2'],
        planIds: ['plan_1'],
        recordDates: ['2026-11-10'],
      }],
      taskReferenceCount: 1,
      taskReferences: [{
        taskId: 'task_1',
        title: '习题 1-10',
        materialRef: '练习册 P30',
        status: 'done',
        recordDate: '2026-11-10',
      }],
    },
    days: [
      {
        date: '2026-11-09', weekday: 1, originalPlanned: 1, adjustedPlanned: 1,
        originalCompleted: 0, adjustedCompleted: 0, cancelled: 0, records: 0,
        completedRecords: 0, materialAdvances: 0, baselineSource: 'day_snapshot',
        sources: { tasks: 'day_snapshot', plan: 'none' }, snapshotAt: '2026-11-09T01:00:00.000Z',
      },
      {
        date: '2026-11-10', weekday: 2, originalPlanned: 2, adjustedPlanned: 3,
        originalCompleted: 1, adjustedCompleted: 1, cancelled: 1, records: 2,
        completedRecords: 1, materialAdvances: 1, baselineSource: 'day_snapshot',
        sources: { tasks: 'day_snapshot', plan: 'plan_revision' }, snapshotAt: '2026-11-10T01:00:00.000Z',
      },
    ],
    items: [
      {
        key: 'task\u0000task_1', kind: 'task', ref: 'task_1', taskId: 'task_1', planId: null, itemId: null,
        title: '习题 1-10', subject: '数学', materialId: null, materialTitle: null, materialRef: '练习册 P30',
        deleted: false, original: true, originalDate: '2026-11-09', originalSource: 'day_snapshot',
        adjusted: true, adjustedDate: '2026-11-10', adjustedSource: 'time_block',
        status: 'done', confirmed: true, pending: false, recordId: 11, recordDate: '2026-11-10',
        quantityDone: 10, quantityTotal: 10, note: null,
      },
      {
        key: 'plan\u0000plan_1\u0000item_1', kind: 'plan', ref: 'item_1', taskId: null, planId: 'plan_1', itemId: 'item_1',
        title: '练习册 第1章', subject: '数学', materialId: 'mat_1', materialTitle: '数学练习册', materialRef: null,
        deleted: false, original: true, originalDate: '2026-11-10', originalSource: 'plan_revision',
        adjusted: true, adjustedDate: '2026-11-10', adjustedSource: 'plan_revision',
        status: 'partial', confirmed: true, pending: false, recordId: 12, recordDate: '2026-11-10',
        quantityDone: 3, quantityTotal: 10, note: '做到第 3 题',
      },
      {
        key: 'task\u0000task_2', kind: 'task', ref: 'task_2', taskId: 'task_2', planId: null, itemId: null,
        title: '没有排计划的任务', subject: null, materialId: null, materialTitle: null, materialRef: null,
        deleted: false, original: false, originalDate: null, originalSource: null,
        adjusted: false, adjustedDate: null, adjustedSource: null,
        status: 'in_progress', confirmed: true, pending: false, recordId: 13, recordDate: '2026-11-11',
        quantityDone: null, quantityTotal: null, note: null,
      },
    ],
    baseline: {
      daySnapshotDates: ['2026-11-09', '2026-11-10'],
      changeLogDates: [],
      planRevisionDates: ['2026-11-10'],
      planRevisions: 1,
    },
  };
}

/** Render the pure view over one state. */
function renderView(view, overrides = {}) {
  const calls = [];
  const tree = OutcomesView({
    create,
    t,
    view,
    mode: overrides.mode ?? 'week',
    onMode: value => calls.push(['mode', value]),
    onPrev: () => calls.push(['prev']),
    onNext: () => calls.push(['next']),
    onToday: () => calls.push(['today']),
    onRefresh: () => calls.push(['refresh']),
    onRetry: () => calls.push(['retry']),
  });
  return { tree, calls };
}

describe('outcomes page contract', () => {
  it('ships the page key, order, and label', () => {
    assert.deepEqual(page, { key: 'outcomes', order: 25, label: 'outcomes.panel', Page: page.Page });
    assert.equal(DICTIONARY['outcomes.panel'], '成果');
  });

  it('renders the loading state', () => {
    const { tree } = renderView({ phase: 'loading' });
    assert.ok(byTestId(tree, 'study-loading'));
    assert.equal(byTestId(tree, 'study-error'), null);
  });

  it('renders an error with a retry action', () => {
    const { tree, calls } = renderView({ phase: 'error', message: 'boom' });
    const error = byTestId(tree, 'study-error');
    assert.ok(error);
    assert.ok(textOf(error).includes('boom'));
    byTestId(tree, 'outcomes-retry').props.onClick();
    assert.deepEqual(calls, [['retry']]);
  });

  it('renders the three calibers, materials, day rows, and detail list', () => {
    const { tree } = renderView({ phase: 'ready', value: readyValue(), revision: 7 });
    assert.equal(textOf(byTestId(tree, 'outcomes-rate-original')), '原计划 25% 完成 1 / 计划 4 2 项未记录');
    assert.equal(textOf(byTestId(tree, 'outcomes-rate-adjusted')), '调整后 25% 完成 1 / 计划 4 1 项未记录 1 项待确认');
    const cancelled = textOf(byTestId(tree, 'outcomes-rate-cancelled'));
    assert.ok(cancelled.includes('主动取消'));
    assert.ok(cancelled.includes('25%'));
    assert.ok(cancelled.includes('取消 1 / 计划 4'));
    assert.ok(cancelled.includes('取消保留在分母里'));
    assert.equal(byTestId(tree, 'outcomes-rate-original').props['data-testid'], 'outcomes-rate-original');

    const materials = byTestId(tree, 'outcomes-materials');
    assert.ok(textOf(materials).includes('推进 2 条 · 1 份材料'));
    assert.ok(textOf(byTestId(tree, 'outcomes-material-mat_1')).includes('数学练习册'));
    assert.ok(textOf(byTestId(tree, 'outcomes-task-refs')).includes('练习册 P30'));

    const dayTen = byTestId(tree, 'outcomes-day-2026-11-10');
    assert.ok(dayTen);
    assert.ok(textOf(dayTen).includes('1 / 2'), 'original day row shows done / planned');
    assert.ok(textOf(dayTen).includes('1 / 3'), 'adjusted day row shows done / planned');
    assert.equal(byTestIdPrefix(tree, 'outcomes-day-').length, 2);

    const items = byTestId(tree, 'outcomes-items');
    assert.ok(textOf(items).includes('习题 1-10'));
    assert.ok(textOf(items).includes('练习册 第1章'));
    assert.ok(textOf(byTestId(tree, 'outcomes-item-0')).includes('原计划于 2026-11-09'));
    assert.ok(textOf(byTestId(tree, 'outcomes-item-0')).includes('计划于 2026-11-10'));
    assert.ok(textOf(byTestId(tree, 'outcomes-item-status-0')).includes('完成'));
    assert.ok(textOf(byTestId(tree, 'outcomes-item-status-1')).includes('部分完成'));
    assert.ok(textOf(byTestId(tree, 'outcomes-item-unplanned-2')).includes('未排计划'));
    assert.ok(textOf(items).includes('3 / 10'));
    assert.ok(textOf(items).includes('做到第 3 题'));
  });

  it('names an empty period and does not render fabricated rates', () => {
    const value = readyValue();
    value.empty = true;
    value.state = 'empty';
    value.completion.original = { planned: 0, completed: 0, cancelled: 0, pending: 0, unrecorded: 0, recorded: 0, rate: null };
    value.completion.adjusted = { ...value.completion.original };
    value.completion.cancelled = { originalCount: 0, adjustedCount: 0, originalShare: null, adjustedShare: null };
    value.counts = { totalUnits: 0, original: 0, adjusted: 0, recorded: 0, unrecorded: 0, completed: 0, cancelled: 0, pending: 0, unplanned: 0 };
    value.materials = { advancedItemCount: 0, distinctMaterialCount: 0, items: [], taskReferenceCount: 0, taskReferences: [] };
    value.days = [{ ...value.days[0], originalPlanned: 0, adjustedPlanned: 0, originalCompleted: 0, adjustedCompleted: 0, cancelled: 0, records: 0 }];
    value.items = [];

    const { tree } = renderView({ phase: 'ready', value, revision: 8 });
    const empty = byTestId(tree, 'outcomes-empty');
    assert.ok(empty);
    assert.ok(textOf(empty).includes('这段时间还没有计划或进度记录'));
    assert.equal(byTestId(tree, 'outcomes-rate-original'), null);
    assert.equal(byTestId(tree, 'outcomes-items'), null);
    assert.ok(textOf(tree).includes('未记录不等于未学习'));
  });

  it('explains planned-but-unrecorded work without calling it unfinished', () => {
    const value = readyValue();
    value.state = 'no_evidence';
    value.completion.original = { planned: 2, completed: 0, cancelled: 0, pending: 0, unrecorded: 2, recorded: 0, rate: 0 };
    value.completion.adjusted = { ...value.completion.original };
    value.items = value.items.slice(0, 1).map(item => ({ ...item, status: 'unrecorded', confirmed: null, pending: false, recordId: null, recordDate: null, quantityDone: null, quantityTotal: null, note: null }));
    value.items[0].original = true;
    value.items[0].adjusted = true;
    const { tree } = renderView({ phase: 'ready', value, revision: 9 });
    const banner = byTestId(tree, 'outcomes-state-no_evidence');
    assert.ok(banner);
    assert.ok(textOf(banner).includes('1 项计划还没有进度记录'));
    assert.ok(textOf(banner).includes('未记录不等于未学习'));
  });

  it('wires the mode switch, navigation, today, and refresh actions', () => {
    const { tree, calls } = renderView({ phase: 'ready', value: readyValue(), revision: 1 });
    assert.equal(byTestId(tree, 'outcomes-mode-week').props['aria-pressed'], true);
    byTestId(tree, 'outcomes-mode-month').props.onClick();
    byTestId(tree, 'outcomes-prev').props.onClick();
    byTestId(tree, 'outcomes-next').props.onClick();
    byTestId(tree, 'outcomes-today').props.onClick();
    byTestId(tree, 'outcomes-refresh').props.onClick();
    assert.deepEqual(calls, [['mode', 'month'], ['prev'], ['next'], ['today'], ['refresh']]);
  });

  it('shifts day, week, and month anchors across boundaries', () => {
    assert.equal(shiftAnchor('2026-11-10', 'day', 1), '2026-11-11');
    assert.equal(shiftAnchor('2026-11-10', 'day', -1), '2026-11-09');
    assert.equal(shiftAnchor('2026-11-09', 'week', 1), '2026-11-16');
    assert.equal(shiftAnchor('2026-11-30', 'week', 1), '2026-12-07');
    assert.equal(shiftAnchor('2026-11-01', 'month', -1), '2026-10-01');
    assert.equal(shiftAnchor('2026-12-01', 'month', 1), '2027-01-01');
  });
});
