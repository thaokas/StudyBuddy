import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryHarness } from '../../../study-memory/tests/memory/helpers.mjs';
import { buildStudyExport, writeStudyExport } from '../../host/modules/export.mjs';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as composed from '../../../../tests/support/composed-host.mjs';

test('export obtains actual day/week/month service snapshots without outcome tables', async t => {
  const h = await openMemoryHarness(t);
  h.kernel.register('outcomes', { methods: Object.fromEntries(['day', 'week', 'month'].map(period => [period, () => ({ period, actualMinutes: 45 })])) });
  const document = await buildStudyExport({ database: h.database, study: h.kernel, dataDir: h.directory });
  assert.equal(document.availability.outcomes.available, true);
  assert.deepEqual(document.data.outcomes.map(x => x.period), ['day', 'week', 'month']);
  assert.equal(document.data.outcomes[0].actualMinutes, 45);
  const written = await writeStudyExport({ database: h.database, study: h.kernel, dataDir: h.directory, periods: ['week'], includeFacts: false });
  const disk = JSON.parse(await readFile(written.path, 'utf8'));
  assert.deepEqual(disk.data.outcomes.map(x => x.period), ['week']);
  assert.equal(disk.data.tasks, undefined);
  assert.equal(disk.selection.includeFacts, false);
});

test('export does not infer enabled outcomes from stored table names', async t => {
  const h = await openMemoryHarness(t);
  h.database.exec('CREATE TABLE study_outcome (id TEXT) STRICT');
  const document = await buildStudyExport({ database: h.database, study: h.kernel, dataDir: h.directory });
  assert.equal(document.availability.outcomes.available, false);
  assert.match(document.availability.outcomes.reason, /not_registered/);
  assert.deepEqual(document.data.outcomes, []);
});

test('export uses live SQLite memories and excludes captured conversations and attachments by default', async t => {
  const h = await openMemoryHarness(t, { withLearning: true });
  await h.writeOk('memory', 'remember', { text: '当前偏好', sourceRef: { sessionId: 's', messageId: 'm' } });
  await h.writeOk('learning', 'capture', { sessionId: 's', messageId: 'm', text: '不应导出的原始对话正文', attachments: [{ type: 'file', name: 'private.pdf' }] });
  h.database.run('INSERT OR REPLACE INTO study_memory_state (id, json) VALUES (1, ?)', JSON.stringify({ items: [{ text: '已经删除的旧记忆镜像' }] }));
  const document = await buildStudyExport({ database: h.database, dataDir: h.directory });
  assert.equal(document.data.memory.items[0]?.text, '当前偏好');
  assert.equal(document.data.memory.items[0]?.sourceRef.messageId, 'm');
  assert.equal(document.data.otherTables.study_turn, undefined);
  assert.equal(document.data.otherTables.study_memory_state, undefined);
  assert.doesNotMatch(JSON.stringify(document), /不应导出的原始对话正文|private.pdf/);
});

test('authenticated app route exports the real outcomes service and rejects credential-shaped facts', async t => {
  const { Context } = createRequire(new URL('../../../../source/deepseek-harness/apps/cli/package.json', import.meta.url))('@deepseek-ai/cordis');
  const directory = await mkdtemp(join(tmpdir(), 'study-export-closeout-'));
  const ctx = new Context();
  const routes = [];
  ctx.provide('tools', { register: () => () => {} });
  ctx.provide('connection', { fetch: { register: route => { routes.push(route); return () => {}; } } });
  const fiber = ctx.plugin(composed, { dataDir: directory });
  await fiber;
  t.after(async () => { await fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  const call = async (ns, method, payload) => {
    const result = await ctx.study.call(ns, method, payload, { actor: 'ui', requestId: crypto.randomUUID() });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  await call('materials', 'saveGoal', { exam: '真实成果导出', active: true });
  const { task } = await call('tasks', 'createTask', { title: '数学复习', estimatedMinutes: 30 });
  await call('tasks', 'recordProgress', { taskId: task.id, status: 'done', actualMinutes: 25 });
  await call('plans', 'recordProgress', { planId: 'plan_missing', itemId: 'item_missing', status: 'done' }).catch(() => {});
  const route = routes.find(x => x.path === '/api/study/export.json');
  assert.deepEqual(route.methods, ['GET', 'POST']);
  const response = await route.fetch(new Request('http://localhost/api/study/export.json', { method: 'POST', body: JSON.stringify({ periods: ['day', 'week', 'month'], includeFacts: true }) }));
  const receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  const document = JSON.parse(await readFile(receipt.value.path, 'utf8'));
  assert.equal(document.availability.outcomes.available, true);
  assert.equal(document.data.outcomes.length, 3);
  assert.equal(document.data.taskProgress.length, 1);
  assert.equal(document.data.taskProgress[0].status, 'done');
  assert.equal(document.summary.taskProgress, 1);
  assert.equal(document.data.otherTables.study_task_progress, undefined);
  const expected = await ctx.study.call('outcomes', 'day', {}, { actor: 'ui' });
  assert.deepEqual({ ...document.data.outcomes[0], generatedAt: null }, { ...expected.value, generatedAt: null });
  assert.equal(document.data.tasks[0].title, '数学复习');
  assert.equal(document.data.otherTables.request_log, undefined);
  await call('memory', 'remember', { text: 'sk-1234567890ABCDEFGHIJKLMNOP' });
  const blocked = await route.fetch(new Request('http://localhost/api/study/export.json', { method: 'POST', body: '{}' }));
  assert.equal(blocked.status, 503);
  assert.match((await blocked.json()).message, /凭据/);
});
