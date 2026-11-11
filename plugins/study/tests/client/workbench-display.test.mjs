/**
 * The workbench display switch: the full editor and the compact today view.
 * The view is rendered under the React stub, so the states are asserted
 * without a browser.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from './support/react-stub.mjs';

installReactStub();

const {
  COMPACT_BLOCK_LIMIT,
  DISPLAY_KEY,
  WorkbenchView,
  readDisplayMode,
  writeDisplayMode,
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
 * Find every element matching a predicate.
 * @param {unknown} node - Element node, string, or array.
 * @param {(node: object) => boolean} predicate - Test.
 * @returns {object[]} Matches.
 */
function findAll(node, predicate) {
  const found = [];
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (predicate(value)) found.push(value);
    value.children.forEach(walk);
  };
  walk(node);
  return found;
}

const EMPTY_SUMMARY = { study: { blockCount: 0, minuteCount: 0, taskCount: 0 }, fixed: { blockCount: 0, minuteCount: 0, taskCount: 0 } };

/** A Web Storage stand-in. */
function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
  };
}

/** View props with the fields the compact display reads. */
function viewProps(overrides = {}) {
  return {
    create,
    t: translator('zh'),
    view: { phase: 'loading' },
    mode: 'day',
    date: '2026-11-11',
    display: 'full',
    overview: { phase: 'loading' },
    taskDraft: { title: '', subject: '', materialRef: '', completionCriteria: '', estimatedMinutes: '', prerequisites: [] },
    taskEditingId: null,
    blockDraft: null,
    notice: null,
    onDisplay: () => {},
    onMode: () => {},
    onPrev: () => {},
    onNext: () => {},
    onToday: () => {},
    onRefresh: () => {},
    onCompactRefresh: () => {},
    onRetry: () => {},
    ...overrides,
  };
}

const BLOCKS = Array.from({ length: 8 }, (_, index) => ({
  id: `block_${index}`,
  start: '09:00',
  end: '10:00',
  fixed: index === 0,
  title: index === 1 ? null : `Block ${index}`,
  task: index === 1 ? null : { title: `Task ${index}` },
}));

const OVERVIEW = {
  phase: 'ready',
  value: {
    date: '2026-11-11',
    weekday: 3,
    blocks: BLOCKS,
    tasks: [],
    summary: { study: { blockCount: 7, minuteCount: 420, taskCount: 2 }, fixed: { blockCount: 1, minuteCount: 60, taskCount: 0 } },
  },
};

describe('display preference', () => {
  it('defaults to full and accepts compact', () => {
    assert.equal(readDisplayMode(fakeStorage()), 'full');
    assert.equal(readDisplayMode(fakeStorage({ [DISPLAY_KEY]: 'compact' })), 'compact');
    assert.equal(readDisplayMode(fakeStorage({ [DISPLAY_KEY]: 'wide' })), 'full');
  });

  it('writes only a supported mode', () => {
    const storage = fakeStorage();
    assert.equal(writeDisplayMode(storage, 'compact'), true);
    assert.equal(storage.values.get(DISPLAY_KEY), 'compact');
    assert.equal(writeDisplayMode(storage, 'wide'), false);
    assert.equal(storage.values.get(DISPLAY_KEY), 'compact');
  });
});

describe('display switch', () => {
  it('marks the full view active and switches from its toolbar', () => {
    let next;
    const tree = WorkbenchView(viewProps({ onDisplay: value => { next = value; } }));
    assert.equal(tree.props['data-display'], 'full');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-display-full').props['aria-pressed'], true);
    find(tree, node => node.props['data-testid'] === 'workbench-display-compact').props.onClick();
    assert.equal(next, 'compact');
    assert.ok(find(tree, node => node.props['data-testid'] === 'workbench-mode-day'));
  });

  it('shows the compact today view without the full editor or mode controls', () => {
    let next;
    const tree = WorkbenchView(viewProps({
      display: 'compact',
      overview: { phase: 'ready', value: { ...OVERVIEW.value, blocks: [], summary: EMPTY_SUMMARY } },
      onDisplay: value => { next = value; },
    }));
    assert.equal(tree.props['data-display'], 'compact');
    assert.match(text(tree), /缩略显示只展示今天/);
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-mode-day'), undefined);
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-mode-week'), undefined);
    const empty = find(tree, node => node.props['data-testid'] === 'workbench-compact-empty');
    assert.equal(empty.children[0], '今天还没有安排。');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-compact-date').children[0], '2026-11-11 周三');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-compact-summary-study').children[0], '0 块 · 0 分钟 · 0 个任务');
    find(tree, node => node.props['data-testid'] === 'workbench-compact-full').props.onClick();
    assert.equal(next, 'full');
  });

  it('lists the first blocks with badges and points at the full display', () => {
    const tree = WorkbenchView(viewProps({ display: 'compact', overview: OVERVIEW }));
    const rows = findAll(tree, node => node.type === 'li');
    assert.equal(rows.length, COMPACT_BLOCK_LIMIT);
    assert.equal(text(rows[0]), '09:00–10:00Block 0固定课程');
    assert.match(text(rows[1]), /未命名时间块/);
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-compact-more').children[0], '完整显示里还有 2 个时间块');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-compact-summary-study').children[0], '7 块 · 420 分钟 · 2 个任务');
    assert.equal(find(tree, node => node.props['data-testid'] === 'workbench-compact-summary-fixed').children[0], '1 块 · 60 分钟 · 0 个任务');
  });

  it('shows the plan tasks due today above the blocks', () => {
    const overview = {
      phase: 'ready',
      value: {
        ...OVERVIEW.value,
        tasks: [
          { id: 'task_plan', title: '读第三章', projectTitle: '教材章节', estimatedMinutes: 45, scheduledDate: '2026-11-11' },
          { id: 'task_later', title: '周五任务', projectTitle: '练习册', estimatedMinutes: 30, scheduledDate: '2026-11-13' },
        ],
        progress: { task_plan: { status: 'done', confirmed: true } },
      },
    };
    const tree = WorkbenchView(viewProps({ display: 'compact', overview }));
    const card = find(tree, node => node.props['data-testid'] === 'workbench-compact-plan');
    assert.ok(card);
    assert.match(text(card), /今日计划/);
    assert.match(text(card), /读第三章/);
    assert.match(text(card), /项目：教材章节/);
    assert.match(text(card), /完成/);
    assert.doesNotMatch(text(card), /周五任务/);
    assert.match(text(card), /具体时间到完整工作台安排/);
  });

  it('renders loading and retry states for the compact read', () => {
    const loading = WorkbenchView(viewProps({ display: 'compact' }));
    assert.match(text(loading), /正在读取今日安排/);
    let retried = 0;
    const failed = WorkbenchView(viewProps({
      display: 'compact',
      overview: { phase: 'error', message: 'HTTP 503' },
      onCompactRefresh: () => { retried += 1; },
    }));
    assert.match(text(failed), /读取学习数据失败：HTTP 503/);
    find(failed, node => node.props['data-testid'] === 'workbench-compact-retry').props.onClick();
    assert.equal(retried, 1);
  });

  it('keeps the compact view in English when the locale is English', () => {
    const tree = WorkbenchView(viewProps({
      display: 'compact',
      t: translator('en'),
      overview: { phase: 'ready', value: { ...OVERVIEW.value, blocks: [], summary: EMPTY_SUMMARY } },
    }));
    const body = text(tree);
    assert.match(body, /A condensed view of today/);
    assert.match(body, /Compact shows today only/);
    assert.match(body, /Nothing is scheduled today/);
    assert.match(body, /Switch to full display/);
  });
});
