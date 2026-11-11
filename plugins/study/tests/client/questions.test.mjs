/**
 * The questions page: definition shape and pure view states in both locales.
 * Requests are not issued here; the page body owns them, while `QuestionsView`
 * renders from plain props.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from './support/react-stub.mjs';

installReactStub();

const { default: page, QuestionsView } = await import('../../client/pages/questions.js');
const { mergeMessages } = await import('../../client/lib/definitions.js');
const common = (await import('../../client/messages/common.js')).default;
const questions = (await import('../../client/messages/questions.js')).default;

const dictionary = mergeMessages([
  { file: 'common', dictionary: common },
  { file: 'questions', dictionary: questions },
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

/** Common props for every state. */
function props(overrides = {}) {
  return {
    create,
    t: translator('zh'),
    view: { phase: 'loading' },
    detail: null,
    summary: { phase: 'loading' },
    filters: { range: 7, subject: '', resolution: '', query: '' },
    queryDraft: '',
    subjects: ['数学'],
    selection: [],
    notice: null,
    busy: false,
    onRange: noop,
    onSubject: noop,
    onResolution: noop,
    onQueryDraft: noop,
    onQuerySubmit: noop,
    onRefresh: noop,
    onRetry: noop,
    onSelect: noop,
    onCloseDetail: noop,
    onToggleSelect: noop,
    onMerge: noop,
    onSplit: noop,
    ...overrides,
  };
}

const UNIT = {
  id: 'ep-1',
  openedAt: '2026-11-11T01:00:00.000Z',
  closedAt: '2026-11-11T01:10:00.000Z',
  subject: '数学',
  status: 'closed',
  problemCount: 1,
  resolution: 'understood',
  problems: [{ text: '怎么解 2x + 3 = 7？', status: 'open', reaskCount: 0 }],
};

const DETAIL = {
  phase: 'ready',
  value: {
    episode: {
      id: 'ep-1',
      openedAt: '2026-11-11T01:00:00.000Z',
      subject: '数学',
      status: 'closed',
      problemCount: 1,
      resolution: 'understood',
    },
    problems: [{ id: 'p-1', text: '怎么解 2x + 3 = 7？', reaskCount: 0 }],
    turns: [
      { id: 't-1', position: 0, role: 'ask', at: '2026-11-11T01:00:00.000Z', text: '怎么解 2x + 3 = 7？', ambiguous: false },
      { id: 't-2', position: 1, role: 'confirm', at: '2026-11-11T01:02:00.000Z', text: '懂了，谢谢', ambiguous: false },
    ],
    signals: [{ id: 'sig-1', kind: 'understood', at: '2026-11-11T01:02:00.000Z' }],
  },
};

const SUMMARY = {
  phase: 'ready',
  value: {
    items: [{ summaryId: 'sum-1', day: '2026-11-11', text: '今天 1 次问答、1 道题，1 次闭环、0 次未闭环；重问 0 次。' }],
    threads: [{ topicId: 'subject:数学', data: { subject: '数学', episodes: 1, problems: 1 } }],
    window: {
      window: { day: '2026-11-11', status: 'open', note: null },
      pending: { seal: 1, summarize: 0 },
    },
  },
};

describe('questions page definition', () => {
  it('satisfies the { key, order, label, Page } contract', () => {
    assert.equal(page.key, 'questions');
    assert.equal(page.order, 70);
    assert.equal(page.label, 'questions.panel');
    assert.equal(typeof page.Page, 'function');
    assert.ok(dictionary.zh[page.label]);
    assert.ok(dictionary.en[page.label]);
  });

  it('renders the loading state before the first read resolves', () => {
    const tree = QuestionsView(props());
    assert.match(text(tree), /正在读取问答单元/);
  });

  it('renders the empty state and the count when a read returns nothing', () => {
    const tree = QuestionsView(props({ view: { phase: 'ready', value: { items: [], total: 0 } } }));
    assert.ok(find(tree, node => node.props['data-testid'] === 'questions-empty'));
    assert.match(text(tree), /共 0 个单元/);
  });

  it('renders the error state with a retry control', () => {
    const tree = QuestionsView(props({ view: { phase: 'error', message: '数据库不可用' } }));
    assert.match(text(tree), /数据库不可用/);
    assert.match(text(tree), /重试/);
  });

  it('renders units, day summaries, threads, and the current window', () => {
    const tree = QuestionsView(props({
      t: translator('en'),
      view: { phase: 'ready', value: { items: [UNIT], total: 1 } },
      summary: SUMMARY,
    }));
    const rendered = text(tree);
    assert.match(rendered, /怎么解 2x \+ 3 = 7/);
    assert.match(rendered, /Resolved/);
    assert.match(rendered, /Current window: 2026-11-11 · open/);
    assert.match(rendered, /Waiting to seal 1, summarize 0/);
    assert.match(rendered, /数学/);
    assert.match(rendered, /数学: 1 units, 1 problems over 30 days/);
    assert.ok(find(tree, node => node.props['data-testid'] === 'questions-row-ep-1'));
  });

  it('asks for two units before enabling merge', () => {
    const one = QuestionsView(props({ view: { phase: 'ready', value: { items: [UNIT], total: 1 } }, selection: ['ep-1'] }));
    const oneButton = find(one, node => node.props['data-testid'] === 'questions-merge');
    assert.equal(oneButton.props.disabled, true);
    assert.match(text(one), /已选 1 个/);

    const two = QuestionsView(props({
      view: { phase: 'ready', value: { items: [UNIT], total: 1 } },
      selection: ['ep-1', 'ep-2'],
    }));
    const twoButton = find(two, node => node.props['data-testid'] === 'questions-merge');
    assert.equal(twoButton.props.disabled, false);
  });

  it('shows detail signals and offers split only after the first turn', () => {
    const tree = QuestionsView(props({ detail: DETAIL }));
    assert.ok(find(tree, node => node.props['data-testid'] === 'questions-split-t-2'));
    assert.equal(find(tree, node => node.props['data-testid'] === 'questions-split-t-1'), undefined);
    assert.match(text(tree), /已理解/);
    assert.match(text(tree), /懂了，谢谢/);
  });

  it('explains the 90-day retention instead of calling cleared text an error', () => {
    const value = {
      ...DETAIL.value,
      problems: [{ id: 'p-1', text: null, reaskCount: 0 }],
      turns: [{
        id: 't-1', position: 0, role: 'ask', at: '2026-11-11T01:00:00.000Z',
        text: null, textPrunedAt: '2026-12-01T00:00:00.000Z', ambiguous: false,
      }],
      signals: [],
    };
    const tree = QuestionsView(props({ detail: { phase: 'ready', value } }));
    const notice = find(tree, node => node.props['data-testid'] === 'questions-pruned-notice');
    assert.ok(notice);
    assert.match(text(notice), /90 天/);
    assert.match(text(tree), /正文已按 90 天保留策略清理/);
    assert.equal(text(tree).includes('没有记录到题目正文'), false);
  });
});
