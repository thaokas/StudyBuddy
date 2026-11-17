import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deploymentPolicy } from '../../../scripts/project-config.mjs';

test('profile loads the eight study rows in product order and only core receives the existing data directory', () => {
  const rows = deploymentPolicy('P1-data').flatMap(row => row.insert ?? []);
  const studyRows = rows.filter(row => row.id.startsWith('study-'));
  assert.deepEqual(studyRows.map(row => row.id), [
    'study-core', 'study-facts', 'study-learning', 'study-reminders',
    'study-memory', 'study-outcomes', 'study-appearance', 'study-pet',
  ]);
  const indexOf = id => studyRows.findIndex(row => row.id === id);
  const lastBusiness = Math.max(...['study-facts', 'study-learning', 'study-reminders', 'study-memory', 'study-outcomes'].map(indexOf));
  assert.ok(indexOf('study-core') < indexOf('study-outcomes'));
  assert.ok(indexOf('study-appearance') > lastBusiness);
  assert.ok(indexOf('study-pet') > lastBusiness);
  assert.deepEqual(studyRows.filter(row => row.config !== undefined).map(row => row.id), ['study-core']);
  assert.deepEqual(studyRows.find(row => row.id === 'study-core').config, { dataDir: join('P1-data', 'study') });
  assert.equal(rows.some(row => row.id === 'a02-probe'), false);
});

test('six host rows preserve the full API, replay writes, and capture outcomes on first call', async t => {
  const core = await import('../host/index.mjs');
  const shell = await import('../../study-outcomes/host/index.mjs');
  const facts = await import('../../study-facts/host/index.mjs');
  const reminders = await import('../../study-reminders/host/index.mjs');
  const learning = await import('../../study-learning/host/index.mjs');
  const memory = await import('../../study-memory/host/index.mjs');
  const source = fileURLToPath(new URL('../../../source/deepseek-harness/', import.meta.url));
  const { Context } = createRequire(join(source, 'apps/cli/package.json'))('@deepseek-ai/cordis');
  const directory = await mkdtemp(join(tmpdir(), 'p1-composition-'));
  const ctx = new Context();
  const tools = [];
  const routes = [];
  ctx.provide('tools', { register: tool => { tools.push(tool); return () => tools.splice(tools.indexOf(tool), 1); } });
  ctx.provide('connection', { fetch: { register: route => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } } });
  const coreFiber = ctx.plugin(core, { dataDir: directory });
  await coreFiber;
  const factsFiber = ctx.plugin(facts, {});
  await factsFiber;
  const learningFiber = ctx.plugin(learning, {});
  await learningFiber;
  const reminderFiber = ctx.plugin(reminders, {});
  await reminderFiber;
  const shellFiber = ctx.plugin(shell, {});
  let memoryFiber;
  t.after(async () => {
    await memoryFiber?.dispose();
    await shellFiber.dispose();
    await learningFiber.dispose();
    await reminderFiber.dispose();
    await factsFiber.dispose(); await coreFiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await shellFiber;
  memoryFiber = ctx.plugin(memory, {});
  await memoryFiber;
  const kernel = ctx.study.kernel;
  assert.equal(kernel.database.get('SELECT count(*) AS count FROM day_snapshot').count, 0);
  const status = await ctx.study.call('kernel', 'status', {});
  assert.equal(status.ok, true);
  assert.equal(status.value.modules.length, 14);
  assert.equal(status.value.namespaces.length, 13);
  assert.equal(status.value.namespaces.reduce((count, ns) => count + ns.methods.length, 0), 107);
  assert.equal(tools.length, 14);
  assert.equal(routes.length, 108);
  assert.equal(new Set(routes.map(route => route.path)).size, 108);
  for (const [namespace, method] of [['planning', 'latest'], ['plans', 'refine'], ['tasks', 'replaceTask'], ['milestones', 'savePersonal']]) {
    assert.ok(status.value.namespaces.find(item => item.ns === namespace)?.methods.includes(method));
  }
  assert.ok(kernel.daySnapshot().plan.outcomes);
  const payload = { title: 'P1 composition' };
  const options = { requestId: 'p1-composition-create', actor: 'ui' };
  const first = await ctx.study.call('tasks', 'createTask', payload, options);
  assert.equal(first.ok, true);
  const changes = kernel.database.get('SELECT count(*) AS count FROM change_log').count;
  const replay = await ctx.study.call('tasks', 'createTask', payload, options);
  assert.deepEqual(replay, first);
  assert.equal(kernel.revision(), first.revision);
  assert.equal(kernel.database.get('SELECT count(*) AS count FROM change_log').count, changes);
  await memoryFiber.dispose();
  await shellFiber.dispose();
    await learningFiber.dispose();
    await reminderFiber.dispose();
  assert.equal(ctx.study.has('tasks'), true);
  await factsFiber.dispose();
  assert.equal(ctx.study.has('tasks'), false);
  assert.equal(ctx.study.has('kernel'), true);
  assert.deepEqual(kernel.status().modules.map(module => module.id).sort(), ['export', 'kernel']);
});
