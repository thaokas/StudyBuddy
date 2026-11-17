import test from 'node:test';
import assert from 'node:assert/strict';
import { installReactStub } from '../../../study-outcomes/tests/client/support/react-stub.mjs';
import {
  ITEM, byTestId, draftView, findAll, loadDictionary, planGet, text, translatorFor,
} from '../onboarding/helpers.mjs';

/**
 * The rolling window is the plan page's primary reading surface. These tests
 * pin the readable structure: dated day groups inside the window, one compact
 * month summary (plus a collapsed stored list) beyond it, and a folded project
 * view instead of a second copy of every task.
 */
installReactStub();
const { PlanView } = await import('../../client/pages/plan.js');
const dictionary = await loadDictionary();
const zh = translatorFor(dictionary, 'zh');
const en = translatorFor(dictionary, 'en');
const create = (type, props, ...children) => ({ type, props: props ?? {}, children });

/** Render the page and fail on an unresolved dictionary key. */
function render(t, data, extra = {}) {
  const tree = PlanView({
    create,
    t,
    view: { phase: 'ready', value: data, materials: [], goal: null, progressItems: [], warnings: [], busy: false },
    workspaceItems: [],
    onRefine: () => {},
    ...extra,
  });
  const rendered = text(tree);
  assert.doesNotMatch(rendered, /plan\.[a-z]/, `未解析的文案键：${rendered}`);
  return { tree, rendered };
}

/** A seven-day window: three dated tasks inside it and three stored far items. */
function windowData() {
  const data = planGet();
  data.rolling = {
    start: '2026-11-11',
    end: '2026-11-17',
    horizonDays: 7,
    detailedItems: [
      { ...ITEM, id: 'item_1', title: 'Chapter 2 exercises 1-10', date: '2026-11-11', projectId: 'proj_1' },
      {
        ...ITEM, id: 'item_2', title: 'Chapter 3 preview', date: '2026-11-12', projectId: 'proj_2',
        materialId: null, locator: null, estimateMinutes: 30, start: null, end: null, source: 'agent',
      },
      {
        ...ITEM, id: 'item_3', title: 'Weekly review', date: '2026-11-17', projectId: 'proj_1',
        materialId: null, locator: null, estimateMinutes: 90, start: null, end: null,
      },
    ],
    distantWork: [
      { id: 'far_1', title: 'Mock paper 1', targetDate: '2026-12-01', estimateMinutes: 120 },
      { id: 'far_2', title: 'Mock paper 2', targetDate: '2026-12-05', estimateMinutes: 120 },
      { id: 'far_3', title: 'Review week', targetDate: '2027-01-10', estimateMinutes: 60 },
    ],
    refinement: { needed: false },
  };
  return data;
}

test('rolling window lists each detailed day with weekday, totals and project chips', () => {
  const data = windowData();
  const recorded = [];
  const { tree, rendered } = render(zh, data, { onProgress: (item, status) => recorded.push({ id: item.id, status }) });
  assert.match(rendered, /未来 7 天详细安排/);
  assert.match(text(byTestId(tree, 'plan-rolling-range')), /2026-11-11 → 2026-11-17/);
  assert.equal(text(byTestId(tree, 'plan-rolling-days')), '3 天有安排');
  assert.equal(text(byTestId(tree, 'plan-rolling-counts')), '3 项 · 180 分钟');
  assert.match(text(byTestId(tree, 'plan-window-month-2026-11')), /3 项 · 180 分钟/);

  // One readable group per date: weekday, relative marker and day totals.
  const first = text(byTestId(tree, 'plan-window-day-2026-11-11'));
  assert.match(first, /2026-11-11 · 周三/);
  assert.match(first, /今天/);
  assert.match(first, /1 项 · 60 分钟/);
  assert.match(first, /Chapter 2 exercises 1-10/);
  assert.match(first, /Calculus workbook/, '项目名要出现在任务标题旁');
  assert.match(first, /19:00–20:00/);
  const second = text(byTestId(tree, 'plan-window-day-2026-11-12'));
  assert.match(second, /2026-11-12 · 周四/);
  assert.match(second, /明天/);
  assert.match(second, /Chapter 3 preview/);
  assert.match(second, /Chapter study/);
  assert.match(second, /未排时间/, '窗口内用短标签，不在每一行重复工作台说明');
  assert.match(text(byTestId(tree, 'plan-rolling-note')), /工作台安排/, '工作台说明只在卡片级出现一次');
  const last = text(byTestId(tree, 'plan-window-day-2026-11-17'));
  assert.doesNotMatch(last, /今天|明天/);

  // The window items own prefixed ids so the project view keeps the old ones.
  assert.ok(byTestId(tree, 'plan-window-item-item_1'));
  assert.ok(byTestId(tree, 'plan-item-item_1'));
  const progressButton = byTestId(tree, 'plan-window-progress-item_1-done');
  assert.ok(progressButton, '窗口内任务要能直接记录进度');
  progressButton.props.onClick();
  assert.deepEqual(recorded, [{ id: 'item_1', status: 'done' }]);
  // No "no material" line every day: only present citations open.
  assert.equal(byTestId(tree, 'plan-window-item-source-none-item_2'), undefined);
  assert.ok(byTestId(tree, 'plan-window-item-source-item_1'));
});

test('work beyond the window is a month summary, not a paragraph per item', () => {
  const { tree, rendered } = render(zh, windowData());
  assert.match(text(byTestId(tree, 'plan-distant-month-2026-12')), /2026-12/);
  assert.match(text(byTestId(tree, 'plan-distant-month-2026-12')), /2 项 · 240 分钟/);
  assert.match(text(byTestId(tree, 'plan-distant-month-2027-01')), /2027-01/);
  assert.match(text(byTestId(tree, 'plan-distant-month-2027-01')), /1 项 · 60 分钟/);
  assert.match(text(byTestId(tree, 'plan-rolling-distant-note')), /3 项 · 约 300 分钟/);
  const stored = byTestId(tree, 'plan-rolling-distant-items');
  assert.equal(stored.type, 'details');
  assert.match(text(stored), /更远的已存条目（3）/);
  assert.match(text(stored), /Mock paper 1/);
  assert.doesNotMatch(rendered, /具体任务待细化/, '远日不再用一句模板重复每个条目');
  assert.equal(rendered.match(/Mock paper 1/g)?.length, 1, '远日标题只在折叠清单出现一次');
  for (const date of ['2026-11-11', '2026-11-12', '2026-11-17']) {
    assert.doesNotMatch(text(byTestId(tree, `plan-window-day-${date}`)), /Mock paper/, '窗口外的任务不混进窗口内');
  }
});

test('the project view is folded so the page does not repeat every task', () => {
  const { tree } = render(zh, windowData());
  const all = byTestId(tree, 'plan-tasks-all');
  assert.equal(all.type, 'details');
  assert.match(text(all.children[0]), /按项目查看全部任务（1 项 · 60 分钟）/);
  assert.ok(byTestId(tree, 'plan-project-tasks-proj_1'));
  assert.ok(byTestId(tree, 'plan-tasks-time-note'));
});

test('a draft preview is marked and cannot record progress against draft items', () => {
  const data = windowData();
  data.draft = draftView();
  const { tree } = render(zh, data);
  assert.match(text(byTestId(tree, 'plan-window-item-item_1')), /草案/);
  assert.equal(byTestId(tree, 'plan-window-progress-item_1-done'), undefined);
  assert.ok(byTestId(tree, 'plan-draft-items'));
});

test('the same item rendered in the window and the project view keeps test ids unique', () => {
  const { tree } = render(zh, windowData());
  const ids = findAll(tree, node => typeof node.props?.['data-testid'] === 'string')
    .map(node => node.props['data-testid']);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, [], `重复的 data-testid：${duplicates.join(', ')}`);
  // The citation's inner evidence ids are scoped too, not just the disclosure.
  const first = byTestId(tree, 'plan-window-item-source-item_1');
  assert.ok(byTestId(first, 'plan-window-item-source-unverified-item_1'), '未核实证据行要带条目作用域');
});

test('the window renders in English with localized weekdays', () => {
  const { tree, rendered } = render(en, windowData());
  assert.doesNotMatch(rendered, /[\u3400-\u9fff]/);
  assert.match(rendered, /Detailed window: 7 days/);
  assert.match(text(byTestId(tree, 'plan-window-day-2026-11-11')), /2026-11-11 · Wed/);
  assert.match(text(byTestId(tree, 'plan-window-day-2026-11-11')), /Today/);
  assert.match(text(byTestId(tree, 'plan-window-day-2026-11-12')), /Tomorrow/);
  assert.match(rendered, /Beyond the window/);
});
