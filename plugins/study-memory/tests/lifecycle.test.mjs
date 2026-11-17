import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as core from '../../study-core/host/index.mjs';
import * as memory from '../host/index.mjs';

const { Context } = createRequire(new URL('../../../source/deepseek-harness/apps/cli/package.json', import.meta.url))('@deepseek-ai/cordis');

test('a fresh profile without memory still serves plans, learning, outcomes and weekly reports', async t => {
  const learning = await import('../../study-learning/host/index.mjs');
  const shell = await import('../../study-outcomes/host/index.mjs');
  const facts = await import('../../study-facts/host/index.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'p2-disabled-'));
  const ctx = new Context();
  ctx.provide('tools', { register: () => () => {} });
  const coreFiber = ctx.plugin(core, { dataDir: directory });
  await coreFiber;
  const factsFiber = ctx.plugin(facts, {});
  await factsFiber;
  const learningFiber = ctx.plugin(learning, {});
  await learningFiber;
  const shellFiber = ctx.plugin(shell, {});
  t.after(async () => { await shellFiber.dispose(); await learningFiber.dispose(); await factsFiber.dispose(); await coreFiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await shellFiber;
  assert.equal(ctx.study.has('memory'), false);
  assert.equal(ctx.study.kernel.database.get("SELECT name FROM sqlite_master WHERE name = 'study_memory_item'"), undefined);
  for (const [ns, method, payload] of [['plans', 'list', {}], ['learning', 'list', {}], ['outcomes', 'day', {}], ['review', 'week', { save: false }]]) {
    const result = await ctx.study.call(ns, method, payload, { requestId: `p2-disabled-${ns}` });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test('memory runs with only core/tools, without systemPrompt, facts or learning events; disable and re-enable preserves data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'p2-memory-'));
  const ctx = new Context();
  const tools = new Map();
  const routes = new Map();
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } });
  ctx.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } });
  const coreFiber = ctx.plugin(core, { dataDir: directory });
  await coreFiber;
  let fiber;
  t.after(async () => { await fiber?.dispose(); await coreFiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(ctx.study.has('memory'), false);
  fiber = ctx.plugin(memory, {});
  await fiber;
  assert.equal(ctx.study.has('memory'), true);
  assert.equal(tools.has('memory_profile'), true);
  const write = (method, payload, requestId) => ctx.study.call('memory', method, payload, { actor: 'ui', requestId });
  const remembered = await write('remember', { text: 'prefer examples' }, 'p2-remember');
  assert.equal(remembered.ok, true);
  assert.equal((await ctx.study.call('memory', 'profileGet', {})).ok, true);
  assert.equal((await ctx.study.call('memory', 'recall', {})).value.items.length, 1);
  const metadata = ctx.study.kernel.status().modules.find(row => row.id === 'memory');
  assert.deepEqual(metadata.readContracts, memory.readContracts);
  await fiber.dispose();
  assert.equal(ctx.study.has('memory'), false);
  assert.equal(tools.has('memory_remember'), false);
  assert.equal([...routes.keys()].some(path => path.startsWith('/api/study/memory/')), false);
  assert.equal((await ctx.study.call('kernel', 'status', {})).ok, true);
  fiber = ctx.plugin(memory, {});
  await fiber;
  const recalled = await ctx.study.call('memory', 'recall', {});
  assert.equal(recalled.value.items[0].text, 'prefer examples');
  assert.equal((await write('forget', { id: recalled.value.items[0].id }, 'p2-forget')).ok, true);
  assert.equal((await ctx.study.call('memory', 'recall', {})).value.items.length, 0);
});
