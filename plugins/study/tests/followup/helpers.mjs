import { fixtureCaller } from '../write-fixture.mjs';
import { randomUUID } from 'node:crypto';
/**
 * Shared fixture for the T12 followup tests.
 *
 * The harness boots the shipped `materials`, `plans`, `tasks`, `timer`, and
 * `followup` host modules over one SQLite file with an injectable clock. The
 * fake context provides exactly the `effect`, `study`, and `tools` faces those
 * modules use, so the tests exercise the real service contract and schemas
 * without a DSH process.
 *
 * `advance` moves the clock the way a running app does: in steps shorter than
 * the followup staleness limit, with the followup heartbeat and the timer
 * reconciliation running after each step. `jump` moves the clock without a
 * heartbeat, which is how a closed, suspended, or crashed app looks to the
 * module. That distinction is what makes "关闭应用不补发历史提醒" deterministic.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStudyDatabase } from '../../host/db.mjs';
import { createKernel, localDate } from '../../host/kernel.mjs';
import { createRegistry } from '../../host/registry.mjs';
import { sortModuleDefinitions } from '../../host/index.mjs';
import * as followupModule from '../../host/modules/followup.mjs';
import * as materialsModule from '../../host/modules/materials.mjs';
import * as plansModule from '../../host/modules/plans.mjs';
import * as tasksModule from '../../host/modules/tasks.mjs';
import * as timerModule from '../../host/modules/timer.mjs';

const MODULES = [followupModule, materialsModule, plansModule, tasksModule, timerModule];

const DEFINITIONS = sortModuleDefinitions(MODULES.map(module => ({
  id: module.id,
  deps: module.deps ?? [],
  schema: module.schema ?? [],
  schemaVersion: module.schemaVersion ?? 1,
  apply: module.apply,
})));

/** How far one simulated running-app step advances the clock. */
export const STEP_MS = 30_000;

/**
 * A mutable clock shared by the database, kernel, and tests.
 * @param {Date} [local] - Initial local instant.
 * @returns {{ now: () => Date, read: () => Date, set: (value: Date | string) => void, advance: (ms: number) => void }} Clock.
 */
export function createClock(local = new Date(2026, 10, 10, 8, 0, 0)) {
  let current = new Date(local);
  return {
    now: () => new Date(current.getTime()),
    read: () => new Date(current.getTime()),
    set: (value) => { current = new Date(value); },
    advance: (ms) => { current = new Date(current.getTime() + ms); },
  };
}

/** Local `YYYY-MM-DD` shifted by whole days from the clock's current instant. */
export function dateAt(clock, offset = 0) {
  const date = clock.read();
  date.setDate(date.getDate() + offset);
  return localDate(date);
}

/** Local `YYYY-MM-DD` shifted by whole days from a date text. */
export function addDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

/**
 * Local ISO instant on a date offset at a `HH:MM` time.
 * @param {ReturnType<typeof createClock>} clock - Shared clock.
 * @param {number} offset - Whole days from the clock's date.
 * @param {string} time - Local `HH:MM`.
 * @returns {string} ISO instant.
 */
export function isoAt(clock, offset, time) {
  const base = clock.read();
  const [hours, minutes] = time.split(':').map(Number);
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hours, minutes, 0, 0);
  return date.toISOString();
}

/**
 * Boot the followup module set over one database file.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string, clock?: ReturnType<typeof createClock>, cleanup?: boolean }} [options]
 *   Existing directory to reopen, the shared clock, and whether the temporary directory is removed.
 * @returns {Promise<object>} Harness with service callers, clock helpers, and fixtures.
 */
export async function bootFollowup(t, { directory: existingDirectory, clock = createClock(), cleanup = true } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'study-followup-'));
  const database = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
  const verification = database.verifyModules(DEFINITIONS);
  assert.equal(verification.blocked, null, 'the fresh database should accept every module schema');
  await database.applyModuleSchemas(DEFINITIONS);

  const registry = createRegistry();
  const kernel = createKernel({ database, registry, modules: DEFINITIONS, now: clock.now });
  const disposers = [];
  const tools = [];
  const ctx = {
    effect(run) {
      const dispose = run();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    study: {
      register: (ns, impl) => registry.register(ns, impl),
      call: (ns, method, payload, options) => kernel.call(ns, method, payload, { requestId: randomUUID(), ...options }),
    },
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

  let closed = false;
  let ownsCleanup = cleanup;
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
    return envelope.value;
  };
  const fail = async (ns, method, payload, options) => {
    const envelope = await call(ns, method, payload, options);
    assert.equal(envelope.ok, false, `expected ${ns}.${method} to fail: ${JSON.stringify(envelope)}`);
    return envelope;
  };
  const followup = (method, payload, options) => ok('followup', method, payload, options);
  const followupFail = (method, payload, options) => fail('followup', method, payload, options);

  const harness = {
    directory,
    clock,
    database,
    registry,
    kernel,
    ctx,
    tools,
    call,
    ok,
    fail,
    followup,
    followupFail,
    close,
    /** The clock's current local date, shifted by whole days. */
    date: offset => dateAt(clock, offset),
    /** The clock's current local date; the default review/reminder day. */
    today: () => dateAt(clock, 0),
    /** Move the clock like a running app: heartbeat and timer reconcile after every step. */
    advance(ms) {
      let remaining = ms;
      while (remaining > 0) {
        const delta = Math.min(STEP_MS, remaining);
        clock.advance(delta);
        followupModule.heartbeat(kernel);
        timerModule.reconcile(kernel);
        remaining -= delta;
      }
    },
    /** Move the clock without heartbeats, like a closed or suspended app. */
    jump(ms) {
      clock.advance(ms);
    },
    /** Run one followup heartbeat explicitly at the current clock instant. */
    heartbeat() {
      followupModule.heartbeat(kernel);
    },
    /** Create one task through the frozen task service. */
    async createTask(title, overrides = {}) {
      const value = await ok('tasks', 'createTask', { title, ...overrides });
      return value.task;
    },
    /** Create one time block through the frozen task service. */
    async createBlock(payload) {
      const value = await ok('tasks', 'createBlock', payload);
      return value.block;
    },
    /** Record task progress through the frozen task service. */
    async recordTaskProgress(payload) {
      const value = await ok('tasks', 'recordProgress', payload);
      return value;
    },
    /** Save and (by default) confirm one plan; returns the draft payload's plan/draft views. */
    async createPlan({ title = '复盘测试计划', availability = [], items, goalId, confirm = true } = {}) {
      const payload = { title, baseRevision: 0, expectedDraftRevision:0, availability, items };
      if (goalId !== undefined) payload.goalId = goalId;
      const saved = await ok('plans', 'saveDraft', payload);
      if (confirm) {
        await ok('plans', 'confirm', {expectedDraftRevision:saved.draft.draftRevision, planId: saved.plan.id, baseRevision: 0 });
      }
      return saved;
    },
    /** Read one plan with its applied revision, draft, capacity, and summary. */
    async plan(planId) {
      return ok('plans', 'get', planId === undefined ? {} : { planId });
    },
    /** Read plan progress for one plan. */
    async planProgress(planId, itemId) {
      const payload = { planId };
      if (itemId !== undefined) payload.itemId = itemId;
      return ok('plans', 'progress', payload);
    },
    /** Record one plan progress row. */
    async recordPlanProgress(payload) {
      return ok('plans', 'recordProgress', payload);
    },
    /** Boot at a later clock instant against the same directory, after closing this one. */
    async restart(nextClock) {
      ownsCleanup = false;
      await close();
      const next = await bootFollowup(t, { directory, clock: nextClock, cleanup });
      return next;
    },
  };

  t.after(async () => {
    await close().catch(() => {});
    if (ownsCleanup) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return harness;
}

/**
 * One plan item shaped for `saveDraft`.
 * @param {object} overrides - Field overrides.
 * @returns {object} Item payload.
 */
export function item(overrides = {}) {
  return {
    title: '数学练习',
    estimateMinutes: 60,
    date: '2026-11-10',
    start: '19:00',
    end: '20:00',
    flexible: true,
    ...overrides,
  };
}

/**
 * Find an item in an applied or draft plan document by title.
 * @param {object} data - Plan document.
 * @param {string} title - Item title.
 * @returns {object} Item view.
 */
export function itemByTitle(data, title) {
  const found = data.items.find(entry => entry.title === title);
  assert.ok(found, `expected the plan to contain "${title}"`);
  return found;
}
