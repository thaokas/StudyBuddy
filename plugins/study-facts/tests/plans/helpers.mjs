import { fixtureCaller } from '../../../../tests/support/write-fixture.mjs';
import { randomUUID } from 'node:crypto';
/**
 * Shared fixture for the plans tests: boot the shipped plugin against fake host
 * services (tools + connection) in a temporary data directory, and build plan
 * payloads whose dates are relative to the real local "today" the kernel uses.
 *
 * The plugin is booted through `host/index.mjs`, so these tests exercise module
 * discovery, the real service contract, and the materials tables the plans
 * module reads for goals and materials.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate } from '../../../study-core/host/kernel.mjs';
import * as study from '../../../../tests/support/composed-host.mjs';

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { Context } = requireFromSource('@deepseek-ai/cordis');

function mountServices(ctx) {
  const tools = [];
  const routes = [];
  ctx.provide('tools', {
    register(definition) {
      tools.push(definition);
      return () => {
        const index = tools.indexOf(definition);
        if (index >= 0) tools.splice(index, 1);
      };
    },
  });
  ctx.provide('connection', {
    fetch: {
      register(route) {
        routes.push(route);
        return async () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
  });
  return { tools, routes };
}

/**
 * Boot the study plugin in a temporary data directory, or in an existing one to
 * test what a restart reads back.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string, cleanup?: boolean }} [options] - Existing data directory to reopen;
 *   `cleanup: false` keeps the temporary directory for a later boot to own.
 * @returns {Promise<object>} Harness handle with `call`/`ok`/`fail`, `tool(name, args)`, and read helpers.
 */
export async function boot(t, { directory: existingDirectory, cleanup = true } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'study-plans-'));
  const ctx = new Context();
  const { tools, routes } = mountServices(ctx);
  const fiber = ctx.plugin(study, { dataDir: directory });
  await fiber;
  t.after(async () => {
    try { await fiber.dispose(); } catch { /* Already disposed by the test. */ }
    if (cleanup) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const fixtureCall = fixtureCaller((...args) => ctx.study.call(...args));
  const call = (method, payload, options) => fixtureCall('plans', method, payload, options);
  const materials = (method, payload, options) => fixtureCall('materials', method, payload, options);
  const ok = async (method, payload, options) => {
    const envelope = await call(method, payload, options);
    assert.equal(envelope.ok, true, `expected plans.${method} to succeed: ${JSON.stringify(envelope)}`);
    return envelope.value;
  };
  const fail = async (method, payload, options) => {
    const envelope = await call(method, payload, options);
    assert.equal(envelope.ok, false, `expected plans.${method} to fail: ${JSON.stringify(envelope)}`);
    return envelope;
  };
  const tool = async (name, args, options = {}) => {
    const definition = tools.find(item => item.name === name);
    assert.ok(definition, `${name} tool should be registered`);
    if (name === 'study_plan' && args.action === 'draft' && !args.planId) args = { ...args, expectedDraftRevision: args.expectedDraftRevision ?? 0 };
    if(name==='study_plan' && !['today','week','get'].includes(args.action) && args.expectedDraftRevision===undefined) {
      const detail=await ctx.study.call('plans','get',{planId:args.planId});
      args={...args,expectedDraftRevision:detail.value?.draft?.draftRevision??0};
    }
    return definition.execute(args, { signal: new AbortController().signal, callId: options.callId ?? randomUUID() });
  };
  return {
    ctx,
    fiber,
    tools,
    routes,
    directory,
    call,
    ok,
    fail,
    tool,
    materials,
  };
}

/** Local `YYYY-MM-DD` shifted by whole days from today. */
export function dateAfter(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}

/** Local `YYYY-MM-DD` shifted by whole days from `dateText`. */
export function addDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

/** Monday of the local week containing `dateText` (defaults to today). */
export function weekStartOf(dateText = dateAfter(0)) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return localDate(date);
}

/** One study item with a slot on `date`. */
export function item(overrides = {}) {
  return {
    id: `item_${crypto.randomUUID()}`,
    title: '第二章 习题 1-10',
    subject: '数学',
    estimateMinutes: 60,
    date: dateAfter(0),
    start: '19:00',
    end: '20:00',
    ...overrides,
  };
}

/** A complete draft payload whose two items exactly fill 120 available minutes today. */
export function planPayload(overrides = {}) {
  return {
    title: '2026 考研数学计划',
    baseRevision: 0,
    availability: [{ date: dateAfter(0), minutes: 120 }],
    stageGoals: [{ title: '完成高数强化', dueDate: dateAfter(30), target: '全书两轮' }],
    weekGoals: [{ weekStart: dateAfter(0), title: '本周完成第二章', target: '习题 1-20' }],
    constraints: ['晚上 10 点后不安排'],
    assumptions: ['每题约 6 分钟'],
    items: [
      item({ title: '第二章 习题 1-10' }),
      item({ title: '错题订正', start: '20:10', end: '21:10' }),
    ],
    ...overrides,
  };
}

/** Create one goal through the frozen materials service. */
export async function createGoal(harness, overrides = {}) {
  const result = await harness.materials('saveGoal', {
    exam: '考研数学一',
    examYear: 2027,
    deadline: dateAfter(40),
    dailyMinutes: 120,
    ...overrides,
  });
  assert.equal(result.ok, true, `expected saveGoal to succeed: ${JSON.stringify(result)}`);
  return result.value.goal;
}

/** Import one text material through the frozen materials service. */
export async function createMaterial(harness, overrides = {}) {
  const result = await harness.materials('importText', {
    kind: 'workbook',
    title: '数学练习册',
    text: '第二章 导数\n第一题：求导。\n第二题：求导。',
    ...overrides,
  });
  assert.equal(result.ok, true, `expected importText to succeed: ${JSON.stringify(result)}`);
  return result.value.material;
}
