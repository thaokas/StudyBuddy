/**
 * T13 period aggregation: local day/week/month boundaries, cross-midnight
 * attribution, the day-snapshot/`change_log` baselines, and the rule that a
 * rescheduled task or plan item counts once per period.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { bootOutcomes, createClock, item, localInstant } from './helpers.mjs';

describe('period boundaries', () => {
  it('uses the local Monday-to-Sunday week and the calendar month', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 9, 8)) });
    const task = await harness.task('跨月周任务');
    await harness.block(task.id, '2026-11-10', '23:00', '24:00');
    harness.clock.setLocal(2026, 11, 10, 23, 55);
    await harness.taskProgress(task.id, 'done', '2026-11-10');

    const week = await harness.outcomes('week', { date: '2026-11-10' });
    assert.equal(week.scope, 'week');
    assert.equal(week.from, '2026-11-09');
    assert.equal(week.to, '2026-11-15');
    assert.equal(week.days.length, 7);
    assert.deepEqual(week.days.map(day => day.weekday), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(week.completion.original.planned, 1);
    assert.equal(week.completion.original.completed, 1);
    assert.equal(week.completion.original.rate, 1);
    assert.equal(week.baseline.daySnapshotDates.includes('2026-11-10'), true);
    const dayTen = week.days.find(day => day.date === '2026-11-10');
    assert.equal(dayTen.originalPlanned, 1);
    assert.equal(dayTen.originalCompleted, 1);
    assert.equal(dayTen.adjustedPlanned, 1);
    assert.equal(dayTen.records, 1);
    assert.equal(dayTen.completedRecords, 1);
    assert.equal(dayTen.baselineSource, 'day_snapshot');

    const month = await harness.outcomes('month', { date: '2026-11-10' });
    assert.equal(month.scope, 'month');
    assert.equal(month.from, '2026-11-01');
    assert.equal(month.to, '2026-11-30');
    assert.equal(month.days.length, 30);
    assert.equal(month.completion.original.planned, 1);
    assert.equal(month.completion.original.completed, 1);
  });

  it('attributes a progress record to its local date across midnight', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 9, 8)) });
    const task = await harness.task('跨夜任务');
    await harness.block(task.id, '2026-11-10', '23:00', '24:00');
    harness.clock.setLocal(2026, 11, 10, 23, 55);
    await harness.taskProgress(task.id, 'done', '2026-11-10');
    harness.clock.setLocal(2026, 11, 11, 0, 5);
    await harness.taskProgress(task.id, 'in_progress', '2026-11-11');

    const dayTen = await harness.outcomes('day', { date: '2026-11-10' });
    assert.equal(dayTen.completion.original.planned, 1);
    assert.equal(dayTen.completion.original.completed, 1, 'the record dated Nov 10 stays on Nov 10');
    assert.equal(dayTen.items[0].recordDate, '2026-11-10');
    assert.equal(dayTen.items[0].status, 'done');

    const dayEleven = await harness.outcomes('day', { date: '2026-11-11' });
    assert.equal(dayEleven.completion.original.planned, 0, 'the block ended at 24:00 on Nov 10, not Nov 11');
    assert.equal(dayEleven.completion.original.rate, null);
    assert.equal(dayEleven.counts.unplanned, 1);
    assert.equal(dayEleven.items[0].recordDate, '2026-11-11');
    assert.equal(dayEleven.items[0].status, 'in_progress');
    assert.equal(dayEleven.state, 'unplanned_only');
  });

  it('crosses a month boundary when a week starts in the previous month', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 30, 8)) });
    const week = await harness.outcomes('week', { date: '2026-12-01' });
    assert.equal(week.from, '2026-11-30');
    assert.equal(week.to, '2026-12-06');
    assert.equal(week.days.length, 7);
    assert.equal(week.empty, true);
    assert.equal(week.completion.original.rate, null);
  });

  it('keeps a 31-day month complete and empty when there is no data', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 30, 8)) });
    const month = await harness.outcomes('month', { date: '2026-12-15' });
    assert.equal(month.from, '2026-12-01');
    assert.equal(month.to, '2026-12-31');
    assert.equal(month.days.length, 31);
    assert.equal(month.empty, true);
    assert.equal(month.state, 'empty');
    assert.equal(month.completion.original.rate, null);
    assert.equal(month.counts.totalUnits, 0);
  });
});

describe('baseline reconstruction', () => {
  it('counts a task once across a week after its block is moved to another day', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 9, 8)) });
    const task = await harness.task('会跨天移动的任务');
    const block = await harness.block(task.id, '2026-11-10', '09:00', '10:00');

    harness.clock.setLocal(2026, 11, 10, 9, 0);
    // The first call on Nov 10 captures the day snapshot with the block.
    await harness.outcomes('day', { date: '2026-11-10' });
    await harness.ok('tasks', 'moveBlock', { id: block.id, date: '2026-11-12' });
    await harness.taskProgress(task.id, 'done', '2026-11-10');

    const week = await harness.outcomes('week', { date: '2026-11-10' });
    assert.equal(week.completion.original.planned, 1, 'a reschedule must not create a second planned unit');
    assert.equal(week.completion.adjusted.planned, 1);
    assert.equal(week.completion.original.completed, 1);
    assert.equal(week.completion.original.rate, 1);
    assert.equal(week.baseline.daySnapshotDates.includes('2026-11-10'), true);
    assert.equal(week.baseline.changeLogDates.includes('2026-11-12'), true);
    const dayTen = week.days.find(day => day.date === '2026-11-10');
    const dayTwelve = week.days.find(day => day.date === '2026-11-12');
    assert.equal(dayTen.originalPlanned, 1);
    assert.equal(dayTwelve.adjustedPlanned, 1);
    assert.equal(dayTwelve.originalPlanned, 0, 'the task is attributed to the first planned day only');
  });

  it('rebuilds a missing day snapshot from the change log at local midnight', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 9, 8)) });
    const task = await harness.task('没有当天快照的任务');
    await harness.block(task.id, '2026-11-10', '09:00', '10:00');
    harness.clock.setLocal(2026, 11, 12, 8);

    const day = await harness.outcomes('day', { date: '2026-11-10' });
    assert.equal(harness.snapshot('2026-11-10'), null, 'no snapshot exists for the skipped day');
    assert.equal(day.completion.original.planned, 1, 'the midnight state still had the block');
    assert.equal(day.completion.original.completed, 0);
    assert.equal(day.completion.original.unrecorded, 1);
    assert.equal(day.days[0].baselineSource, 'change_log');
    assert.deepEqual(day.baseline.daySnapshotDates, []);
    assert.deepEqual(day.baseline.changeLogDates, ['2026-11-10']);
  });

  it('ignores a legacy snapshot without an outcomes block and falls back to the change log', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 7, 8)) });
    const task = await harness.task('旧快照任务');
    await harness.block(task.id, '2026-11-08', '09:00', '10:00');
    // A snapshot written before T13 has no outcomes payload. Its triggers
    // still allow INSERT, so seed the legacy row directly.
    harness.database.run(
      'INSERT INTO day_snapshot (date, plan_json, created_at) VALUES (?, ?, ?)',
      '2026-11-08',
      JSON.stringify({ date: '2026-11-08', revision: 0, generatedAt: '2026-11-08T00:00:00.000Z', items: [] }),
      '2026-11-08T00:00:00.000Z',
    );
    harness.clock.setLocal(2026, 11, 9, 8);

    const day = await harness.outcomes('day', { date: '2026-11-08' });
    const stored = harness.snapshot('2026-11-08');
    assert.equal(stored.plan.outcomes, undefined, 'the legacy row is unchanged');
    assert.equal(day.completion.original.planned, 1);
    assert.equal(day.days[0].baselineSource, 'change_log');
    assert.deepEqual(day.baseline.daySnapshotDates, []);
    assert.deepEqual(day.baseline.changeLogDates, ['2026-11-08']);
  });

  it('freezes a past day when a later revision changes the plan', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 9, 8)) });
    const confirmed = await harness.plan([item({ id: 'item_1', date: '2026-11-10' })]);
    harness.clock.setLocal(2026, 11, 10, 8);
    const before = await harness.outcomes('day', { date: '2026-11-10' });
    assert.equal(before.completion.original.planned, 1);
    assert.equal(before.completion.adjusted.planned, 1);
    assert.equal(before.days[0].baselineSource, 'plan_revision');

    harness.clock.setLocal(2026, 11, 12, 8);
    await harness.revise(confirmed.planId, 1, [], { reason: '两天后清空计划' });

    const after = await harness.outcomes('day', { date: '2026-11-10' });
    assert.equal(after.completion.adjusted.planned, 1, 'a revision applied after the day ended does not rewrite it');
    assert.equal(after.baseline.planRevisions, 1);
    const later = await harness.outcomes('day', { date: '2026-11-12' });
    assert.equal(later.completion.original.planned, 0);
    assert.equal(later.completion.adjusted.planned, 0);
    assert.equal(later.empty, true);
  });

  it('reads the same statistics after a restart', async t => {
    const first = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 9, 8)), cleanup: false });
    const confirmed = await first.plan([item({ id: 'item_1', date: '2026-11-10' })]);
    first.clock.setLocal(2026, 11, 10, 8);
    await first.planProgress(confirmed.planId, 'item_1', 'done', '2026-11-10');
    const original = await first.outcomes('week', { date: '2026-11-10' });
    const directory = first.directory;
    await first.close();

    const reopened = await bootOutcomes(t, { directory, clock: first.clock });
    const again = await reopened.outcomes('week', { date: '2026-11-10' });
    assert.deepEqual(again.completion, original.completion);
    assert.deepEqual(again.counts, original.counts);
    assert.deepEqual(again.days, original.days);
    assert.deepEqual(again.items, original.items);
    assert.deepEqual(again.baseline, original.baseline);
    await reopened.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
});

describe('read-only behavior', () => {
  it('does not write progress, revision, or the change log when queried', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 8)) });
    const task = await harness.task('只读检查');
    await harness.taskProgress(task.id, 'done', '2026-11-10');
    // First query of the day writes the kernel-owned snapshot; measure after it.
    await harness.outcomes('day', { date: '2026-11-10' });
    const revisionBefore = harness.kernel.status().revision;
    const changeCountBefore = Number(harness.rows('SELECT COUNT(*) AS count FROM change_log')[0].count);
    const snapshotCountBefore = Number(harness.rows('SELECT COUNT(*) AS count FROM day_snapshot')[0].count);

    await harness.outcomes('day', { date: '2026-11-10' });
    await harness.outcomes('week', { date: '2026-11-10' });
    await harness.outcomes('month', { date: '2026-11-10' });

    assert.equal(harness.kernel.status().revision, revisionBefore);
    assert.equal(Number(harness.rows('SELECT COUNT(*) AS count FROM change_log')[0].count), changeCountBefore);
    assert.equal(Number(harness.rows('SELECT COUNT(*) AS count FROM day_snapshot')[0].count), snapshotCountBefore);
  });
});
