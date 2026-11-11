/**
 * T13 day snapshots: the once-per-day task baseline the kernel writes at the
 * day's first open, its write-once rule, and the evidence that the statistics
 * read it instead of inventing a baseline from the current schedule.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootOutcomes, createClock, localInstant } from './helpers.mjs';

describe('day snapshot baseline', () => {
  it('records the first-open task baseline and never rewrites it', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 9, 8)) });
    const early = await harness.task('早上排好的任务');
    await harness.block(early.id, '2026-11-10', '09:00', '10:00');

    harness.clock.setLocal(2026, 11, 10, 8, 0);
    const first = await harness.outcomes('day', { date: '2026-11-10' });
    const snapshot = harness.snapshot('2026-11-10');
    assert.notEqual(snapshot, null);
    assert.equal(snapshot.plan.outcomes.version, 1);
    assert.equal(snapshot.plan.outcomes.date, '2026-11-10');
    assert.deepEqual(snapshot.plan.outcomes.tasks.map(entry => entry.id), [early.id]);
    assert.equal(snapshot.plan.outcomes.counts.studyTasks, 1);
    assert.equal(snapshot.plan.outcomes.counts.studyBlocks, 1);
    assert.equal(snapshot.plan.outcomes.tasks[0].minutes, 60);
    assert.equal(first.completion.original.planned, 1);
    assert.deepEqual(first.baseline.daySnapshotDates, ['2026-11-10']);
    assert.equal(first.days[0].baselineSource, 'day_snapshot');

    // A task scheduled after the day's first open is an adjustment, not part of
    // the original plan; the write-once snapshot keeps the original honest.
    const late = await harness.task('午后才加的任务');
    await harness.block(late.id, '2026-11-10', '10:00', '11:00');
    const second = await harness.outcomes('day', { date: '2026-11-10' });
    assert.equal(second.completion.original.planned, 1);
    assert.equal(second.completion.adjusted.planned, 2);
    assert.equal(second.completion.adjusted.unrecorded, 2);
    assert.deepEqual(harness.snapshot('2026-11-10'), snapshot, 'the snapshot must stay write-once');
    const lateItem = second.items.find(entry => entry.taskId === late.id);
    assert.equal(lateItem.original, false);
    assert.equal(lateItem.adjusted, true);
    const earlyItem = second.items.find(entry => entry.taskId === early.id);
    assert.equal(earlyItem.originalSource, 'day_snapshot');
  });

  it('keeps fixed courses and untracked blocks out of the task baseline', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 9, 8)) });
    const task = await harness.task('真正要统计的任务');
    await harness.block(task.id, '2026-11-10', '09:00', '10:00');
    await harness.block(null, '2026-11-10', '08:00', '09:00', { title: '早自习', fixed: true });
    await harness.block(null, '2026-11-10', '19:00', '20:00', { title: '背单词' });

    harness.clock.setLocal(2026, 11, 10, 8);
    await harness.outcomes('day', { date: '2026-11-10' });
    const snapshot = harness.snapshot('2026-11-10');
    assert.deepEqual(snapshot.plan.outcomes.tasks.map(entry => entry.id), [task.id]);
    assert.equal(snapshot.plan.outcomes.counts.fixedBlocks, 1);
    assert.equal(snapshot.plan.outcomes.counts.studyBlocks, 2);
    assert.equal(snapshot.plan.outcomes.untrackedTaskBlockCount, 1);

    const result = await harness.outcomes('day', { date: '2026-11-10' });
    assert.equal(result.completion.original.planned, 1);
    assert.equal(result.completion.adjusted.planned, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].taskId, task.id);
  });

  it('keeps a task deleted after it was planned in the original denominator', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 9, 8)) });
    const task = await harness.task('计划后被删掉的任务');
    const block = await harness.block(task.id, '2026-11-10', '09:00', '10:00');
    harness.clock.setLocal(2026, 11, 10, 8);
    await harness.outcomes('day', { date: '2026-11-10' });
    await harness.ok('tasks', 'deleteTask', { id: task.id });

    const result = await harness.outcomes('day', { date: '2026-11-10' });
    assert.equal(result.completion.original.planned, 1, 'deleting a planned task cannot erase it from the original plan');
    assert.equal(result.completion.original.unrecorded, 1);
    assert.equal(result.completion.adjusted.planned, 1, 'the block still holds the deleted task id');
    const entry = result.items.find(item => item.taskId === task.id);
    assert.equal(entry.deleted, true);
    assert.equal(entry.original, true);
    assert.equal(entry.adjusted, true);
    assert.ok(block.id);
  });
});
