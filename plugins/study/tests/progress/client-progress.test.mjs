/**
 * T06 workbench view evidence: progress badges, the independent pending
 * marker, quantity feedback, the completion card that excludes cancelled
 * tasks, the stale/overlap decisions, and the drag targets with their
 * immediate overlap hint. The pure view runs under the React stub, so no
 * browser is involved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';

installReactStub();

const {
  WorkbenchView,
  moveConflicts,
  summarizeProgress,
  optimisticProgressRecord,
  progressOf,
} = await import('../../client/pages/workbench.js');
const { mergeMessages } = await import('../../client/lib/definitions.js');
const common = (await import('../../client/messages/common.js')).default;
const workbench = (await import('../../client/messages/workbench.js')).default;

const dictionary = mergeMessages([{ file: 'common', dictionary: common }, { file: 'workbench', dictionary: workbench }]);
const EMPTY_SUMMARY = { study: { blockCount: 0, minuteCount: 0, taskCount: 0 }, fixed: { blockCount: 0, minuteCount: 0, taskCount: 0 } };

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

const TASK_A = {
  id: 'task_a', title: '数学分析 第3章 习题', subject: '数学', materialRef: null,
  completionCriteria: null, estimatedMinutes: 90, prerequisiteIds: [], prerequisites: [],
  deletedAt: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
};
const TASK_B = {
  id: 'task_b', title: '英语阅读', subject: '英语', materialRef: null,
  completionCriteria: null, estimatedMinutes: 30, prerequisiteIds: [], prerequisites: [],
  deletedAt: null, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
};
const BLOCK_A = {
  id: 'block_a', date: '2026-11-11', start: '10:00', end: '11:00', startMinute: 600, endMinute: 660,
  minutes: 60, fixed: false, taskId: TASK_A.id, title: null, note: null,
  task: { id: TASK_A.id, title: TASK_A.title, subject: TASK_A.subject, deleted: false },
  createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
};
const BLOCK_B = {
  id: 'block_b', date: '2026-11-12', start: '10:30', end: '11:30', startMinute: 630, endMinute: 690,
  minutes: 60, fixed: true, taskId: null, title: '高等数学课', note: null, task: null,
  createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
};
const PROGRESS_A = {
  recordId: 1, taskId: TASK_A.id, date: '2026-11-11', status: 'partial',
  quantityDone: 3, quantityTotal: 10, note: '做了 3 题', confirmed: false,
  actor: 'agent', at: '2026-11-11T08:00:00.000Z',
};
const COMPLETION = {
  taskCount: 2,
  counts: {
    unrecorded: 1, notStarted: 0, inProgress: 0, partial: 1, done: 0, cancelled: 0, pendingConfirmation: 1,
  },
  completion: {
    countedTasks: 2, completedTasks: 0, cancelledTasks: 0, pendingTasks: 1, unrecordedTasks: 1, rate: 0,
  },
};
const DAY = {
  date: '2026-11-11', weekday: 3, weekStart: '2026-11-09', weekEnd: '2026-11-15',
  blocks: [BLOCK_A], tasks: [TASK_A, TASK_B], unscheduledTaskIds: [TASK_B.id],
  summary: { study: { blockCount: 1, minuteCount: 60, taskCount: 1 }, fixed: { blockCount: 0, minuteCount: 0, taskCount: 0 } },
  progress: { [TASK_A.id]: PROGRESS_A },
  completion: COMPLETION,
};
const WEEK = {
  startDate: '2026-11-09', endDate: '2026-11-15',
  days: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'].map((date, index) => ({
    date,
    weekday: index + 1,
    blocks: date === '2026-11-11' ? [BLOCK_A] : (date === '2026-11-12' ? [BLOCK_B] : []),
    summary: EMPTY_SUMMARY,
  })),
  tasks: [TASK_A, TASK_B], unscheduledTaskIds: [TASK_B.id], summary: EMPTY_SUMMARY,
  progress: DAY.progress, completion: COMPLETION,
};

const EMPTY_TASK_DRAFT = {
  title: '', subject: '', materialRef: '', completionCriteria: '', estimatedMinutes: '', prerequisites: [],
};

/** The day fixture with English task and progress content, for the locale audit. */
function englishDay() {
  const serialized = JSON.stringify(DAY)
    .replaceAll('数学分析 第3章 习题', 'Calculus ch.3 exercises')
    .replaceAll('英语阅读', 'English reading')
    .replaceAll('"数学"', '"Math"')
    .replaceAll('"英语"', '"English"')
    .replaceAll('做了 3 题', 'Did 3 problems');
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
    stale: null,
    drag: null,
    progressDraft: null,
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
    onTaskToggleDone: () => {},
    onBlockAdd: () => {},
    onBlockEdit: () => {},
    onBlockDraft: () => {},
    onBlockSubmit: () => {},
    onBlockCancel: () => {},
    onBlockDelete: () => {},
    onBlockDragStart: () => {},
    onBlockDragEnd: () => {},
    onBlockDragOver: () => {},
    onBlockDrop: () => {},
    onProgressEdit: () => {},
    onProgressDraft: () => {},
    onProgressSubmit: () => {},
    onProgressCancel: () => {},
    onStaleRetry: () => {},
    onStaleDismiss: () => {},
    ...overrides,
  };
}

describe('progress rendering', () => {
  it('shows the recorded state, the pending marker, and quantity feedback', () => {
    const tree = WorkbenchView(viewProps());
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-progress-task_a').children[0], '部分完成');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-pending-task_a').children[0], '待确认');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-quantity-task_a').children[0], '3 / 10');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-done-task_a').props.checked, false);
  });

  it('does not infer "not studied" for an unchecked task', () => {
    const tree = WorkbenchView(viewProps());
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-progress-task_b'), undefined);
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-pending-task_b'), undefined);
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-task-quantity-task_b'), undefined);
    const row = find(tree, node => node.props['data-testid'] === `workbench-task-${TASK_B.id}`);
    assert.doesNotMatch(text(row), /未学习|未开始/);
  });

  it('renders the completion card with cancelled tasks excluded', () => {
    const tree = WorkbenchView(viewProps());
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-completion-rate').children[0], '完成率 0%');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-completion-counts').children[0], '完成 0 / 计入 2 个任务');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-completion-pending').children[0], '1 个待确认');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-completion-unrecorded').children[0], '1 个未记录');
    assert.match(text(find(tree, node => node.props['data-testid'] === 'workbench-completion-note')), /取消不计入完成率；未记录不等于未学习/);
  });

  it('wires the done checkbox and the progress editor', () => {
    const events = [];
    const tree = WorkbenchView(viewProps({
      onTaskToggleDone: (task, checked) => events.push(`done:${task.id}=${checked}`),
      onProgressEdit: task => events.push(`edit:${task.id}`),
    }));
    find(tree, node => node.props['data-testid'] === 'workbench-task-done-task_a').props.onChange({ target: { checked: true } });
    find(tree, node => node.props['data-testid'] === 'workbench-task-progress-edit-task_a').props.onClick();
    assert.deepEqual(events, ['done:task_a=true', 'edit:task_a']);
  });

  it('renders the progress editor for the active task', () => {
    const events = [];
    const tree = WorkbenchView(viewProps({
      progressDraft: {
        taskId: TASK_A.id, status: 'partial', quantityDone: '3', quantityTotal: '10', note: '做了 3 题',
      },
      onProgressSubmit: event => { event.preventDefault(); events.push('submit'); },
      onProgressDraft: (field, value) => events.push(`draft:${field}=${value}`),
      onProgressCancel: () => events.push('cancel'),
    }));
    const form = find(tree, node => node.props['data-testid'] === 'workbench-progress-form-task_a');
    assert.ok(form);
    form.props.onSubmit({ preventDefault() {} });
    assert.ok(events.includes('submit'));
    const status = find(form, node => node.type === 'select' && node.props.name === 'status');
    status.props.onChange({ target: { value: 'done' } });
    assert.ok(events.includes('draft:status=done'));
    find(form, node => node.type === 'button' && node.props['data-testid'] === 'workbench-progress-cancel').props.onClick();
    assert.ok(events.includes('cancel'));
  });
});

describe('stale and overlap decisions', () => {
  it('renders a stale revision notice with a resubmit control', () => {
    const events = [];
    const tree = WorkbenchView(viewProps({
      stale: {
        kind: 'stale',
        message: '学习数据已更新到修订 7。这次提交没有保存，已读取最新数据。',
        retry: { kind: 'block.move', payload: { id: BLOCK_A.id, date: '2026-11-12' } },
      },
      onStaleRetry: () => events.push('retry'),
      onStaleDismiss: () => events.push('dismiss'),
    }));
    assert.match(text(find(tree, node => node.props['data-testid'] === 'workbench-stale-banner')), /修订 7/);
    find(tree, node => node.props['data-testid'] === 'workbench-stale-retry').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-stale-dismiss').props.onClick();
    assert.deepEqual(events, ['retry', 'dismiss']);
  });

  it('asks before keeping an overlap and lists the conflicting block', () => {
    const events = [];
    const tree = WorkbenchView(viewProps({
      stale: {
        kind: 'overlap',
        message: '与 1 个时间块重叠。确认保留这次重叠吗？',
        conflicts: [{ id: BLOCK_B.id, start: '10:30', end: '11:30', title: '高等数学课' }],
        retry: { kind: 'block.move', payload: { id: BLOCK_A.id, date: '2026-11-12', allowOverlap: true } },
      },
      onStaleRetry: () => events.push('keep'),
      onStaleDismiss: () => events.push('cancel'),
    }));
    assert.match(text(tree), /10:30–11:30 高等数学课/);
    find(tree, node => node.props['data-testid'] === 'workbench-overlap-keep').props.onClick();
    find(tree, node => node.props['data-testid'] === 'workbench-overlap-cancel').props.onClick();
    assert.deepEqual(events, ['keep', 'cancel']);
  });
});

describe('drag rendering', () => {
  it('shows an immediate overlap hint on the hovered week day and drops there', () => {
    const events = [];
    const tree = WorkbenchView(viewProps({
      view: { phase: 'ready', value: WEEK, revision: 5 },
      mode: 'week',
      date: '2026-11-09',
      drag: {
        blockId: BLOCK_A.id,
        targetDate: '2026-11-12',
        conflicts: [{ id: BLOCK_B.id, start: '10:30', end: '11:30', title: '高等数学课' }],
      },
      onBlockDragOver: date => events.push(`over:${date}`),
      onBlockDrop: date => events.push(`drop:${date}`),
      onBlockDragStart: blockId => events.push(`start:${blockId}`),
    }));
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-overlap-hint-2026-11-12').children[0], '与 1 个时间块重叠');
    const target = find(tree, node => node.props['data-testid'] === 'workbench-day-2026-11-12');
    target.props.onDragOver({ preventDefault() {} });
    target.props.onDrop({ preventDefault() {} });
    const row = find(tree, node => node.props['data-testid'] === `workbench-block-${BLOCK_A.id}`);
    assert.equal(row.props.draggable, true);
    row.props.onDragStart({ dataTransfer: { setData() {} } });
    assert.deepEqual(events, [
      'over:2026-11-12', 'drop:2026-11-12', `start:${BLOCK_A.id}`,
    ]);
  });

  it('offers previous/next day drop strips while dragging in the day view', () => {
    const events = [];
    const tree = WorkbenchView(viewProps({
      drag: { blockId: BLOCK_A.id, targetDate: null, conflicts: [] },
      onBlockDrop: date => events.push(`drop:${date}`),
    }));
    find(tree, node => node.props['data-testid'] === 'workbench-drop-prev').props.onDrop({ preventDefault() {} });
    find(tree, node => node.props['data-testid'] === 'workbench-drop-next').props.onDrop({ preventDefault() {} });
    assert.deepEqual(events, ['drop:2026-11-10', 'drop:2026-11-12']);
  });
});

describe('progress state helpers', () => {
  it('summarizes the same rule the host uses', () => {
    const summary = summarizeProgress([TASK_A, TASK_B], DAY.progress);
    assert.deepEqual(summary, COMPLETION);

    const cancelled = { ...PROGRESS_A, status: 'cancelled', quantityDone: null, quantityTotal: null, confirmed: true };
    const done = { ...PROGRESS_A, status: 'done', quantityDone: 10, quantityTotal: 10, confirmed: true };
    const mixed = summarizeProgress([TASK_A, TASK_B], { [TASK_A.id]: done, [TASK_B.id]: cancelled });
    assert.deepEqual(mixed.completion, {
      countedTasks: 1, completedTasks: 1, cancelledTasks: 1, pendingTasks: 0, unrecordedTasks: 0, rate: 1,
    });
    assert.equal(mixed.counts.notStarted, 0);
  });

  it('merges a recorded progress into the optimistic view', () => {
    const record = {
      taskId: TASK_B.id, status: 'done', date: '2026-11-11', quantityDone: 1,
      quantityTotal: 1, note: null, confirmed: true,
    };
    const next = optimisticProgressRecord({ phase: 'ready', value: DAY }, record);
    assert.equal(progressOf(next.value, TASK_B.id).status, 'done');
    assert.equal(progressOf(next.value, TASK_B.id).pending, true);
    assert.equal(next.value.completion.completion.completedTasks, 1);
    assert.equal(next.value.completion.counts.unrecorded, 0);
  });

  it('finds the conflicts of a cross-day move without counting the dragged block', () => {
    const week = { phase: 'ready', value: WEEK };
    assert.deepEqual(moveConflicts(week, BLOCK_A.id, '2026-11-12').map(block => block.id), [BLOCK_B.id]);
    assert.deepEqual(moveConflicts(week, BLOCK_A.id, '2026-11-13'), []);
    assert.deepEqual(moveConflicts(week, BLOCK_A.id, '2026-11-11'), [], '同一天不算移动冲突');
    assert.deepEqual(moveConflicts({ phase: 'loading' }, BLOCK_A.id, '2026-11-12'), []);
  });

  it('renders the same facts in English without Chinese text', () => {
    const tree = WorkbenchView(viewProps({
      t: translator('en'),
      view: { phase: 'ready', value: englishDay(), revision: 5 },
      stale: {
        kind: 'overlap',
        message: '1 time block overlaps. Keep this overlap?',
        conflicts: [{ id: BLOCK_B.id, start: '10:30', end: '11:30', title: 'Calculus lecture' }],
        retry: { kind: 'block.move', payload: { id: BLOCK_A.id, date: '2026-11-12', allowOverlap: true } },
      },
    }));
    const body = text(tree);
    assert.match(body, /0% complete/);
    assert.match(body, /Keep overlap/);
    assert.doesNotMatch(body, /[\u4e00-\u9fff]/);
  });
});

