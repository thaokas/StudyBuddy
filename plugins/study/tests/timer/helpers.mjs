import { fixtureCaller } from '../write-fixture.mjs';
/**
 * Shared fixtures for the timer tests.
 *
 * `bootTimer` runs the real `tasks` and `timer` host modules over one SQLite
 * file with an injectable clock. That makes time deterministic and lets a test
 * simulate an application restart by closing the kernel, moving the clock, and
 * booting the same directory again.
 *
 * `bootHost` boots the shipped plugin through `host/index.mjs` with fake host
 * services, so the service test also exercises module discovery, schema
 * creation, and the authenticated HTTP routes.
 *
 * `simulateHeartbeat` calls the module's own heartbeat body. The production
 * plugin runs it on an interval; the tests call it explicitly so a fake clock
 * can pass time without waiting.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStudyDatabase } from '../../host/db.mjs';
import { createKernel } from '../../host/kernel.mjs';
import { createRegistry } from '../../host/registry.mjs';
import * as tasksModule from '../../host/modules/tasks.mjs';
import * as timerModule from '../../host/modules/timer.mjs';
import * as study from '../../host/index.mjs';

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { Context } = requireFromSource('@deepseek-ai/cordis');

/** One simulated minute in milliseconds. */
export const MINUTE = 60_000;

/** The boot modules, in the order their dependencies require. */
const DEFINITIONS = [tasksModule, timerModule].map(module => ({
  id: module.id,
  deps: module.deps ?? [],
  schema: module.schema ?? [],
  schemaVersion: module.schemaVersion ?? 1,
  apply: module.apply,
}));

/**
 * A mutable clock shared by the database, kernel, and tests.
 * @param {string} [iso] - Initial instant.
 * @returns {{ now: () => Date, read: () => Date, set: (value: string) => void, advance: (ms: number) => void }} Clock.
 */
export function createClock(iso = '2026-11-10T01:00:00.000Z') {
  let current = new Date(iso);
  return {
    now: () => new Date(current.getTime()),
    read: () => new Date(current.getTime()),
    set: value => { current = new Date(value); },
    advance: ms => { current = new Date(current.getTime() + ms); },
  };
}

/**
 * Boot the timer module set over one database file.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string, clock?: ReturnType<typeof createClock> }} [options] - Existing directory or clock.
 * @returns {Promise<object>} Harness: `call`/`ok`/`fail`, `tick`, `close`, and the raw handles.
 */
export async function bootTimer(t, { directory: existingDirectory, clock = createClock() } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'study-timer-'));
  const created = existingDirectory === undefined;
  const database = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
  const verification = database.verifyModules(DEFINITIONS);
  assert.equal(verification.blocked, null);
  await database.applyModuleSchemas(DEFINITIONS);
  const registry = createRegistry();
  const kernel = createKernel({ database, registry, modules: DEFINITIONS, now: clock.now });
  const disposers = [];
  const ctx = {
    tools: { register: () => () => {} },
    effect(run) {
      const dispose = run();
      disposers.push(dispose);
      return () => {};
    },
    study: { register: (ns, impl) => registry.register(ns, impl) },
  };
  for (const definition of DEFINITIONS) await definition.apply(ctx, kernel);

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

  const harness = {
    directory,
    clock,
    kernel,
    database,
    registry,
    ctx,
    call,
    ok,
    fail,
    close,
    /**
     * Move the clock like the production heartbeat would: advance in steps
     * shorter than the gap limit and reconcile after each one. One big jump is
     * indistinguishable from a suspended machine, so tests that mean "the app
     * kept running" must call this.
     * @param {number} ms - Milliseconds to advance.
     */
    tick(ms = 0) {
      const step = timerModule.HEARTBEAT_MS * 2;
      let remaining = ms;
      while (remaining > step) {
        clock.advance(step);
        timerModule.reconcile(kernel);
        remaining -= step;
      }
      if (remaining !== 0) clock.advance(remaining);
      timerModule.reconcile(kernel);
    },
    /** Move the clock without a heartbeat, like a suspended machine. */
    sleep(ms) {
      clock.advance(ms);
    },
    /** Create one task and return its view. */
    async createTask(title) {
      const envelope = await ok('tasks', 'createTask', { title });
      return envelope.value.task;
    },
  };

  t.after(async () => {
    await close().catch(() => {});
    if (created) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return harness;
}

/**
 * Boot the shipped plugin through its real entry point against fake host services.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string }} [options] - Existing data directory to reopen.
 * @returns {Promise<object>} Harness with `ctx`, `fiber`, `tools`, `routes`, and timer helpers.
 */
export async function bootHost(t, { directory: existingDirectory } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'study-timer-host-'));
  const created = existingDirectory === undefined;
  const ctx = new Context();
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
  const fiber = ctx.plugin(study, { dataDir: directory });
  await fiber;
  t.after(async () => {
    try { await fiber.dispose(); } catch { /* Already disposed by the test. */ }
    if (created) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const call = fixtureCaller((...args) => ctx.study.call(...args));
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
  return { directory, ctx, fiber, tools, routes, call, ok, fail };
}
