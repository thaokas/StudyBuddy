/**
 * The read-only `today` page: definition shape and every rendered state, in
 * both languages, from the real dictionary modules. States are produced by
 * the pure `TodayView`, so no browser and no renderer are involved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../../../study-outcomes/tests/client/support/react-stub.mjs';

installReactStub();

const { default: page, TodayView } = await import('../../client/pages/today.js');
const { mergeMessages } = await import('../../../../packages/study-client/definitions.js');
const { createActionRegistry } = await import('../../../../packages/study-client/actions.js');
const common = (await import('../../../../packages/study-messages/common.js')).default;
const today = (await import('../../client/messages/today.js')).default;
const refresh = (await import('../../client/actions/refresh.js')).default;

const dictionary = mergeMessages([{ file: 'common', dictionary: common }, { file: 'today', dictionary: today }]);

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

const registry = createActionRegistry([refresh]);
const actions = registry.forPage('today');

/** One realistic `kernel.status` payload. */
const STATUS = {
  revision: 7,
  blocked: null,
  database: { file: 'D:/StudyBuddy/.studybuddy/study/study.db', journalMode: 'wal', sizeBytes: 24576, coreSchemaVersion: 1, unknownModules: [] },
  modules: [{ id: 'kernel', deps: [], schemaVersion: 1, schemaStatements: 0 }, { id: 'memory', deps: [], schemaVersion: 1, schemaStatements: 3 }],
  namespaces: [{ ns: 'kernel', methods: ['status'], writes: [] }, { ns: 'memory', methods: ['list', 'remember'], writes: ['remember'] }],
  today: { date: '2026-11-10', snapshotAt: '2026-11-10T00:00:01.000Z', snapshotRevision: 7 },
  serverTime: '2026-11-10T01:00:00.000Z',
};

describe('today page definition', () => {
  it('satisfies the { key, order, label, Page } contract', () => {
    assert.equal(page.key, 'today');
    assert.equal(page.order, 20);
    assert.equal(page.label, 'today.panel');
    assert.equal(typeof page.Page, 'function');
    assert.ok(dictionary.zh[page.label], 'label 必须是字典里的文案键');
  });

  it('renders the loading state before the first read resolves', () => {
    const tree = page.Page({ t: translator('zh'), call: () => new Promise(() => {}), actions: registry });
    assert.match(text(tree), /正在读取学习数据…/);
    assert.ok(find(tree, node => node.props['data-testid'] === 'study-loading'));
  });
});

describe('TodayView', () => {
  it('renders live status values in Chinese', () => {
    const tree = TodayView({ create, t: translator('zh'), view: { phase: 'ready', value: STATUS, revision: STATUS.revision }, actions, dispatch: () => {} });
    const body = text(tree);
    assert.match(body, /今日学习/);
    assert.match(body, /数据修订/);
    assert.equal(find(tree, node => node.props['data-testid'] === 'study-revision').children[0], '7');
    assert.equal(find(tree, node => node.props['data-testid'] === 'study-date').children[0], '2026-11-10');
    assert.match(find(tree, node => node.props['data-testid'] === 'study-storage').children[0], /study\.db$/);
    assert.equal(find(tree, node => node.props['data-testid'] === 'study-size').children[0], '24.0 KB');
    assert.match(find(tree, node => node.props['data-testid'] === 'study-modules').children[0], /kernel, memory/);
    assert.match(find(tree, node => node.props['data-testid'] === 'study-namespaces').children[0], /kernel, memory/);
    assert.match(find(tree, node => node.props['data-testid'] === 'study-snapshot').children[0], /2026/);
    assert.equal(find(tree, node => node.props['data-testid'] === 'study-blocked'), undefined);
  });

  it('renders the same facts in English', () => {
    const tree = TodayView({ create, t: translator('en'), view: { phase: 'ready', value: STATUS, revision: STATUS.revision }, actions, dispatch: () => {} });
    assert.match(text(tree), /Today's study/);
    assert.match(text(tree), /Data revision/);
    assert.doesNotMatch(text(tree), /[\u4e00-\u9fff]/, '英文界面下不应出现中文');
  });

  it('shows the snapshot placeholder when today has no snapshot row', () => {
    const value = { ...STATUS, today: { ...STATUS.today, snapshotAt: null } };
    const tree = TodayView({ create, t: translator('zh'), view: { phase: 'ready', value, revision: 7 }, actions, dispatch: () => {} });
    assert.equal(find(tree, node => node.props['data-testid'] === 'study-snapshot').children[0], '尚未生成');
  });

  it('surfaces a blocked kernel instead of hiding it', () => {
    const value = { ...STATUS, blocked: { reason: 'module-schema-mismatch' } };
    const tree = TodayView({ create, t: translator('zh'), view: { phase: 'ready', value, revision: 7 }, actions, dispatch: () => {} });
    const warning = find(tree, node => node.props['data-testid'] === 'study-blocked');
    assert.ok(warning);
    assert.match(text(warning), /写入已停用：module-schema-mismatch/);
  });

  it('renders the empty state', () => {
    const tree = TodayView({ create, t: translator('zh'), view: { phase: 'empty' }, actions, dispatch: () => {} });
    assert.match(text(tree), /还没有学习数据。/);
  });

  it('renders a failed read with the localized prefix and the host message', () => {
    const tree = TodayView({ create, t: translator('zh'), view: { phase: 'error', message: 'HTTP 503' }, actions, dispatch: () => {} });
    assert.match(text(tree), /读取学习数据失败：HTTP 503/);
    assert.equal(find(tree, node => node.props.role === 'alert').props['data-testid'], 'study-error');
  });

  it('renders the page actions and dispatches them by id', () => {
    const dispatched = [];
    const tree = TodayView({
      create, t: translator('zh'), view: { phase: 'ready', value: STATUS, revision: 7 },
      actions, dispatch: id => dispatched.push(id),
    });
    const buttons = findAll(tree, node => node.type === 'button');
    assert.deepEqual(buttons.map(node => node.props['data-action']), ['refresh-today']);
    assert.match(text(buttons[0]), /刷新/);
    buttons[0].props.onClick();
    assert.deepEqual(dispatched, ['refresh-today']);
  });

  it('adds a later action without touching the page', () => {
    const extra = createActionRegistry([refresh, { id: 'later', page: 'today', label: 'today.title', run: () => {} }]);
    const tree = TodayView({
      create, t: translator('zh'), view: { phase: 'ready', value: STATUS, revision: 7 },
      actions: extra.forPage('today'), dispatch: () => {},
    });
    assert.deepEqual(findAll(tree, node => node.type === 'button').map(node => node.props['data-action']), ['refresh-today', 'later']);
  });
});
