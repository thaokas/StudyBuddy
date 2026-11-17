import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import * as React from '../../../study-outcomes/tests/client/support/react-stub.mjs';

function context(services, shared) {
  const disposers = [];
  const ctx = Object.assign(Object.create(services), {
    effect(run) { const off = run(); if (typeof off === 'function') disposers.push(off); return off; },
    get(name) { return services[name]; },
    provide(name, service) { services[name] = service; },
    inject(names, callback) { if (names.every(name => services[name])) callback(ctx); },
    dispose() { for (const off of disposers.reverse()) off(); },
    locale: {
      register(ns, dictionary) { assert.equal(shared.locales.has(ns), false); shared.locales.set(ns, dictionary); return () => shared.locales.delete(ns); },
      bind(ns) { return key => shared.locales.get(ns)?.en[key] ?? key; },
    },
    slots: {
      inject(_name, run) { return ctx.effect(run); },
      register(options, Page) {
        const entry = { options, Page }; shared.entries.push(entry); shared.emit();
        return () => { shared.entries.splice(shared.entries.indexOf(entry), 1); shared.emit(); };
      },
      entries(name) { return shared.entries.filter(row => row.options.name === name); },
      subscribe(_name, listener) { shared.listeners.add(listener); return () => shared.listeners.delete(listener); },
    },
  });
  return ctx;
}

for (const savedPage of ['memory', 'today', 'onboarding', 'workbench', 'timer', 'plan']) test(`separate bundles share retry identities, refresh events and restore ${savedPage}`, async () => {
  const { buildClient } = await import('../../scripts/build-client.mjs');
  const { buildClient: buildMemory } = await import('../../../study-memory/scripts/build-client.mjs');
  const { buildClient: buildShell } = await import('../../../study-outcomes/scripts/build-client.mjs');
  const { buildClient: buildFacts } = await import('../../../study-facts/scripts/build-client.mjs');
  const requests = [];
  let fail = true;
  function load(source) {
    let plugin;
    runInNewContext(source, {
      window: { __ModuleLoader__: { load({ factory }) { plugin = factory(name => { assert.equal(name, 'react'); return React; }); } } },
      console, crypto: globalThis.crypto,
      fetch: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (fail) { fail = false; throw new Error('uncertain'); }
        return { json: async () => ({ ok: true, value: {}, revision: 1 }) };
      },
      localStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
      },
    });
    return plugin;
  }
  const values = new Map([['study.layout.page', savedPage]]);
  const shared = { entries: [], locales: new Map(), listeners: new Set(), emit() { for (const listener of [...this.listeners]) listener(); } };
  const layoutListeners = new Set();
  const selected = [];
  let activePanelId = null;
  const services = { sessions: { list: { getSnapshot: () => ({ byId: {}, ids: [] }), subscribe: () => () => {} } }, layout: {
    selectPanel(id) { selected.push(id); },
    panelInfo: { getSnapshot: () => ({ activePanelId }), subscribe(fn) { layoutListeners.add(fn); return () => layoutListeners.delete(fn); } },
  } };
  const core = context(services, shared);
  const shell = context(services, shared);
  const memory = context(services, shared);
  const coreBuild = await buildClient({ write: false });
  assert.equal(await readFile(new URL('../../client/client.js', import.meta.url), 'utf8'), coreBuild.source, 'core bundle must match its sources');
  const corePlugin = load(coreBuild.source);
  const shellPlugin = load((await buildShell({ write: false })).source);
  corePlugin.apply(core);
  assert.deepEqual(selected, savedPage === 'today' ? ['today'] : [], 'restore waits for the saved page registration');
  const facts = context(services, shared);
  load((await buildFacts({ write: false })).source).apply(facts);
  const learning = context(services, shared);
  const { buildClient: buildLearning } = await import('../../../study-learning/scripts/build-client.mjs');
  load((await buildLearning({ write: false })).source).apply(learning);
  const reminders = context(services, shared);
  const { buildClient: buildReminders } = await import('../../../study-reminders/scripts/build-client.mjs');
  load((await buildReminders({ write: false })).source).apply(reminders);
  shellPlugin.apply(shell);
  const memoryBuild = await buildMemory({ write: false });
  const memoryPlugin = load(memoryBuild.source);
  memoryPlugin.apply(memory);
  assert.equal(shared.entries.find(row => row.options.key === "memory").options.inject().call, services.studyClient.call);
  assert.deepEqual(selected, [savedPage]);
  assert.deepEqual([...shared.locales.keys()], ['study-core', 'study-facts', 'study-learning', 'study-reminders', 'study-outcomes', 'study-memory']);
  assert.equal(Object.keys(shared.locales.get('study-outcomes').en).some(key => key.startsWith('today.')), false);
  for (const locale of ['en', 'zh']) assert.equal(shared.locales.get('study-memory')[locale]['common.refresh'], shared.locales.get('study-core')[locale]['today.refresh'], 'memory refresh copy must stay unchanged');
  const today = shared.entries.find(row => row.options.key === 'today').options.inject();
  const workbench = shared.entries.find(row => row.options.key === 'workbench').options.inject();
  const pages = shared.entries.filter(row => row.options.name === 'sidebar.panellist').map(row => [row.options.id, row.options.order]);
  assert.deepEqual(pages.sort((a, b) => a[1] - b[1]), [['onboarding', 1], ['workbench', 10], ['timer', 15], ['plan', 16], ['reminders', 17], ['today', 20], ['outcomes', 25], ['questions', 70], ['memory', 80]]);
  assert.equal(shared.entries.find(row => row.options.key === 'questions').options.locale, 'study-learning');
  assert.equal(shared.entries.filter(row => row.options.id === 'questions').length, 1);
  assert.equal(today.call, workbench.call);
  assert.equal(today.studyRefresh, workbench.studyRefresh);
  await assert.rejects(today.call('tasks', 'createTask', { title: 'same' }), /uncertain/);
  await workbench.call('tasks', 'createTask', { title: 'same' });
  assert.equal(requests[0].requestId, requests[1].requestId);
  let reason;
  const off = today.studyRefresh.onStudyDataChanged(value => { reason = value; });
  workbench.studyRefresh.notifyStudyDataChanged('shell-write');
  assert.equal(reason, 'shell-write');
  off();
  memory.dispose();
  assert.equal(shared.entries.some(row => row.options.id === "memory"), false);
  for (const key of ["questions", "plan", "outcomes"]) assert.equal(shared.entries.some(row => row.options.id === key), true);
  assert.equal(new Set(pages.map(row => row[1])).size, pages.length);
  assert.equal(shared.entries.some(row => row.options.id === 'study.completion-notify'), true);
  reminders.dispose();
  assert.equal(shared.locales.has('study-reminders'), false);
  for (const id of ['reminders', 'study.completion-notify', 'study.followup-reminders']) assert.equal(shared.entries.some(row => row.options.id === id || row.options.key === id), false);
  for (const id of ['plan', 'workbench', 'timer', 'outcomes']) assert.equal(shared.entries.some(row => row.options.id === id), true);
  shell.dispose();
  learning.dispose();
  assert.equal(shared.entries.some(row => row.options.id === 'questions'), false);
  assert.equal(shared.locales.has('study-learning'), false);
  facts.dispose();
  activePanelId = 'memory';
  for (const listener of layoutListeners) listener();
  assert.equal(values.get('study.layout.page'), savedPage);
  activePanelId = 'today';
  for (const listener of layoutListeners) listener();
  assert.equal(values.get('study.layout.page'), 'today');
  activePanelId = 'memory';
  for (const listener of layoutListeners) listener();
  assert.equal(values.get('study.layout.page'), 'today', 'disposed shell page must no longer be tracked');
  core.dispose();
  assert.equal(layoutListeners.size, 0);
  assert.equal(shared.listeners.size, 0);
  assert.equal(shared.entries.length, 0);
  const corePackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url)));
  const shellPackage = JSON.parse(await readFile(new URL('../../../study-outcomes/package.json', import.meta.url)));
  assert.equal(corePackage.name, '@studybuddy/study-core');
  assert.ok(shellPackage.dsh.client.inject.includes(corePackage.name));
});
