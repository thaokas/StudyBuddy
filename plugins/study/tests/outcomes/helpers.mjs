import { fixtureCaller } from '../write-fixture.mjs';
import { randomUUID } from 'node:crypto';
/**
 * Shared fixture for the T13 outcomes tests.
 *
 * The fixture boots the real `materials`, `tasks`, `plans` and `outcomes` host
 * modules over one SQLite file with an injectable clock, so every local date
 * boundary, day snapshot, revision `applied_at`, and progress date is
 * deterministic. The plugin's own entry point cannot inject a clock, so these
 * tests apply the shipped module definitions directly and mimic the host's
 * final `ensureDaySnapshot()` step.
 *
 * The helper also exposes the open database for fixture seeding (the
 * performance test) and a read-only snapshot reader for the evidence
 * assertions.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStudyDatabase } from '../../host/db.mjs';
import { sortModuleDefinitions } from '../../host/index.mjs';
import { createKernel } from '../../host/kernel.mjs';
import { createRegistry } from '../../host/registry.mjs';
import * as materialsModule from '../../host/modules/materials.mjs';
import * as outcomesModule from '../../host/modules/outcomes.mjs';
import * as plansModule from '../../host/modules/plans.mjs';
import * as tasksModule from '../../host/modules/tasks.mjs';

/** The modules the statistics read from, in dependency order. */
const DEFINITIONS = sortModuleDefinitions([materialsModule, tasksModule, plansModule, outcomesModule].map(module => ({
  id: module.id,
  deps: module.deps ?? [],
  schema: module.schema ?? [],
  schemaVersion: module.schemaVersion ?? 1,
  apply: module.apply,
})));

/** The default test instant: local morning of 2026-11-10 (a Tuesday). */
export const DEFAULT_START = localInstant(2026, 11, 10, 8, 0);

/**
 * One local wall-clock instant, so tests do not depend on the runner's UTC
 * offset. Every date assertion uses the same local calendar the host uses.
 * @param {number} year - Full year.
 * @param {number} month - 1-based month.
 * @param {number} day - Day of month.
 * @param {number} [hour] - Local hour.
 * @param {number} [minute] - Local minute.
 * @returns {Date} Instant.
 */
export function localInstant(year, month, day, hour = 8, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/**
 * Format one instant as the host's local `YYYY-MM-DD`.
 * @param {Date} date - Instant.
 * @returns {string} Local date.
 */
export function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * A mutable clock read by the database, kernel, and tests.
 * @param {Date} [initial] - Starting instant.
 * @returns {{ now: () => Date, read: () => Date, set: (value: Date | string) => void, setLocal: Function, advance: (ms: number) => void, date: () => string }}
 *   Clock handle; `setLocal` moves to a local wall-clock instant.
 */
export function createClock(initial = new Date(DEFAULT_START.getTime())) {
  let current = new Date(initial.getTime());
  return {
    now: () => new Date(current.getTime()),
    read: () => new Date(current.getTime()),
    set(value) {
      current = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    },
    setLocal(year, month, day, hour = 8, minute = 0) {
      current = localInstant(year, month, day, hour, minute);
    },
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    date: () => formatDate(current),
  };
}

/**
 * Boot the four shipped modules in a temporary data directory, or reopen one.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string, clock?: ReturnType<typeof createClock>, cleanup?: boolean }} [options]
 *   Existing directory (restart test), clock, or keep-the-directory switch.
 * @returns {Promise<object>} Harness with service callers and fixture helpers.
 */
export async function bootOutcomes(t, { directory: existingDirectory, clock = createClock(), cleanup = true } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'study-outcomes-'));
  const created = existingDirectory === undefined;
  const database = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
  const verification = database.verifyModules(DEFINITIONS);
  assert.equal(verification.blocked, null, `module schemas should verify: ${JSON.stringify(verification.blocked)}`);
  await database.applyModuleSchemas(DEFINITIONS);

  const registry = createRegistry();
  const kernel = createKernel({ database, registry, modules: DEFINITIONS, now: clock.now });
  const disposers = [];
  const tools = [];
  const ctx = {
    effect(run) {
      const dispose = run();
      disposers.push(dispose);
      return () => {};
    },
    study: { register: (ns, impl) => registry.register(ns, impl) },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {
          const index = tools.indexOf(definition);
          if (index >= 0) tools.splice(index, 1);
        };
      },
    },
  };
  for (const definition of DEFINITIONS) await definition.apply(ctx, kernel);
  // The shipped host entry writes today's snapshot after every module applied;
  // mirror that so the first query sees the same state the app would.
  await kernel.ensureDaySnapshot();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const dispose of disposers.splice(0)) {
      if (typeof dispose === 'function') await dispose();
    }
    await kernel.close();
  };

  const call = fixtureCaller((...args) => kernel.call(...args));
  const ok = async (ns, method, payload, options) => {
    const envelope = await call(ns, method, payload, options);
    assert.equal(envelope.ok, true, `expected ${ns}.${method} to succeed: ${JSON.stringify(envelope)}`);
    return envelope;
  };
  const fail = async (ns, method, payload, options) => {
    const envelope = await call(ns, method, payload, options);
    assert.equal(envelope.ok, false, `expected ${ns}.${method} to fail: ${JSON.stringify(envelope)}`);
    return envelope;
  };
  const outcomes = async (method, payload) => (await ok('outcomes', method, payload)).value;

  /**
   * Create one task.
   * @param {string} title - Task title.
   * @param {object} [overrides] - Extra task fields.
   * @returns {Promise<object>} Task view.
   */
  const task = async (title, overrides = {}) => (await ok('tasks', 'createTask', { title, ...overrides })).value.task;

  /**
   * Create one time block.
   * @param {string} taskId - Linked task id.
   * @param {string} date - Local date.
   * @param {string} [start] - Start time.
   * @param {string} [end] - End time.
   * @param {object} [overrides] - Extra block fields.
   * @returns {Promise<object>} Block view.
   */
  const block = async (taskId, date, start = '09:00', end = '10:00', overrides = {}) => (
    await ok('tasks', 'createBlock', { taskId, date, start, end, ...overrides })
  ).value.block;

  /**
   * Record one task progress entry.
   * @param {string} taskId - Task id.
   * @param {string} status - Progress state.
   * @param {string} date - Learning date.
   * @param {object} [overrides] - Quantities, note, confirmation.
   * @returns {Promise<object>} Progress view.
   */
  const taskProgress = async (taskId, status, date, overrides = {}) => (
    await ok('tasks', 'recordProgress', { taskId, status, date, ...overrides })
  ).value.record;

  /**
   * Import one text material.
   * @param {string} title - Material title.
   * @param {object} [overrides] - Import fields.
   * @returns {Promise<object>} Material view.
   */
  const material = async (title, overrides = {}) => (
    await ok('materials', 'importText', { title, kind: 'workbook', text: `${title} 第一章 测试内容`, ...overrides })
  ).value.material;

  /**
   * Save a draft and confirm it as revision 1.
   * @param {Array<object>} items - Plan items.
   * @param {object} [overrides] - Draft/confirm fields.
   * @returns {Promise<{ planId: string, items: object[], draft: object, confirmed: object }>} Stored plan.
   */
  const plan = async (items, overrides = {}) => {
    const { title = 'T13 测试计划', ...rest } = overrides;
    const draft = await ok('plans', 'saveDraft', { title, baseRevision: 0, items, ...rest });
    const planId = draft.value.plan.id;
    const confirmed = await ok('plans', 'confirm', { planId, baseRevision: 0 });
    return { planId, items: confirmed.value.revision.data.items, draft: draft.value, confirmed: confirmed.value };
  };

  /**
   * Apply one revision to an existing plan.
   * @param {string} planId - Plan id.
   * @param {number} baseRevision - Current formal revision.
   * @param {Array<object>} items - Full new item list.
   * @param {object} [overrides] - Reason and revision fields.
   * @returns {Promise<object>} Revise result.
   */
  const revise = async (planId, baseRevision, items, overrides = {}) => {
    const { reason = '测试修订', ...rest } = overrides;
    return (await ok('plans', 'revise', { planId, baseRevision, reason, items, ...rest })).value;
  };

  /**
   * Record one plan-item progress entry.
   * @param {string} planId - Plan id.
   * @param {string} itemId - Plan item id.
   * @param {string} status - Progress state.
   * @param {string} date - Learning date.
   * @param {object} [overrides] - Quantities, note, confirmation.
   * @returns {Promise<object>} Progress record.
   */
  const planProgress = async (planId, itemId, status, date, overrides = {}) => (
    await ok('plans', 'recordProgress', { planId, itemId, status, date, ...overrides })
  ).value.record;

  /**
   * Read and parse one persisted day snapshot.
   * @param {string} date - Local date.
   * @returns {{ date: string, plan: object, createdAt: string } | null} Snapshot.
   */
  const snapshot = date => {
    const row = database.get('SELECT date, plan_json, created_at FROM day_snapshot WHERE date = ?', date);
    if (row === undefined) return null;
    return { date: String(row.date), plan: JSON.parse(row.plan_json), createdAt: String(row.created_at) };
  };

  /**
   * Read rows through a separate read-only connection, for evidence the
   * service does not expose.
   * @param {string} sql - Query text.
   * @param {...unknown} params - Bound parameters.
   * @returns {Array<Record<string, unknown>>} Rows.
   */
  const rows = (sql, ...params) => {
    const readOnly = new DatabaseSync(join(directory, 'study.db'), { readOnly: true });
    try {
      return readOnly.prepare(sql).all(...params);
    } finally {
      readOnly.close();
    }
  };

  const harness = {
    ctx,
    kernel,
    database,
    registry,
    directory,
    clock,
    call,
    ok,
    fail,
    outcomes,
    task,
    block,
    taskProgress,
    material,
    plan,
    revise,
    planProgress,
    snapshot,
    rows,
    close,
  };

  t.after(async () => {
    await close().catch(() => {});
    if (created && cleanup) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return harness;
}

/**
 * A plan item with a stable, explicit id.
 * @param {object} overrides - Item fields.
 * @returns {object} Normalized plan item payload.
 */
export function item(overrides = {}) {
  return {
    title: '第二章 习题 1-10',
    subject: '数学',
    estimateMinutes: 30,
    date: '2026-11-11',
    ...overrides,
  };
}

/**
 * Build `count` plan items with explicit ids `item_1` … `item_N`.
 * @param {number} count - Item count.
 * @param {object} [overrides] - Shared item fields.
 * @returns {Array<object>} Item payloads.
 */
export function items(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => item({
    id: `item_${index + 1}`,
    title: `计划任务 ${index + 1}`,
    ...overrides,
  }));
}
