import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as core from '../../study-core/host/index.mjs';
import * as facts from '../host/index.mjs';
import * as learning from '../../study-learning/host/index.mjs';
import * as reminders from '../../study-reminders/host/index.mjs';
import * as shell from '../../study-outcomes/host/index.mjs';
import * as memory from '../../study-memory/host/index.mjs';
import { buildStudyExport } from '../../study-core/host/modules/export.mjs';
import { migrateReminderFoundation } from '../../../packages/study-model/facts.mjs';

const { Context } = createRequire(new URL('../../../source/deepseek-harness/apps/cli/package.json', import.meta.url))('@deepseek-ai/cordis');

test('facts can leave and return without changing schema or losing stored tasks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'p3-facts-'));
  const ctx = new Context();
  const tools = new Map();
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } });
  const coreFiber = ctx.plugin(core, { dataDir: directory });
  await coreFiber;
  let fiber;
  t.after(async () => { await fiber?.dispose(); await coreFiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(ctx.study.has('tasks'), false);
  fiber = ctx.plugin(facts, {});
  await fiber;
  const result = await ctx.study.call('tasks', 'createTask', { title: 'survives disable' }, { requestId: 'p3-task' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const schema = () => ctx.study.kernel.database.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const before = schema();
  const exported = buildStudyExport({ database: ctx.study.kernel.database });
  assert.equal(exported.formatVersion, 1);
  assert.equal(ctx.study.kernel.status().modules.filter(row => ['materials', 'tasks', 'plans', 'planning', 'timer'].includes(row.id)).length, 5);
  await fiber.dispose();
  for (const ns of ['materials', 'tasks', 'plans', 'planning', 'timer']) assert.equal(ctx.study.has(ns), false);
  assert.equal(tools.has('study_tasks'), false);
  assert.equal(ctx.study.kernel.database.get('SELECT count(*) AS count FROM study_task').count, 1);
  assert.deepEqual(buildStudyExport({ database: ctx.study.kernel.database }).data, exported.data);
  fiber = ctx.plugin(facts, {});
  await fiber;
  assert.deepEqual(schema(), before);
  assert.equal((await ctx.study.call('tasks', 'listTasks', {})).ok, true);
  assert.equal(ctx.study.kernel.database.get('SELECT count(*) AS count FROM study_task').count, 1);
});

test('shell waits for async facts registration even when the shell row starts first', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'p3-row-order-'));
  const ctx = new Context();
  ctx.provide('tools', { register: () => () => {} });
  const fibers = [];
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  for (const [plugin, config] of [[core, { dataDir: directory }], [reminders, {}], [shell, {}], [learning, {}], [facts, {}]]) {
    const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber;
  }
  for (let attempt = 0; attempt < 100 && !ctx.study.kernel.status().modules.some(row => row.id === 'outcomes'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const result = await ctx.study.call('outcomes', 'day', {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await ctx.study.call('learning', 'list', {})).ok, true);
});

test('without facts shell pages receive unavailable while memory remains usable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'p3-no-facts-'));
  const ctx = new Context();
  ctx.provide('tools', { register: () => () => {} });
  const fibers = [];
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  for (const [plugin, config] of [[core, { dataDir: directory }], [memory, {}], [learning, {}], [reminders, {}], [shell, {}]]) {
    const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber;
  }
  for (const [ns, method] of [['learning', 'list'], ['followup', 'due'], ['outcomes', 'day']]) {
    const result = await ctx.study.call(ns, method, {});
    assert.equal(result.code, 'unavailable', JSON.stringify(result));
    assert.equal(result.details.plugin, 'study-facts');
  }
  assert.equal((await ctx.study.call('memory', 'recall', {})).ok, true);
  assert.equal(ctx.study.has('tasks'), false);
  assert.equal(ctx.study.kernel.database.get("SELECT name FROM sqlite_master WHERE name = 'study_task'"), undefined);
});

test('legacy reminders migrate even after the facts version gate was recorded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'p3-reminder-migration-'));
  const ctx = new Context();
  ctx.provide('tools', { register: () => () => {} });
  const fiber = ctx.plugin(core, { dataDir: directory });
  await fiber;
  t.after(async () => { await fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  const db = ctx.study.kernel.database;
  db.exec(`CREATE TABLE study_goal (id TEXT, active INTEGER);
    INSERT INTO study_goal VALUES ('legacy-goal', 1);
    CREATE TABLE study_followup_review (id TEXT);
    INSERT INTO study_followup_review VALUES ('review');
    CREATE TABLE study_followup_reminder (id TEXT);
    INSERT INTO study_followup_reminder VALUES ('reminder');
    CREATE TRIGGER study_followup_review_no_update BEFORE UPDATE ON study_followup_review
      BEGIN SELECT RAISE(ABORT, 'append only'); END;`);
  db.writeMeta('data_foundation_version', '1');
  await migrateReminderFoundation(db);
  for (const table of ['study_followup_review', 'study_followup_reminder']) {
    assert.equal(db.get(`SELECT goal_id FROM ${table}`).goal_id, 'legacy-goal');
    assert.ok(db.get('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'index', `${table}_goal`));
  }
  assert.ok(db.get("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'study_followup_review_no_update'"));
  await migrateReminderFoundation(db);
  assert.equal(db.readMeta('data_foundation_version'), '1');
  assert.equal(db.get('SELECT count(*) AS count FROM study_followup_review').count, 1);
});
