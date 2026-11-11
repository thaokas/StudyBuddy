/**
 * The workbench page: definition shape, every rendered state in both
 * languages, the task and block forms, and the optimistic transforms including
 * the rollback rule. The pure `WorkbenchView` and the exported state helpers
 * run under a React stub, so no browser or renderer is involved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';

installReactStub();

const {
  default: page,
  WorkbenchView,
  optimisticTaskCreate,
  optimisticTaskUpdate,
  optimisticTaskDelete,
  optimisticBlockCreate,
  optimisticBlockUpdate,
  optimisticBlockDelete,
  runOptimistic,
  summarizeBlocks,
} = await import('../../client/pages/workbench.js');
const { mergeMessages } = await import('../../client/lib/definitions.js');
const common = (await import('../../client/messages/common.js')).default;
const workbench = (await import('../../client/messages/workbench.js')).default;

const dictionary = mergeMessages([{ file: 'common', dictionary: common }, { file: 'workbench', dictionary: workbench }]);

/**
 * Translate one key with the real dictionary.
 * @param {'en' | 'zh'} locale - Active locale.
 * @returns {(key: string, params?: object) => string} Translator.
 */
function translator(locale) {
  return (key, params) => {
    const template = dictionary[locale][key] ?? dictionary.en[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

/** Record every element as a plain node so the tree can be walked. */
const create = (type, props, ...children) => ({ type, props: props ?? {}, children });

/**
 * Collect the text of one rendered tree.
 * @param {unknown} node - Element node, string, or array.
 * @returns {string} Concatenated text.
 */
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.children);
}

/**
 * Find one element by predicate.
 * @param {unknown} node - Element node, string, or array.
 * @param {(node: object) => boolean} predicate - Test.
 * @returns {object | undefined} First match.
 */
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

/**
 * Find every element by predicate.
 * @param {unknown} node - Element node, string, or array.
 * @param {(node: object) => boolean} predicate - Test.
 * @returns {object[]} Matches.
 */
function findAll(node, predicate) {
  const matches = [];
  if (node === null || typeof node !== 'object') return matches;
  if (Array.isArray(node)) {
    for (const child of node) matches.push(...findAll(child, predicate));
    return matches;
  }
  if (predicate(node)) matches.push(node);
  for (const child of node.children) matches.push(...findAll(child, predicate));
  return matches;
}

const TASK_A = {
  id: 'task_a',
  title: '数学分析 第3章 习题',
  subject: '数学',
  materialRef: '数学分析 第三版 第3章',
  completionCriteria: '做完 1-20 题',
  estimatedMinutes: 90,
  prerequisiteIds: [],
  prerequisites: [],
  deletedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const TASK_B = {
  id: 'task_b',
  title: '英语阅读',
  subject: '英语',
  materialRef: null,
  completionCriteria: null,
  estimatedMinutes: 30,
  prerequisiteIds: [TASK_A.id],
  prerequisites: [{ id: TASK_A.id, title: TASK_A.title, deleted: false }],
  deletedAt: null,
  createdAt: '2026-11-02T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
};
const STUDY_BLOCK = {
  id: 'block_study',
  date: '2026-11-11',
  start: '10:00',
  end: '11:00',
  startMinute: 600,
  endMinute: 660,
  minutes: 60,
  fixed: false,
  taskId: TASK_A.id,
  title: null,
  note: null,
  task: { id: TASK_A.id, title: TASK_A.title, subject: TASK_A.subject, deleted: false },
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
};
const FIXED_BLOCK = {
  id: 'block_fixed',
  date: '2026-11-11',
  start: '08:00',
  end: '09:30',
  startMinute: 480,
  endMinute: 570,
  minutes: 90,
  fixed: true,
  taskId: TASK_A.id,
  title: '高等数学课',
  note: null,
  task: { id: TASK_A.id, title: TASK_A.title, subject: TASK_A.subject, deleted: false },
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
};
const EMPTY_SUMMARY = { study: { blockCount: 0, minuteCount: 0, taskCount: 0 }, fixed: { blockCount: 0, minuteCount: 0, taskCount: 0 } };
const SUMMARY = { study: { blockCount: 1, minuteCount: 60, taskCount: 1 }, fixed: { blockCount: 1, minuteCount: 90, taskCount: 1 } };

const DAY = {
  date: '2026-11-11',
  weekday: 3,
  weekStart: '2026-11-09',
  weekEnd: '2026-11-15',
  blocks: [FIXED_BLOCK, STUDY_BLOCK],
  tasks: [TASK_A, TASK_B],
  unscheduledTaskIds: [TASK_B.id],
  summary: SUMMARY,
};
const WEEK = {
  startDate: '2026-11-09',
  endDate: '2026-11-15',
  days: [
    { date: '2026-11-09', weekday: 1, blocks: [], summary: EMPTY_SUMMARY },
    { date: '2026-11-10', weekday: 2, blocks: [], summary: EMPTY_SUMMARY },
    { date: '2026-11-11', weekday: 3, blocks: [FIXED_BLOCK, STUDY_BLOCK], summary: SUMMARY },
    { date: '2026-11-12', weekday: 4, blocks: [], summary: EMPTY_SUMMARY },
    { date: '2026-11-13', weekday: 5, blocks: [], summary: EMPTY_SUMMARY },
    { date: '2026-11-14', weekday: 6, blocks: [], summary: EMPTY_SUMMARY },
    { date: '2026-11-15', weekday: 7, blocks: [], summary: EMPTY_SUMMARY },
  ],
  tasks: [TASK_A, TASK_B],
  unscheduledTaskIds: [TASK_B.id],
  summary: SUMMARY,
};

const EMPTY_TASK_DRAFT = {
  title: '',
  subject: '',
  materialRef: '',
  completionCriteria: '',
  estimatedMinutes: '',
  prerequisites: [],
};

/** The day fixture with English task/block content, for the locale audit. */
function englishDay() {
  const serialized = JSON.stringify(DAY)
    .replaceAll('数学分析 第3章 习题', 'Calculus ch.3 exercises')
    .replaceAll('数学分析 第三版 第3章', 'Calculus, 3rd ed., ch.3')
    .replaceAll('高等数学课', 'Calculus lecture')
    .replaceAll('做完 1-20 题', 'Finish 1-20')
    .replaceAll('英语阅读', 'English reading')
    .replaceAll('"数学"', '"Math"')
    .replaceAll('"英语"', '"English"');
  return JSON.parse(serialized);
}

/**
 * View props for the fixture day/week.
 * @param {object} [overrides] - Prop overrides.
 * @returns {object} Complete props object.
 */
function viewProps(overrides = {}) {
  return {
    create,
    t: translator('zh'),
    view: { phase: 'ready', value: DAY, revision: 5 },
    mode: 'day',
    date: '2026-11-11',
    taskDraft: EMPTY_TASK_DRAFT,
    taskEditingId: null,
    blockDraft: null,
    notice: null,
    onMode: () => {},
    onPrev: () => {},
    onNext: () => {},
    onToday: () => {},
    onRefresh: () => {},
    onRetry: () => {},
    onOpenDay: () => {},
    onTaskDraft: () => {},
    onTaskPrerequisites: () => {},
    onTaskSubmit: () => {},
    onTaskEdit: () => {},
    onTaskCancel: () => {},
    onTaskDelete: () => {},
    onBlockAdd: () => {},
    onBlockEdit: () => {},
    onBlockDraft: () => {},
    onBlockSubmit: () => {},
    onBlockCancel: () => {},
    onBlockDelete: () => {},
    ...overrides,
  };
}

describe('workbench page definition', () => {
  it('satisfies the { key, order, label, Page } contract', () => {
    assert.equal(page.key, 'workbench');
    assert.equal(page.order, 10);
    assert.equal(page.label, 'workbench.panel');
    assert.equal(typeof page.Page, 'function');
    assert.ok(dictionary.zh[page.label], 'label 必须是字典里的文案键');
  });

  it('renders the loading state before the first read resolves', () => {
    const tree = page.Page({ t: translator('zh'), call: () => new Promise(() => {}), actions: {} });
    assert.match(text(tree), /正在读取工作台…/);
    assert.ok(find(tree, node => node.props['data-testid'] === 'study-loading'));
  });
});

describe('WorkbenchView states', () => {
  it('renders the empty state', () => {
    const tree = WorkbenchView(viewProps({ view: { phase: 'empty' } }));
    assert.match(text(tree), /还没有任务或时间块/);
    assert.ok(find(tree, node => node.props['data-testid'] === 'study-empty'));
  });

  it('renders a failed read with the retry control wired', () => {
    let retried = 0;
    const tree = WorkbenchView(viewProps({
      view: { phase: 'error', message: 'HTTP 503' },
      onRetry: () => { retried += 1; },
    }));
    assert.match(text(tree), /读取学习数据失败：HTTP 503/);
    const retry = find(tree, node => node.props['data-testid'] === 'workbench-retry');
    assert.ok(retry);
    retry.props.onClick();
    assert.equal(retried, 1);
  });

  it('renders the day view with tasks, blocks, and the fixed/study split', () => {
    const tree = WorkbenchView(viewProps());
    const body = text(tree);
    assert.match(body, /工作台/);
    assert.match(body, /2026-11-11 周三/);
    assert.match(body, /学习安排/);
    assert.match(body, /固定课程/);
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-summary-study').children[0], '1 块 · 60 分钟 · 1 个任务');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-summary-fixed').children[0], '1 块 · 90 分钟 · 1 个任务');
    assert.match(body, /固定课程与休息不计入学习完成量/);

    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-block-time-block_fixed').children[0], '08:00–09:30');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-block-title-block_fixed').children[0], '高等数学课');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-block-kind-block_fixed').children[0], '固定课程');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-block-kind-block_study').children[0], '学习');

    const scheduled = find(tree, node => node.props['data-testid'] === 'workbench-scheduled-tasks');
    const unscheduled = find(tree, node => node.props['data-testid'] === 'workbench-unscheduled-tasks');
    assert.ok(find(scheduled, node => node.props['data-testid'] === `workbench-task-${TASK_A.id}`));
    assert.ok(find(unscheduled, node => node.props['data-testid'] === `workbench-task-${TASK_B.id}`));
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-estimate-task_a').children[0], '90 分钟');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-prerequisites-task_b').children[0], '前置任务 数学分析 第3章 习题');
  });

  it('shows the plan tasks for the day with their project and opens a time block for one', () => {
    const planned = { ...TASK_A, scheduledDate: '2026-11-11', projectId: 'proj_1', projectTitle: '数学练习册' };
    const another = { ...TASK_B, scheduledDate: '2026-11-14', projectId: 'proj_1', projectTitle: '数学练习册' };
    const day = { ...DAY, tasks: [planned, another], unscheduledTaskIds: [another.id] };
    const scheduled = [];
    const tree = WorkbenchView(viewProps({
      view: { phase: 'ready', value: day, revision: 5 },
      onScheduleTask: task => scheduled.push(task.id),
    }));

    const plan = find(tree, node => node.props['data-testid'] === 'workbench-plan');
    assert.ok(plan, '计划里的任务需要单独一组');
    assert.match(text(plan), /今日计划/);
    assert.match(text(plan), /数学分析 第3章 习题/);
    assert.doesNotMatch(text(plan), /英语阅读/, '其他日期的任务不进入今日计划');
    assert.match(text(plan), /项目：数学练习册/);
    assert.match(text(plan), /已排：2026-11-11 10:00–11:00/);

    find(tree, node => node.props['data-testid'] === 'workbench-plan-schedule-task_a').props.onClick();
    assert.deepEqual(scheduled, ['task_a']);

    // A task dated another day keeps its date in the ordinary list instead of
    // silently appearing as today's work.
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-date-task_b').children[0], '计划日期 2026-11-14');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-scheduled-tasks'), undefined);
    assert.ok(find(find(tree, node => node.props['data-testid'] === 'workbench-unscheduled-tasks'), node => node.props['data-testid'] === 'workbench-task-task_b'));
  });

  it('renders the week view with seven days and opens one day', () => {
    const opened = [];
    const tree = WorkbenchView(viewProps({
      view: { phase: 'ready', value: WEEK, revision: 6 },
      mode: 'week',
      date: '2026-11-09',
      onOpenDay: date => opened.push(date),
    }));
    const body = text(tree);
    assert.match(body, /2026-11-09 — 2026-11-15/);
    assert.equal(findAll(tree, node => typeof node.props['data-testid'] === 'string' && node.props['data-testid'].startsWith('workbench-day-')).length, 7);
    const open = find(tree, node => node.props['data-testid'] === 'workbench-open-day-2026-11-12');
    assert.ok(open);
    open.props.onClick();
    assert.deepEqual(opened, ['2026-11-12']);
  });

  it('renders the same facts in English without Chinese text', () => {
    const tree = WorkbenchView(viewProps({
      t: translator('en'),
      view: { phase: 'ready', value: englishDay(), revision: 5 },
    }));
    const body = text(tree);
    assert.match(body, /Workbench/);
    assert.match(body, /Study/);
    assert.match(body, /Fixed courses and rest never count/);
    assert.doesNotMatch(body, /[\u4e00-\u9fff]/);
  });

  it('wires the mode, date, task, and block controls', () => {
    const events = [];
    const tree = WorkbenchView(viewProps({
      onMode: mode => events.push(`mode:${mode}`),
      onPrev: () => events.push('prev'),
      onNext: () => events.push('next'),
      onToday: () => events.push('today'),
      onRefresh: () => events.push('refresh'),
      onTaskEdit: task => events.push(`edit-task:${task.id}`),
      onTaskDelete: task => events.push(`delete-task:${task.id}`),
      onBlockAdd: () => events.push('add-block'),
      onBlockEdit: block => events.push(`edit-block:${block.id}`),
      onBlockDelete: block => events.push(`delete-block:${block.id}`),
    }));
    find(tree, node => node.props['data-testid'] === 'workbench-mode-week').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-prev').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-next').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-today').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-refresh').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-task-edit-task_a').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-task-delete-task_a').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-block-add').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-block-edit-block_study').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-block-delete-block_study').props.onClick();
    assert.deepEqual(events, [
      'mode:week', 'prev', 'next', 'today', 'refresh',
      'edit-task:task_a', 'delete-task:task_a', 'add-block',
      'edit-block:block_study', 'delete-block:block_study',
    ]);
  });

  it('submits both forms and edits task fields through the callbacks', () => {
    const events = [];
    let taskDraft = { ...EMPTY_TASK_DRAFT, title: '新任务', estimatedMinutes: '60' };
    const blockDraft = {
      id: null, date: '2026-11-11', start: '14:00', end: '15:00', fixed: false, taskId: '', title: '复盘', note: '',
    };
    const tree = WorkbenchView(viewProps({
      taskDraft,
      blockDraft,
      onTaskSubmit: event => { event.preventDefault(); events.push('submit-task'); },
      onTaskDraft: (field, value) => { taskDraft = { ...taskDraft, [field]: value }; events.push(`task:${field}=${value}`); },
      onBlockSubmit: event => { event.preventDefault(); events.push('submit-block'); },
      onBlockDraft: (field, value) => events.push(`block:${field}=${value}`),
    }));
    const taskForm = find(tree, node => node.props['data-testid'] === 'workbench-task-form');
    assert.ok(taskForm);
    taskForm.props.onSubmit({ preventDefault() {} });
    assert.deepEqual(events, ['submit-task']);

    const titleInput = find(taskForm, node => node.type === 'input' && node.props.name === 'title');
    titleInput.props.onChange({ target: { value: '改名' } });
    assert.ok(events.includes('task:title=改名'));

    const blockForm = find(tree, node => node.props['data-testid'] === 'workbench-block-form');
    assert.ok(blockForm);
    blockForm.props.onSubmit({ preventDefault() {} });
    assert.ok(events.includes('submit-block'));
    const fixedInput = find(blockForm, node => node.type === 'input' && node.props.name === 'fixed');
    fixedInput.props.onChange({ target: { checked: true } });
    assert.ok(events.includes('block:fixed=true'));
  });
});

describe('optimistic state transforms', () => {
  it('adds a pending task to the list and the unscheduled group', () => {
    const task = { ...TASK_B, id: 'optimistic-task-1', title: '刚创建', pending: true };
    const next = optimisticTaskCreate({ phase: 'ready', value: DAY }, task);
    assert.equal(next.value.tasks.length, 3);
    assert.deepEqual(next.value.unscheduledTaskIds, [TASK_B.id, task.id]);
    assert.equal(next.value.blocks, DAY.blocks);
  });

  it('patches a task and the task labels on its blocks', () => {
    const next = optimisticTaskUpdate({ phase: 'ready', value: DAY }, TASK_A.id, {
      title: '数学分析 第3章（改名）',
      subject: '数学分析',
      pending: true,
    });
    const task = next.value.tasks.find(item => item.id === TASK_A.id);
    assert.equal(task.title, '数学分析 第3章（改名）');
    assert.equal(task.pending, true);
    assert.equal(next.value.blocks[0].task.title, '数学分析 第3章（改名）');
    assert.equal(next.value.blocks[0].task.subject, '数学分析');
    assert.deepEqual(next.value.summary, SUMMARY);
  });

  it('deletes a task but keeps its blocks and marks the linked task deleted', () => {
    const next = optimisticTaskDelete({ phase: 'ready', value: DAY }, TASK_A.id);
    assert.deepEqual(next.value.tasks.map(task => task.id), [TASK_B.id]);
    assert.equal(next.value.blocks.length, 2);
    assert.equal(next.value.blocks[0].task.deleted, true);
    assert.deepEqual(next.value.summary, SUMMARY);
  });

  it('adds a study block and keeps fixed time out of the study summary', () => {
    const study = {
      ...STUDY_BLOCK,
      id: 'optimistic-block-study',
      start: '13:00',
      end: '13:45',
      startMinute: 780,
      endMinute: 825,
      minutes: 45,
      pending: true,
    };
    const next = optimisticBlockCreate({ phase: 'ready', value: DAY }, study);
    assert.deepEqual(next.value.blocks.map(block => block.id), ['block_fixed', 'block_study', 'optimistic-block-study']);
    assert.deepEqual(next.value.summary.study, { blockCount: 2, minuteCount: 105, taskCount: 1 });
    assert.deepEqual(next.value.summary.fixed, { blockCount: 1, minuteCount: 90, taskCount: 1 });

    const fixed = {
      ...FIXED_BLOCK,
      id: 'optimistic-block-fixed',
      start: '18:00',
      end: '19:00',
      startMinute: 1080,
      endMinute: 1140,
      minutes: 60,
      pending: true,
    };
    const withFixed = optimisticBlockCreate(next, fixed);
    assert.deepEqual(withFixed.value.summary.study, { blockCount: 2, minuteCount: 105, taskCount: 1 });
    assert.deepEqual(withFixed.value.summary.fixed, { blockCount: 2, minuteCount: 150, taskCount: 1 });
  });

  it('moves a block to another day and removes it from the current day view', () => {
    const next = optimisticBlockUpdate({ phase: 'ready', value: DAY }, STUDY_BLOCK.id, {
      date: '2026-11-12',
      start: '09:00',
      end: '09:30',
      startMinute: 540,
      endMinute: 570,
      minutes: 30,
      pending: true,
    });
    assert.deepEqual(next.value.blocks.map(block => block.id), [FIXED_BLOCK.id]);
    assert.deepEqual(next.value.summary.study, { blockCount: 0, minuteCount: 0, taskCount: 0 });
    assert.deepEqual(next.value.unscheduledTaskIds, [TASK_B.id]);

    const weekly = optimisticBlockUpdate({ phase: 'ready', value: WEEK }, STUDY_BLOCK.id, {
      date: '2026-11-12',
      start: '09:00',
      end: '09:30',
      startMinute: 540,
      endMinute: 570,
      minutes: 30,
      pending: true,
    });
    assert.deepEqual(weekly.value.days[2].blocks.map(block => block.id), [FIXED_BLOCK.id]);
    assert.deepEqual(weekly.value.days[3].blocks.map(block => block.id), [STUDY_BLOCK.id]);
  });

  it('deletes a block and recomputes the summaries', () => {
    const next = optimisticBlockDelete({ phase: 'ready', value: DAY }, STUDY_BLOCK.id);
    assert.deepEqual(next.value.blocks.map(block => block.id), [FIXED_BLOCK.id]);
    assert.deepEqual(next.value.summary.study, { blockCount: 0, minuteCount: 0, taskCount: 0 });
    assert.deepEqual(next.value.summary.fixed, { blockCount: 1, minuteCount: 90, taskCount: 1 });
    assert.deepEqual(next.value.unscheduledTaskIds, [TASK_B.id]);
  });

  it('counts only flexible blocks as study work', () => {
    assert.deepEqual(summarizeBlocks([FIXED_BLOCK, STUDY_BLOCK]), SUMMARY);
    assert.deepEqual(summarizeBlocks([]), EMPTY_SUMMARY);
  });
});

describe('runOptimistic', () => {
  it('renders the optimistic state, then refreshes after a successful write', async () => {
    const calls = [];
    const events = [];
    const snapshot = { phase: 'ready', value: DAY, revision: 5 };
    const optimistic = { ...snapshot, value: { ...DAY, tasks: [...DAY.tasks, TASK_B] } };
    const result = await runOptimistic({
      setView: view => calls.push(view),
      snapshot,
      optimistic,
      work: async () => { events.push('work'); return 'saved'; },
      refresh: async () => { events.push('refresh'); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.value, 'saved');
    assert.deepEqual(calls, [optimistic]);
    assert.deepEqual(events, ['work', 'refresh']);
  });

  it('restores the snapshot and reports the error when the write fails', async () => {
    const calls = [];
    const errors = [];
    const snapshot = { phase: 'ready', value: DAY, revision: 5 };
    const optimistic = { ...snapshot, value: { ...DAY, tasks: [] } };
    const result = await runOptimistic({
      setView: view => calls.push(view),
      snapshot,
      optimistic,
      work: async () => { throw new Error('service unavailable'); },
      refresh: async () => { throw new Error('refresh must not run'); },
      onError: error => errors.push(error.message),
      describe: error => error.message,
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].value, snapshot.value);
    assert.equal(calls[1].error, 'service unavailable');
    assert.deepEqual(errors, ['service unavailable']);
  });

  it('does not roll back a committed write when the refresh fails', async () => {
    const calls = [];
    const errors = [];
    const snapshot = { phase: 'ready', value: DAY, revision: 5 };
    const optimistic = { ...snapshot, value: { ...DAY, tasks: [...DAY.tasks, TASK_B] } };
    const result = await runOptimistic({
      setView: view => calls.push(view),
      snapshot,
      optimistic,
      work: async () => 'saved',
      refresh: async () => { throw new Error('refresh failed'); },
      onError: error => errors.push(error.message),
      describe: error => error.message,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].value, optimistic.value);
    assert.equal(calls[1].error, 'refresh failed');
    assert.deepEqual(errors, []);
  });
});
