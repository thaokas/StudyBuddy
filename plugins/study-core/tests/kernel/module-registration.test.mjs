import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as core from '../../host/index.mjs';

const require = createRequire(new URL('../../../../source/deepseek-harness/apps/cli/package.json', import.meta.url));
const { Context } = require('@deepseek-ai/cordis');
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'study-modules-'));
  const ctx = new Context();
  ctx.provide('tools', { register: () => () => {} });
  const fiber = ctx.plugin(core, { dataDir });
  await fiber;
  t.after(async () => { await fiber.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  return ctx;
}

test('module registration tracks live modules and read contracts and disposes without deleting data', async t => {
  const ctx = await fixture(t);
  const remove = await ctx.study.module({ id: 'sample', deps: ['kernel'], schemaVersion: 1,
    schema: ['CREATE TABLE sample (id TEXT PRIMARY KEY) STRICT'], readContracts: [{ table: 'sample', version: 1 }] });
  const found = ctx.study.kernel.status().modules.find(module => module.id === 'sample');
  assert.deepEqual(found.readContracts, [{ table: 'sample', version: 1 }]);
  assert.equal(ctx.study.kernel.database.get("SELECT schema_version FROM module_schema WHERE module_id = 'sample'").schema_version, 1);
  remove();
  remove();
  assert.equal(ctx.study.kernel.status().modules.some(module => module.id === 'sample'), false);
  assert.ok(ctx.study.kernel.database.get("SELECT name FROM sqlite_master WHERE name = 'sample'"));
});

test('a schema mismatch disables only the rejected contribution, with backup guidance', async t => {
  const ctx = await fixture(t);
  const db = ctx.study.kernel.database;
  db.run("INSERT INTO module_schema VALUES ('incompatible', 9, '2026-11-14')");
  await assert.rejects(ctx.study.module({ id: 'incompatible', schemaVersion: 1,
    schema: ['CREATE TABLE incompatible (id TEXT) STRICT'] }), error => error.code === 'unavailable' && /备份/.test(error.details.recovery));
  assert.equal(db.blocked, null);
  const remove = await ctx.study.module({ id: 'healthy', schemaVersion: 1, schema: ['CREATE TABLE healthy (id TEXT) STRICT'] });
  const unregister = ctx.study.register('tasks', { methods: { save: (_payload, api) => { api.db.run("INSERT INTO healthy VALUES ('works')"); return true; } }, writes: ['save'] });
  assert.equal(ctx.study.has('tasks'), true);
  assert.equal((await ctx.study.call('tasks', 'save', {}, { requestId: 'healthy-write' })).ok, true);
  unregister(); remove();
  assert.equal(ctx.study.has('tasks'), false);
});

test('first snapshot waits for a provider and composition readiness, including calls during initialization', async t => {
  const ctx = await fixture(t);
  const kernel = ctx.study.kernel;
  assert.equal((await ctx.study.call('kernel', 'status', {})).ok, true);
  assert.equal(kernel.daySnapshot(), null);
  const ready = ctx.study.composition();
  const remove = kernel.setDaySnapshotProvider(() => ({ outcomes: [{ id: 'present' }] }));
  await ctx.study.call('kernel', 'status', {});
  assert.equal(kernel.daySnapshot(), null);
  ready();
  assert.equal(kernel.daySnapshot(), null);
  await ctx.study.call('kernel', 'status', {});
  assert.deepEqual(kernel.daySnapshot().plan.outcomes, [{ id: 'present' }]);
  remove();
});


test('writes cannot race composition and change the baseline before the first snapshot', async t => {
  const ctx = await fixture(t);
  const kernel = ctx.study.kernel;
  const ready = ctx.study.composition();
  const remove = await ctx.study.module({ id: 'baseline', schema: ['CREATE TABLE baseline (value TEXT) STRICT'] });
  const unregister = ctx.study.register('tasks', { methods: { save: (_payload, api) => {
    api.db.run("INSERT INTO baseline VALUES ('changed')"); return true;
  } }, writes: ['save'] });
  const raced = await ctx.study.call('tasks', 'save', {}, { requestId: 'before-ready' });
  assert.equal(raced.ok, false);
  assert.equal(raced.code, 'unavailable');
  assert.equal(kernel.database.get('SELECT COUNT(*) AS n FROM baseline').n, 0);
  const clear = kernel.setDaySnapshotProvider(() => ({ baselineRows: kernel.database.get('SELECT COUNT(*) AS n FROM baseline').n }));
  ready();
  assert.equal((await ctx.study.call('tasks', 'save', {}, { requestId: 'after-ready' })).ok, true);
  assert.equal(kernel.daySnapshot().plan.baselineRows, 0);
  clear(); unregister(); remove();
});

test('failed DDL rolls back tables and its schema stamp, permitting a corrected registration', async t => {
  const ctx = await fixture(t);
  await assert.rejects(ctx.study.module({ id: 'atomic', schema: [
    'CREATE TABLE atomic (id TEXT) STRICT', 'THIS IS NOT SQL',
  ] }), error => error.code === 'unavailable');
  const db = ctx.study.kernel.database;
  assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'atomic'"), undefined);
  assert.equal(db.get("SELECT module_id FROM module_schema WHERE module_id = 'atomic'"), undefined);
  assert.equal(ctx.study.kernel.status().modules.some(module => module.id === 'atomic'), false);
  const remove = await ctx.study.module({ id: 'atomic', schema: ['CREATE TABLE atomic (id TEXT) STRICT'] });
  await assert.rejects(ctx.study.module({ id: 'atomic', schema: [] }), error => error.code === 'invalid');
  remove();
});


test('a failing plugin releases its earlier module and namespace without disabling core', async t => {
  const ctx = await fixture(t);
  ctx.study.kernel.database.run("INSERT INTO module_schema VALUES ('reject_me', 9, '2026-11-14')");
  const faulty = ctx.plugin({ name: 'faulty-business', inject: ['study'], async apply(scope) {
    const remove = await scope.study.module({ id: 'temporary', schema: [] });
    scope.effect(() => remove);
    scope.effect(() => scope.study.register('tasks', { methods: { read: () => true } }));
    await scope.study.module({ id: 'reject_me', schema: ['CREATE TABLE reject_me (id TEXT) STRICT'] });
  } });
  await assert.rejects(Promise.resolve(faulty), error => error.code === 'unavailable');
  assert.equal(ctx.study.has('tasks'), false);
  assert.equal(ctx.study.kernel.status().modules.some(module => module.id === 'temporary'), false);
  assert.equal((await ctx.study.call('kernel', 'status', {})).ok, true);
  await faulty.dispose();
});
