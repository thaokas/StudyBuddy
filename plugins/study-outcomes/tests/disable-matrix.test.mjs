import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as core from '../../study-core/host/index.mjs';
import * as facts from '../../study-facts/host/index.mjs';
import * as learning from '../../study-learning/host/index.mjs';
import * as reminders from '../../study-reminders/host/index.mjs';
import * as memory from '../../study-memory/host/index.mjs';
import * as outcomes from '../host/index.mjs';
import { buildStudyExport } from '../../study-core/host/modules/export.mjs';
import { deploymentPolicy } from '../../../scripts/project-config.mjs';
const { Context } = createRequire(new URL('../../../source/deepseek-harness/apps/cli/package.json', import.meta.url))('@deepseek-ai/cordis');
const rows = [facts, learning, reminders, memory, outcomes];
function stableExport(database) {
  const data = buildStudyExport({ database }).data;
  // Host heartbeat times change on restart; user records and all table keys must stay equal.
  for (const state of data.otherTables.study_followup_state ?? []) {
    for (const key of ['last_seen_at', 'resumed_at', 'updated_at']) delete state[key];
  }
  return data;
}
const namespaces = [['materials', 'tasks', 'plans', 'planning', 'timer'], ['tutoring', 'learning', 'review'], ['followup'], ['memory'], ['outcomes', 'milestones']];

test('final profile has six business rows and no legacy shell', () => {
  const ids = deploymentPolicy('data').flatMap(row => row.insert ?? []).map(row => row.id);
  assert.deepEqual(ids.filter(id => id.startsWith('study-') && id !== 'study-appearance' && id !== 'study-pet'), ['study-core', ...rows.map(row => row.name)]);
  assert.equal(ids.includes('study'), false);
});

for (const optional of [learning, reminders, memory, outcomes]) test(`restart without ${optional.name} preserves exports and restores namespaces`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'p6-matrix-'));
  let fibers = [];
  async function stop() { for (const fiber of fibers.reverse()) await fiber.dispose(); fibers = []; }
  async function boot(omit) {
    const ctx = new Context();
    ctx.provide('tools', { register: () => () => {} });
    for (const row of [core, ...rows]) {
      if (row === omit) continue;
      const fiber = ctx.plugin(row, row === core ? { dataDir: directory } : {});
      fibers.push(fiber); await fiber;
    }
    return ctx;
  }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  let ctx = await boot();
  const created = await ctx.study.call('tasks', 'createTask', { title: 'P6 persistent task' }, { requestId: 'matrix-task' });
  assert.equal(created.ok, true);
  const db = ctx.study.kernel.database;
  const schema = db.all("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
  const data = stableExport(db);
  await stop();
  ctx = await boot(optional);
  rows.forEach((row, index) => namespaces[index].forEach(ns => assert.equal(ctx.study.has(ns), row !== optional, ns)));
  assert.equal((await ctx.study.call('tasks', 'listTasks', {})).ok, true);
  if (optional !== outcomes) assert.equal((await ctx.study.call('outcomes', 'day', {})).ok, true);
  assert.deepEqual(stableExport(ctx.study.kernel.database), data);
  await stop();
  ctx = await boot();
  assert.deepEqual(ctx.study.kernel.database.all("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"), schema);
  assert.deepEqual(stableExport(ctx.study.kernel.database), data);
  for (const ns of namespaces.flat()) assert.equal(ctx.study.has(ns), true, ns);
});

test('outcomes disabled on a fresh date defers baseline until provider returns', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'p6-provider-'));
  const ctx = new Context(); ctx.provide('tools', { register: () => () => {} });
  const fibers = [];
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  for (const row of [core, facts]) { const fiber = ctx.plugin(row, row === core ? { dataDir: directory } : {}); fibers.push(fiber); await fiber; }
  assert.equal((await ctx.study.call('tasks', 'createTask', { title: 'before provider' }, { requestId: 'before-provider' })).ok, true);
  assert.equal(ctx.study.kernel.database.get('SELECT count(*) AS n FROM day_snapshot').n, 0);
  const fiber = ctx.plugin(outcomes, {}); fibers.push(fiber); await fiber;
  assert.equal((await ctx.study.call('outcomes', 'day', {})).ok, true);
  assert.ok(ctx.study.kernel.daySnapshot().plan.outcomes);
  await fiber.dispose();
  assert.equal(ctx.study.has('outcomes'), false);
  assert.equal(ctx.study.has('milestones'), false);
  assert.equal((await ctx.study.call('tasks', 'listTasks', {})).ok, true);
});
