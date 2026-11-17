/**
 * Client plugin assembly: contribution validation, registration into the
 * `main` and `sidebar.panellist` slots, locale switching, and the action
 * registry. The last case assembles the real client tree the build ships.
 */
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { installReactStub } from './support/react-stub.mjs';

installReactStub();

const CLIENT_ROOT = fileURLToPath(new URL('../../client/', import.meta.url));
const { createPlugin, NS } = await import('../../../study-core/client/plugin.js');
const { createPlugin: createShellPlugin } = await import('../../client/plugin.js');
const sharedMessages = await Promise.all(['common', 'daily'].map(async file => ({ file, dictionary: (await import(`../../../../packages/study-messages/${file}.js`)).default })));
const { createStudyRefresh } = await import('../../../study-core/client/lib/refresh.js');

const DICTIONARY = {
  file: 'common',
  dictionary: {
    en: { 'common.loading': 'Loading…', 'today.panel': 'Today', 'today.refresh': 'Refresh' },
    zh: { 'common.loading': '正在读取…', 'today.panel': '今日', 'today.refresh': '刷新' },
  },
};

/** A page definition stub; the page body is never rendered here. */
const page = (overrides = {}) => ({ file: 'today', definition: { key: 'today', order: 20, label: 'today.panel', Page: () => null, ...overrides } });

/** An action definition stub. */
const action = (overrides = {}) => ({ file: 'refresh', definition: { id: 'refresh-today', page: 'today', label: 'today.refresh', run: () => 'ok', ...overrides } });

/**
 * Recording Cordis client context.
 * @returns {{ ctx: object, state: object, setLocale: (locale: string) => void }} Fake context and its ledger.
 */
function createFakeContext() {
  const state = { locale: 'zh', dictionaries: new Map(), registrations: [] };
  const ctx = {
    provide(name, value) { this[name] = value; },
    studyClient: { call: async () => ({ ok: true }) },
    studyRefresh: createStudyRefresh(),
    studyNav: { registerPages: () => () => {} },
    studyUi: { StudyPanelIcon: () => null },
    effect(run) {
      const dispose = run();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    locale: {
      register(namespace, dictionary) {
        state.dictionaries.set(namespace, dictionary);
        return () => state.dictionaries.delete(namespace);
      },
      bind(namespace) {
        return (key, params) => {
          const dictionary = state.dictionaries.get(namespace);
          const template = dictionary?.[state.locale]?.[key] ?? dictionary?.en?.[key] ?? key;
          if (params === undefined) return template;
          return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
        };
      },
    },
    slots: {
      inject(name, callback) {
        const dispose = callback();
        return () => { if (typeof dispose === 'function') dispose(); };
      },
      register(options, component) {
        state.registrations.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, state, setLocale(locale) { state.locale = locale; } };
}

describe('createPlugin validation', () => {
  it('rejects a page key that does not match its file name', () => {
    assert.throws(
      () => createPlugin({ pages: [page({ key: 'tomorrow' })], messages: [DICTIONARY], actions: [] }),
      /key 必须等于文件名/,
    );
  });

  it('rejects a page label with no dictionary entry', () => {
    assert.throws(
      () => createPlugin({ pages: [page({ label: 'today.missing' })], messages: [DICTIONARY], actions: [] }),
      /label 指向的文案键 "today\.missing"/,
    );
  });

  it('rejects a duplicate dictionary key across modules', () => {
    assert.throws(
      () => createPlugin({
        pages: [page()],
        messages: [DICTIONARY, { file: 'extra', dictionary: DICTIONARY.dictionary }],
        actions: [],
      }),
      /重复定义了 zh 键|重复定义了 en 键/,
    );
  });

  it('rejects a dictionary whose locales disagree', () => {
    assert.throws(
      () => createPlugin({
        pages: [page()],
        messages: [{ file: 'common', dictionary: { en: { 'today.panel': 'Today' }, zh: {} } }],
        actions: [],
      }),
      /en\/zh 键集合不一致/,
    );
  });

  it('rejects an action that targets an unknown page', () => {
    assert.throws(
      () => createPlugin({ pages: [page()], messages: [DICTIONARY], actions: [action({ page: 'elsewhere' })] }),
      /指向了不存在的页面/,
    );
  });

  it('rejects a duplicate action id', () => {
    assert.throws(
      () => createPlugin({
        pages: [page()],
        messages: [DICTIONARY],
        actions: [action(), { file: 'second', definition: action().definition }],
      }),
      /界面动作 id 重复/,
    );
  });

  it('rejects an action without a run function', () => {
    assert.throws(
      () => createPlugin({ pages: [page()], messages: [DICTIONARY], actions: [action({ run: undefined })] }),
      /run 必须是函数/,
    );
  });

  it('rejects a contribution set with no pages', () => {
    assert.throws(() => createPlugin({ pages: [], messages: [DICTIONARY], actions: [] }), /没有任何页面模块/);
  });
});

describe('apply', () => {
  const plugin = createPlugin({ pages: [page()], messages: [DICTIONARY], actions: [action()] });

  it('injects the services the registrations read', () => {
    assert.deepEqual(plugin.inject, ['slots', 'locale']);
  });

  it('registers the merged dictionary under the study namespace', () => {
    const { ctx, state } = createFakeContext();
    plugin.apply(ctx);
    assert.deepEqual([...state.dictionaries.keys()], [NS]);
    assert.equal(state.dictionaries.get(NS).zh['today.panel'], '今日');
    assert.equal(state.dictionaries.get(NS).en['today.panel'], 'Today');
  });

  it('registers the page body and the sidebar entry with the same key', () => {
    const { ctx, state } = createFakeContext();
    plugin.apply(ctx);
    const main = state.registrations.find(row => row.options.name === 'main');
    const panel = state.registrations.find(row => row.options.name === 'sidebar.panellist');
    assert.equal(main.options.key, 'today');
    assert.equal(main.options.locale, NS);
    assert.equal(panel.options.id, 'today');
    assert.equal(panel.options.order, 20);
    assert.equal(panel.options.locale, NS);
  });

  it('resolves the sidebar label through the active locale', () => {
    const { ctx, state, setLocale } = createFakeContext();
    plugin.apply(ctx);
    const panel = state.registrations.find(row => row.options.name === 'sidebar.panellist');
    assert.equal(panel.options.label(), '今日');
    setLocale('en');
    assert.equal(panel.options.label(), 'Today');
  });

  it('injects the route caller and the action registry into the page', () => {
    const { ctx, state } = createFakeContext();
    plugin.apply(ctx);
    const main = state.registrations.find(row => row.options.name === 'main');
    const injected = main.options.inject();
    assert.equal(typeof injected.call, 'function');
    assert.equal(typeof injected.studyRefresh.onStudyDataChanged, 'function');
    assert.deepEqual(injected.actions.forPage('today'), [{ id: 'refresh-today', label: 'today.refresh' }]);
    assert.equal(typeof injected.actions.run, 'function');
  });
});

describe('action registry', () => {
  it('offers page-scoped and global actions, and rejects unknown ids', async () => {
    const plugin = createPlugin({
      pages: [page()],
      messages: [DICTIONARY],
      actions: [
        action(),
        { file: 'global', definition: { id: 'go-back', label: 'today.panel', run: () => 'back' } },
      ],
    });
    const { ctx, state } = createFakeContext();
    plugin.apply(ctx);
    const registry = state.registrations.find(row => row.options.name === 'main').options.inject().actions;
    assert.deepEqual(registry.forPage('today').map(row => row.id), ['refresh-today', 'go-back']);
    assert.deepEqual(registry.forPage('other-page').map(row => row.id), ['go-back']);
    assert.equal(await registry.run('go-back', {}), 'back');
    await assert.rejects(registry.run('nope'), /未知界面动作/);
  });
});

describe('real client tree', () => {
  /**
   * Import every module of one contribution directory.
   * @param {string} directory - Directory name under `client/`.
   * @returns {Promise<Array<{ file: string, module: object }>>} Imported modules.
   */
  async function load(directory) {
    const names = (await readdir(join(CLIENT_ROOT, directory)))
      .filter(name => name.endsWith('.js') && !name.startsWith('.'))
      .map(name => name.slice(0, -'.js'.length))
      .sort();
    const imported = [];
    for (const name of names) {
      imported.push({ file: name, module: await import(pathToFileURL(join(CLIENT_ROOT, directory, `${name}.js`)).href) });
    }
    return imported;
  }

  it('assembles every shipped page, dictionary and action without validation errors', async () => {
    const pages = (await load('pages')).map(({ file, module }) => ({ file, definition: module.default }));
    const messages = [...sharedMessages, ...(await load('messages')).map(({ file, module }) => ({ file, dictionary: module.default }))];
    const actions = (await load('actions')).map(({ file, module }) => ({ file, definition: module.default }));
    const corePlugin = createPlugin({
      pages: [{ file: 'today', definition: (await import('../../../study-core/client/pages/today.js')).default }],
      messages: [sharedMessages[0], { file: 'today', dictionary: (await import('../../../study-core/client/messages/today.js')).default }],
      actions: [{ file: 'refresh', definition: (await import('../../../study-core/client/actions/refresh.js')).default }],
    });
    const plugin = createShellPlugin({ pages, messages, actions });
    assert.deepEqual(plugin.inject, ['slots', 'locale', 'studyClient', 'studyRefresh', 'studyNav', 'studyUi']);
    const { ctx, state } = createFakeContext();
    corePlugin.apply(ctx);
    plugin.apply(ctx);
    const injected = state.registrations.find(row => row.options.key === 'outcomes').options.inject();
    assert.equal(injected.call, ctx.studyClient.call);
    assert.equal(injected.studyRefresh, ctx.studyRefresh);
    const keys = state.registrations.filter(row => row.options.name === 'main').map(row => row.options.key);
    assert.ok(keys.includes('today'), `缺少 today 页面；实际注册：${keys.join('、')}`);
    const panels = state.registrations.filter(row => row.options.name === 'sidebar.panellist').map(row => row.options.id);
    assert.deepEqual(panels.sort(), keys.slice().sort(), '每个页面都要有同 key 的侧栏入口');
    assert.equal(state.registrations.some(row => row.options.name === 'studyleft'), false, '常驻学习栏不再注册');
  });
});
