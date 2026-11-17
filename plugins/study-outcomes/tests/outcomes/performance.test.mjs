/**
 * T13 query budget: with well over 10,000 rows (tasks, time blocks, both
 * progress tables, revision snapshots, and change-log entries) a month query
 * must stay under 100 ms. The month is rebuilt from `change_log` because no day
 * snapshot exists for it, which is the slow path the app uses for old data.
 *
 * The rows are inserted directly as a fixture: the service has no bulk import,
 * and the point of this test is read latency, not write-path validation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootOutcomes, createClock, localInstant } from './helpers.mjs';

const MONTH_START = '2026-10-01';
const MONTH_END = '2026-10-31';
const SAMPLE_DAY = '2026-10-15';

/** Two-digit day for a `1..31` index. */
function dayOf(index) {
  return String(((index - 1) % 31) + 1).padStart(2, '0');
}

/**
 * Seed the performance fixture.
 * @param {object} harness - Booted fixture.
 * @param {{ tasks: number, progressPerTask: number, changes: number, planRevisions: number, planItems: number, planProgress: number }} sizes
 *   Row counts.
 */
async function seed(harness, sizes) {
  const db = harness.database;
  const createdAt = '2026-09-20T00:00:00.000Z';
  const blockAt = '2026-11-05T00:00:00.000Z';
  await db.transaction(async () => {
    for (let index = 1; index <= sizes.tasks; index += 1) {
      const taskId = `task_perf_${index}`;
      db.run(
        `INSERT INTO study_task
           (id, title, subject, material_ref, completion_criteria, estimated_minutes, prerequisites_json, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?)`,
        taskId, `性能任务 ${index}`, '数学', null, null, 30, createdAt, createdAt,
      );
      const date = `${MONTH_START.slice(0, 8)}${dayOf(index)}`;
      const blockId = `block_perf_${index}`;
      db.run(
        `INSERT INTO study_time_block
           (id, date, start_minute, end_minute, fixed, task_id, title, note, created_at, updated_at)
         VALUES (?, ?, 540, 600, 0, ?, NULL, NULL, ?, ?)`,
        blockId, date, taskId, createdAt, createdAt,
      );
      const before = {
        id: blockId,
        date,
        start: '09:00',
        end: '10:00',
        startMinute: 540,
        endMinute: 600,
        minutes: 60,
        fixed: false,
        taskId,
        title: null,
        note: null,
        task: null,
        createdAt,
        updatedAt: createdAt,
      };
      // A no-op update after the month forces the change-log replay path while
      // keeping the block on its October date.
      db.run(
        `INSERT INTO change_log (at, actor, entity, entity_id, action, before_json, after_json, reason)
         VALUES (?, 'ui', 'time_block', ?, 'update', ?, ?, 'perf')`,
        blockAt, blockId, JSON.stringify(before), JSON.stringify(before),
      );
      for (let step = 1; step <= sizes.progressPerTask; step += 1) {
        const progressDate = `${MONTH_START.slice(0, 8)}${dayOf(index + step)}`;
        const cancelled = index % 11 === 0;
        const done = step === sizes.progressPerTask && index % 3 !== 0 && !cancelled;
        const status = cancelled ? 'cancelled' : done ? 'done' : 'partial';
        db.run(
          `INSERT INTO study_task_progress
             (task_id, date, status, quantity_done, quantity_total, note, confirmed, actor, at)
           VALUES (?, ?, ?, ?, ?, NULL, 1, 'ui', ?)`,
          taskId,
          progressDate,
          status,
          status === 'cancelled' ? null : done ? 10 : 3,
          status === 'cancelled' ? null : 10,
          `${progressDate}T12:00:00.000Z`,
        );
      }
    }

    for (let index = 1; index <= sizes.changes; index += 1) {
      db.run(
        `INSERT INTO change_log (at, actor, entity, entity_id, action, before_json, after_json, reason)
         VALUES (?, 'ui', 'task_progress', ?, 'partial', NULL, NULL, 'perf')`,
        '2026-10-20T00:00:00.000Z',
        `task_perf_${index}`,
      );
    }

    const planId = 'plan_perf';
    db.run(
      `INSERT INTO study_plan (id, goal_id, title, status, revision, revision_id, created_at, updated_at)
       VALUES (?, NULL, '性能计划', 'active', ?, NULL, ?, ?)`,
      planId, sizes.planRevisions, createdAt, createdAt,
    );
    for (let revision = 1; revision <= sizes.planRevisions; revision += 1) {
      const revisionId = `rev_perf_${revision}`;
      const items = Array.from({ length: sizes.planItems }, (_, index) => ({
        id: `item_${index + 1}`,
        title: `计划任务 ${index + 1}`,
        subject: '数学',
        materialId: null,
        locator: null,
        estimateMinutes: 30,
        date: `${MONTH_START.slice(0, 8)}${dayOf(index + 1)}`,
        start: null,
        end: null,
        flexible: true,
        completion: null,
        dependencies: [],
        note: null,
        source: 'agent',
      }));
      const data = {
        title: '性能计划',
        goalId: null,
        trial: false,
        reviewAt: null,
        stageGoals: [],
        weekGoals: [],
        availability: [],
        constraints: [],
        assumptions: [],
        items,
      };
      db.run(
        `INSERT INTO study_plan_revision
           (id, plan_id, number, status, action, reason, actor, snapshot_json, diff_json, undone_by, created_at, applied_at)
         VALUES (?, ?, ?, 'superseded', 'revise', 'perf', 'agent', ?, '{}', NULL, ?, ?)`,
        revisionId,
        planId,
        revision,
        JSON.stringify(data),
        new Date(Date.UTC(2026, 8, 29, revision)).toISOString(),
        new Date(Date.UTC(2026, 8, 29, revision)).toISOString(),
      );
    }
    for (let index = 1; index <= sizes.planProgress; index += 1) {
      const itemId = `item_${((index - 1) % sizes.planItems) + 1}`;
      const date = `${MONTH_START.slice(0, 8)}${dayOf(index)}`;
      db.run(
        `INSERT INTO study_plan_progress
           (plan_id, revision, item_id, date, status, quantity_done, quantity_total, note, confirmed, actor, at)
         VALUES (?, ?, ?, ?, 'done', 10, 10, NULL, 1, 'ui', ?)`,
        planId, sizes.planRevisions, itemId, date, `${date}T12:00:00.000Z`,
      );
    }
  });
}

/** Median of a numeric list. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

describe('query budget', () => {
  it('answers month, week, and day queries over 10k+ rows in under 100 ms', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 15, 8)) });
    await seed(harness, {
      tasks: 2_000,
      progressPerTask: 5,
      changes: 8_000,
      planRevisions: 12,
      planItems: 100,
      planProgress: 5_000,
    });
    const totalRows = Number(harness.rows(
      `SELECT (SELECT COUNT(*) FROM study_task)
            + (SELECT COUNT(*) FROM study_time_block)
            + (SELECT COUNT(*) FROM study_task_progress)
            + (SELECT COUNT(*) FROM change_log)
            + (SELECT COUNT(*) FROM study_plan_revision)
            + (SELECT COUNT(*) FROM study_plan_progress) AS total`,
    )[0].total);
    assert.ok(totalRows > 10_000, `fixture should exceed 10,000 rows, got ${totalRows}`);

    const timings = {};
    // First call warms the prepared statements and writes today's snapshot.
    await harness.outcomes('month', { date: SAMPLE_DAY });
    for (const [label, method, payload] of [
      ['month', 'month', { date: SAMPLE_DAY }],
      ['week', 'week', { date: SAMPLE_DAY }],
      ['day', 'day', { date: SAMPLE_DAY }],
    ]) {
      const samples = [];
      let value;
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        value = await harness.outcomes(method, payload);
        samples.push(performance.now() - started);
      }
      timings[label] = { median: median(samples), max: Math.max(...samples) };
      assert.ok(timings[label].median < 100, `${label} median ${timings[label].median.toFixed(1)} ms should be under 100 ms`);
      assert.equal(value.scope, method);
    }

    const month = await harness.outcomes('month', { date: SAMPLE_DAY });
    assert.equal(month.from, MONTH_START);
    assert.equal(month.to, MONTH_END);
    assert.equal(month.days.length, 31);
    assert.ok(month.completion.original.planned >= 2_000, 'the fixture tasks are in the original plan');
    assert.ok(month.baseline.changeLogDates.length === 31, 'the month is rebuilt from the change log');
    assert.ok(timings.month.median < 100);
    t.diagnostic(`outcomes query timing: ${JSON.stringify(timings)}`);
  });
});
