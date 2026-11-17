import { fixtureCaller } from '../../../../tests/support/write-fixture.mjs';
import { randomUUID } from 'node:crypto';
/**
 * Shared fixture for the tutoring tests: boot the shipped plugin in a temporary
 * data directory with recordable fake host services, seed tasks, materials and
 * a confirmed plan through the frozen `ctx.study` contract, and expose the
 * fake Agent registry the tutoring module injects into.
 *
 * `agents.add()` returns a fake Agent with only `inject()`; it deliberately has
 * no `session`, so a module that tried to read chat state would fail here.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { localDate } from '../../../study-core/host/kernel.mjs';
import * as study from '../../../../tests/support/composed-host.mjs';

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { Context } = requireFromSource('@deepseek-ai/cordis');

/**
 * Mount the host services the study plugin needs and record their contributions.
 * @param {object} ctx - Cordis test context.
 * @param {boolean} withAgents - Whether to provide the fake Agent registry.
 * @returns {{ tools: Array<object>, routes: Array<object>, agents: Map<string, object>,
 *   add: (sessionId: string) => object, remove: (sessionId: string) => void }} Recorders.
 */
function mountServices(ctx, withAgents) {
  const tools = [];
  const routes = [];
  const agents = new Map();
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
  if (withAgents) {
    ctx.provide('agents', { get: sessionId => agents.get(sessionId) });
  }
  return {
    tools,
    routes,
    agents,
    /** Add one live fake Agent for a session id. */
    add(sessionId) {
      const agent = {
        id: sessionId,
        messages: [],
        inject(message) { agent.messages.push(message); },
      };
      agents.set(sessionId, agent);
      return agent;
    },
    /** Remove a live fake Agent, as a session unload does. */
    remove(sessionId) { agents.delete(sessionId); },
  };
}

/**
 * Read rows from the same SQLite file the service holds open. The connection is
 * read-only and only used for evidence the service does not expose.
 * @param {{ directory: string }} harness - Booted fixture.
 * @param {string} sql - Query text.
 * @param {...unknown} params - Bound parameters.
 * @returns {Array<Record<string, unknown>>} Rows.
 */
export function readRows(harness, sql, ...params) {
  const db = new DatabaseSync(join(harness.directory, 'study.db'), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/**
 * Boot the study plugin in a temporary data directory, or in an existing one.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string, cleanup?: boolean, withoutAgents?: boolean }} [options]
 *   Existing directory to reopen, whether to remove the temporary one, and
 *   whether to omit the fake Agent registry.
 * @returns {Promise<object>} Harness handle.
 */
export async function boot(t, { directory: existingDirectory, cleanup = true, withoutAgents = false } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'study-tutoring-'));
  const ctx = new Context();
  const mount = mountServices(ctx, !withoutAgents);
  const fiber = ctx.plugin(study, { dataDir: directory });
  await fiber;
  const rawCall = ctx.study.call;
  const fixtureCall = fixtureCaller((...args) => rawCall(...args));
  t.after(async () => {
    try { await fiber.dispose(); } catch { /* Already disposed by the test. */ }
    if (cleanup) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const call = (method, payload, options) => ctx.study.call('tutoring', method, payload, {requestId:randomUUID(),...options});
  const ok = async (method, payload, options) => {
    const envelope = await call(method, payload, options);
    assert.equal(envelope.ok, true, `expected tutoring.${method} to succeed: ${JSON.stringify(envelope)}`);
    return envelope.value;
  };
  const fail = async (method, payload, options) => {
    const envelope = await call(method, payload, options);
    assert.equal(envelope.ok, false, `expected tutoring.${method} to fail: ${JSON.stringify(envelope)}`);
    return envelope;
  };
  const tool = async (name, args, exec = {}) => {
    const definition = mount.tools.find(item => item.name === name);
    assert.ok(definition, `${name} tool should be registered`);
    return definition.execute(args, { signal: new AbortController().signal, callId:randomUUID(), ...exec });
  };
  const harness = {
    ctx,
    fiber,
    directory,
    tools: mount.tools,
    routes: mount.routes,
    agents: mount,
    call,
    ok,
    fail,
    tool,
  };
  harness.link = sessionId => {
    const row = readRows(harness, 'SELECT * FROM study_tutoring_link WHERE session_id = ?', sessionId);
    return row.length === 0 ? undefined : { ...row[0] };
  };
  harness.changes = entity => readRows(
    harness,
    'SELECT actor, entity, entity_id, action, before_json, after_json, reason FROM change_log WHERE entity = ? ORDER BY id',
    entity,
  ).map(row => ({ ...row }));
  harness.waitFor = async (predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return predicate();
  };
  return harness;
}

/** Local `YYYY-MM-DD` shifted by whole days from today. */
export function dateAfter(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}

/** Create one task through the `tasks` service. */
export async function createTask(harness, overrides = {}) {
  const envelope = await fixtureCaller((...args) => harness.ctx.study.call(...args))('tasks', 'createTask', {
    title: '第二章 导数习题',
    subject: '数学',
    completionCriteria: '做完 1-10 题并订正错题',
    estimatedMinutes: 30,
    ...overrides,
  }, {requestId:randomUUID()});
  assert.equal(envelope.ok, true, `expected createTask to succeed: ${JSON.stringify(envelope)}`);
  return envelope.value.task;
}

/** Import one text material through the `materials` service. */
export async function createMaterial(harness, overrides = {}) {
  const envelope = await fixtureCaller((...args) => harness.ctx.study.call(...args))('materials', 'importText', {
    kind: 'workbook',
    title: '数学练习册',
    text: '第二章 导数\n第一题：求 x^2 的导数。\n第二题：求 sin(x) 的导数。',
    ...overrides,
  }, {requestId:randomUUID()});
  assert.equal(envelope.ok, true, `expected importText to succeed: ${JSON.stringify(envelope)}`);
  return envelope.value.material;
}

/** Create and confirm one plan with one item matching `taskTitle` today. */
export async function createPlan(harness, { taskTitle = '第二章 导数习题', date = dateAfter(0) } = {}) {
  const draft = await fixtureCaller((...args) => harness.ctx.study.call(...args))('plans', 'saveDraft', {
    title: '冒烟学习计划',
    baseRevision: 0, expectedDraftRevision:0,
    availability: [{ date, minutes: 120 }],
    items: [
      { title: taskTitle, subject: '数学', estimateMinutes: 30, date, start: '19:00', end: '19:30' },
    ],
  }, {requestId:randomUUID()});
  assert.equal(draft.ok, true, `expected saveDraft to succeed: ${JSON.stringify(draft)}`);
  const confirmed = await fixtureCaller((...args) => harness.ctx.study.call(...args))('plans', 'confirm', { baseRevision: 0, expectedDraftRevision:draft.value.draft.draftRevision }, {requestId:randomUUID()});
  assert.equal(confirmed.ok, true, `expected confirm to succeed: ${JSON.stringify(confirmed)}`);
  return confirmed.value;
}
