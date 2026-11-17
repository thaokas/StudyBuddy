import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as core from '../../study-core/host/index.mjs';
import * as facts from '../../study-facts/host/index.mjs';
import * as learning from '../host/index.mjs';
import * as memory from '../../study-memory/host/index.mjs';
import * as reminders from '../../study-reminders/host/index.mjs';
import * as shell from '../../study-outcomes/host/index.mjs';
const { Context } = createRequire(new URL('../../../source/deepseek-harness/apps/cli/package.json', import.meta.url))('@deepseek-ai/cordis');

test('learning capture reaches memory; independent disable/re-enable preserves evidence and other rows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'p4-learning-'));
  const ctx = new Context();
  const tools = new Map();
  const routes = new Map();
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } });
  ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } });
  const fibers = [];
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  for (const [plugin, config] of [[core, { dataDir: directory }], [facts, {}], [memory, {}], [reminders, {}], [shell, {}]]) {
    const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber;
  }
  const otherRows = async () => {
    for (const [ns, method] of [['tasks', 'listTasks'], ['followup', 'due'], ['outcomes', 'day'], ['memory', 'profileGet']]) {
      const result = await ctx.study.call(ns, method, {}); assert.equal(result.ok, true, JSON.stringify(result));
    }
  };
  await otherRows();
  assert.equal(ctx.study.has('review'), false);
  let fiber = ctx.plugin(learning, {}); fibers.push(fiber); await fiber;
  let changed = 0;
  const off = ctx.on('study/learning/changed', () => { changed++; }); t.after(off);
  ctx.emit('agent/inbox/claimed', { agent: { id: 'p4-session' }, message: { id: 'p4-message', source: { kind: 'user' }, content: [{ type: 'text', text: '\u600e\u4e48\u6c42 x^2 \u7684\u5bfc\u6570\uff1f' }] } });
  const db = ctx.study.kernel.database;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (changed && db.get("SELECT count(*) AS n FROM request_log WHERE request_id LIKE 'traits:%'").n) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(changed, 1);
  assert.ok(db.get("SELECT count(*) AS n FROM request_log WHERE request_id LIKE 'traits:%'").n > 0, 'memory consumed learning event');
  assert.equal((await ctx.study.call('learning', 'list', {})).value.total, 1);
  for (const method of ['week', 'month']) assert.equal((await ctx.study.call('review', method, { save: false }, { requestId: 'p4-' + method })).ok, true);
  const schema = db.all("SELECT name, sql FROM sqlite_master WHERE name LIKE 'study_%' ORDER BY name");
  await fiber.dispose();
  for (const ns of ['tutoring', 'learning', 'review']) assert.equal(ctx.study.has(ns), false);
  assert.equal(tools.has('study_questions'), false);
  assert.equal(tools.has('study_tutoring'), false);
  assert.equal([...routes.keys()].some(path => path.startsWith('/api/study/learning/')), false);
  await otherRows();
  assert.equal((await ctx.study.call('review', 'list', {})).code, 'not_found');
  fiber = ctx.plugin(learning, {}); fibers.push(fiber); await fiber;
  assert.equal((await ctx.study.call('learning', 'list', {})).value.total, 1);
  assert.deepEqual(db.all("SELECT name, sql FROM sqlite_master WHERE name LIKE 'study_%' ORDER BY name"), schema);
});
