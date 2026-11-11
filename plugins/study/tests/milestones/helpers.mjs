import { fixtureCaller } from '../write-fixture.mjs';
/**
 * Shared fixtures for the T14 milestone tests.
 *
 * The fixture boots the shipped `materials`, `tasks`, `plans`, `outcomes`, and
 * `milestones` modules over one SQLite file with an injectable clock. It reuses
 * the T13 fixture (same local dates, same service helpers) and then applies the
 * milestones module, so the service reads the same facts the app would.
 *
 * `bootMilestonesOnly` is the failure fixture: the milestones module alone, no
 * `outcomes` service, which proves the module reports a clear failure instead of
 * inventing an empty period.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStudyDatabase } from '../../host/db.mjs';
import { createKernel } from '../../host/kernel.mjs';
import { createRegistry } from '../../host/registry.mjs';
import * as milestonesModule from '../../host/modules/milestones.mjs';
import { bootOutcomes, createClock, formatDate, localInstant } from '../outcomes/helpers.mjs';

export { createClock, formatDate, localInstant };

/**
 * Boot the T13 fixture and add the milestones module on top.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string, clock?: ReturnType<typeof createClock>, cleanup?: boolean }} [options]
 *   Existing directory (restart test), clock, or keep-the-directory switch.
 * @returns {Promise<object>} Harness with the milestones callers and seed helpers.
 */
export async function bootMilestones(t, options = {}) {
  const harness = await bootOutcomes(t, options);
  // Capture only the tools the milestones module tries to register: the T13
  // modules already registered theirs, and this task must add none.
  const toolsRegistered = [];
  if (harness.ctx.tools !== undefined) {
    const register = harness.ctx.tools.register.bind(harness.ctx.tools);
    harness.ctx.tools.register = definition => {
      toolsRegistered.push(String(definition?.name));
      return register(definition);
    };
  }
  await milestonesModule.apply(harness.ctx, harness.kernel);

  const overview = async (payload = {}) => (await harness.ok('milestones', 'overview', payload)).value;
  const feedback = async (payload = {}) => (await harness.ok('milestones', 'feedback', payload)).value;

  /**
   * Create one task and record a confirmed `done` entry for it.
   * @param {string} title - Task title.
   * @param {string} date - Learning date.
   * @param {{ task?: object, progress?: object }} [overrides] - Extra fields.
   * @returns {Promise<{ task: object, record: object }>} Stored task and record.
   */
  const doneTask = async (title, date, { task = {}, progress = {} } = {}) => {
    const created = await harness.task(title, task);
    const record = await harness.taskProgress(created.id, 'done', date, progress);
    return { task: created, record };
  };

  /**
   * Record one confirmed `done` entry for a plan item.
   * @param {{ planId: string }} plan - Plan returned by `harness.plan`.
   * @param {string} itemId - Plan item id.
   * @param {string} date - Learning date.
   * @param {object} [progress] - Extra record fields.
   * @returns {Promise<object>} Stored record.
   */
  const donePlanItem = async (plan, itemId, date, progress = {}) => (
    harness.planProgress(plan.planId, itemId, 'done', date, progress)
  );

  return { ...harness, overview, feedback, doneTask, donePlanItem, toolsRegistered };
}

/**
 * Boot only the milestones module, with no outcomes dependency registered.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ clock?: ReturnType<typeof createClock> }} [options] - Clock override.
 * @returns {Promise<{ call: Function, registry: object, kernel: object, directory: string }>} Harness.
 */
export async function bootMilestonesOnly(t, options = {}) {
  const clock = options.clock ?? createClock();
  const directory = await mkdtemp(join(tmpdir(), 'study-milestones-only-'));
  const database = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
  const registry = createRegistry();
  const kernel = createKernel({ database, registry, now: clock.now });
  const disposers = [];
  const ctx = {
    effect(run) {
      const dispose = run();
      disposers.push(dispose);
      return () => {};
    },
    study: { register: (ns, impl) => registry.register(ns, impl) },
  };
  await milestonesModule.apply(ctx, kernel);
  t.after(async () => {
    for (const dispose of disposers.splice(0)) {
      if (typeof dispose === 'function') await dispose();
    }
    await kernel.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return {
    directory,
    kernel,
    registry,
    clock,
    call: fixtureCaller((...args) => kernel.call(...args)),
  };
}

/**
 * Read every confirmed `done` progress row id from the test database, for
 * cross-checking milestone evidence against stored records.
 * @param {object} harness - Booted T14 fixture.
 * @returns {{ tasks: number[], plans: number[] }} Record ids by kind.
 */
export function storedDoneIds(harness) {
  return {
    tasks: harness.rows('SELECT id FROM study_task_progress WHERE status = ? AND confirmed = 1 ORDER BY id', 'done')
      .map(row => Number(row.id)),
    plans: harness.rows('SELECT id FROM study_plan_progress WHERE status = ? AND confirmed = 1 ORDER BY id', 'done')
      .map(row => Number(row.id)),
  };
}

/**
 * The one flat milestone list of an overview document.
 * @param {object} value - `milestones.overview` value.
 * @returns {Array<object>} Milestones of the week followed by the month.
 */
export function allMilestones(value) {
  return [...value.week.milestones, ...value.month.milestones];
}
