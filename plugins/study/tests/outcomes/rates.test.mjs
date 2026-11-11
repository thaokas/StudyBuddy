/**
 * T13 three-caliber completion rates: original plan, adjusted plan, and the
 * separate cancellation caliber. The invariant under test is that cancelling
 * work can never raise a completion rate, and that "unrecorded" and "pending
 * confirmation" are not silently treated as completed or as never studied.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootOutcomes, createClock, item, items, localInstant } from './helpers.mjs';

const PLAN_DAY = '2026-11-11';

/**
 * Read the day summary for a local date.
 * @param {object} harness - Booted fixture.
 * @param {string} date - Local date.
 * @returns {Promise<object>} Day value.
 */
async function day(harness, date = PLAN_DAY) {
  return harness.outcomes('day', { date });
}

describe('plan completion calibers', () => {
  it('keeps cancelled items in both denominators, so cancelling nine of ten never looks complete', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 8)) });
    const { planId } = await harness.plan(items(10, { date: PLAN_DAY }));

    harness.clock.setLocal(2026, 11, 11, 8);
    await harness.planProgress(planId, 'item_1', 'done', PLAN_DAY, { quantityDone: 10, quantityTotal: 10 });

    const before = await day(harness);
    assert.equal(before.scope, 'day');
    assert.equal(before.from, PLAN_DAY);
    assert.equal(before.to, PLAN_DAY);
    assert.equal(before.empty, false);
    assert.equal(before.completion.original.planned, 10);
    assert.equal(before.completion.original.completed, 1);
    assert.equal(before.completion.original.cancelled, 0);
    assert.equal(before.completion.original.unrecorded, 9);
    assert.equal(before.completion.original.rate, 0.1);
    assert.equal(before.completion.adjusted.planned, 10);
    assert.equal(before.completion.adjusted.rate, 0.1);

    for (let index = 2; index <= 10; index += 1) {
      await harness.planProgress(planId, `item_${index}`, 'cancelled', PLAN_DAY, { note: '今天先不做了' });
    }

    const after = await day(harness);
    assert.equal(after.completion.original.planned, 10, 'cancelling must not shrink the original denominator');
    assert.equal(after.completion.original.completed, 1);
    assert.equal(after.completion.original.cancelled, 9);
    assert.equal(after.completion.original.rate, 0.1, 'cancelling must not raise the original rate');
    assert.equal(after.completion.adjusted.planned, 10, 'cancelling must not shrink the adjusted denominator either');
    assert.equal(after.completion.adjusted.completed, 1);
    assert.equal(after.completion.adjusted.cancelled, 9);
    assert.equal(after.completion.adjusted.rate, 0.1, 'cancelling must not raise the adjusted rate');
    assert.equal(after.completion.cancelled.originalCount, 9);
    assert.equal(after.completion.cancelled.adjustedCount, 9);
    assert.equal(after.completion.cancelled.originalShare, 0.9);
    assert.notEqual(after.completion.original.rate, 1, 'nine cancellations must never be presented as full completion');

    const cancelledItems = after.items.filter(entry => entry.status === 'cancelled');
    assert.equal(cancelledItems.length, 9);
    assert.ok(cancelledItems.every(entry => entry.original === true && entry.adjusted === true));
    assert.equal(after.items.filter(entry => entry.status === 'done').length, 1);
  });

  it('reports the adjusted plan after a revision without rewriting the original rate', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 8)) });
    const confirmed = await harness.plan(items(4, { date: PLAN_DAY }));
    harness.clock.setLocal(2026, 11, 11, 8);
    await harness.planProgress(confirmed.planId, 'item_1', 'done', PLAN_DAY);
    await harness.planProgress(confirmed.planId, 'item_2', 'cancelled', PLAN_DAY);

    const before = await day(harness);
    assert.equal(before.completion.original.planned, 4);
    assert.equal(before.completion.original.rate, 0.25);
    assert.equal(before.completion.adjusted.planned, 4);

    const kept = confirmed.items.filter(entry => entry.id === 'item_1' || entry.id === 'item_3');
    await harness.revise(confirmed.planId, 1, kept, { reason: '取消的任务移出计划' });

    const after = await day(harness);
    assert.equal(after.completion.original.planned, 4, 'the original plan is not rewritten by a revision');
    assert.equal(after.completion.original.completed, 1);
    assert.equal(after.completion.original.rate, 0.25);
    assert.equal(after.completion.adjusted.planned, 2);
    assert.equal(after.completion.adjusted.completed, 1);
    assert.equal(after.completion.adjusted.rate, 0.5);
    assert.equal(after.completion.cancelled.originalCount, 1);
    assert.equal(after.completion.cancelled.adjustedCount, 0);
    assert.equal(after.baseline.planRevisions >= 1, true);
    assert.equal(after.days[0].baselineSource, 'plan_revision');
  });

  it('treats a pending record as pending, not as done, and names unrecorded work', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 8)) });
    const confirmed = await harness.plan(items(3, { date: PLAN_DAY }));
    harness.clock.setLocal(2026, 11, 11, 8);
    await harness.planProgress(confirmed.planId, 'item_1', 'done', PLAN_DAY, { confirmed: false });
    await harness.planProgress(confirmed.planId, 'item_2', 'cancelled', PLAN_DAY, { confirmed: false });

    const result = await day(harness);
    assert.equal(result.completion.original.planned, 3);
    assert.equal(result.completion.original.completed, 0, 'a pending done record is not a completion');
    assert.equal(result.completion.original.pending, 2);
    assert.equal(result.completion.original.unrecorded, 1);
    assert.equal(result.completion.original.cancelled, 0, 'a pending cancellation is not a confirmed cancellation');
    assert.equal(result.completion.original.rate, 0);
    assert.equal(result.completion.cancelled.originalCount, 0);
    assert.equal(result.completion.cancelled.originalShare, 0);
    assert.equal(result.state, 'ready');
    assert.ok(result.items.find(entry => entry.itemId === 'item_1').pending);
    assert.equal(result.items.find(entry => entry.itemId === 'item_1').confirmed, false);
    assert.equal(result.items.find(entry => entry.itemId === 'item_3').status, 'unrecorded');
  });

  it('carries quantities, notes, and the record id for detail cross-checks', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 8)) });
    const confirmed = await harness.plan([item({ id: 'item_1', date: PLAN_DAY })]);
    harness.clock.setLocal(2026, 11, 11, 9, 30);
    const record = await harness.planProgress(confirmed.planId, 'item_1', 'partial', PLAN_DAY, {
      quantityDone: 3,
      quantityTotal: 10,
      note: '做到第 3 题',
    });

    const result = await day(harness);
    assert.equal(result.completion.original.planned, 1);
    assert.equal(result.completion.original.completed, 0);
    assert.equal(result.completion.original.rate, 0);
    const entry = result.items.find(candidate => candidate.itemId === 'item_1');
    assert.equal(entry.status, 'partial');
    assert.equal(entry.confirmed, true);
    assert.equal(entry.quantityDone, 3);
    assert.equal(entry.quantityTotal, 10);
    assert.equal(entry.note, '做到第 3 题');
    assert.equal(entry.recordId, record.id);
    assert.equal(entry.recordDate, PLAN_DAY);
    assert.equal(result.completion.original.planned, result.items.filter(candidate => candidate.original).length);
    assert.equal(result.completion.adjusted.planned, result.items.filter(candidate => candidate.adjusted).length);
    assert.equal(
      result.completion.original.completed,
      result.items.filter(candidate => candidate.original && candidate.status === 'done' && candidate.confirmed).length,
    );
  });
});

describe('task completion calibers', () => {
  it('does not raise a task completion rate when nine of ten scheduled tasks are cancelled', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 22)) });
    const created = [];
    for (let index = 1; index <= 10; index += 1) {
      const task = await harness.task(`任务 ${index}`);
      await harness.block(task.id, PLAN_DAY, `${String(8 + index).padStart(2, '0')}:00`, `${String(9 + index).padStart(2, '0')}:00`);
      created.push(task);
    }

    harness.clock.setLocal(2026, 11, 11, 8);
    await harness.taskProgress(created[0].id, 'done', PLAN_DAY);
    const before = await day(harness);
    assert.equal(before.completion.original.planned, 10);
    assert.equal(before.completion.original.completed, 1);
    assert.equal(before.completion.original.rate, 0.1);
    assert.equal(before.days[0].baselineSource, 'day_snapshot');

    for (const task of created.slice(1)) {
      await harness.taskProgress(task.id, 'cancelled', PLAN_DAY, { note: '不做了' });
    }
    const after = await day(harness);
    assert.equal(after.completion.original.planned, 10);
    assert.equal(after.completion.original.cancelled, 9);
    assert.equal(after.completion.original.rate, 0.1);
    assert.equal(after.completion.adjusted.planned, 10);
    assert.equal(after.completion.adjusted.rate, 0.1);
    assert.equal(after.completion.cancelled.originalShare, 0.9);
    assert.equal(after.completion.bySource.tasks.original.planned, 10);
    assert.equal(after.completion.bySource.planItems.original.planned, 0);
  });

  it('reports work recorded without a time block but keeps it out of the rates', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 9)) });
    const first = await harness.task('没有排时间块的任务');
    const second = await harness.task('另一个没有安排的任务');
    await harness.taskProgress(first.id, 'done', PLAN_DAY);
    await harness.taskProgress(second.id, 'partial', PLAN_DAY, { quantityDone: 2, quantityTotal: 5 });

    const result = await harness.outcomes('day', { date: PLAN_DAY });
    assert.equal(result.empty, false);
    assert.equal(result.completion.original.planned, 0);
    assert.equal(result.completion.adjusted.planned, 0);
    assert.equal(result.completion.original.rate, null);
    assert.equal(result.completion.adjusted.rate, null);
    assert.equal(result.counts.unplanned, 2);
    assert.equal(result.state, 'unplanned_only');
    assert.ok(result.notice.includes('没有对应的时间块或计划条目'));
    const unplanned = result.items.filter(entry => !entry.original && !entry.adjusted);
    assert.equal(unplanned.length, 2);
    assert.deepEqual(unplanned.map(entry => entry.status).sort(), ['done', 'partial']);
  });

  it('returns an empty day with null rates instead of a fabricated 100%', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 9)) });
    const result = await harness.outcomes('day', { date: '2026-11-20' });
    assert.equal(result.empty, true);
    assert.equal(result.state, 'empty');
    assert.equal(result.completion.original.planned, 0);
    assert.equal(result.completion.adjusted.planned, 0);
    assert.equal(result.completion.original.rate, null);
    assert.equal(result.completion.adjusted.rate, null);
    assert.equal(result.completion.cancelled.originalShare, null);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.materials.items, []);
    assert.equal(result.days.length, 1);
    assert.ok(result.notice.length > 0);
  });

  it('rejects an invalid date instead of silently using today', async t => {
    const harness = await bootOutcomes(t);
    const failure = await harness.fail('outcomes', 'day', { date: '2026-13-01' });
    assert.equal(failure.code, 'invalid');
    assert.equal(failure.details.field, 'date');
    const empty = await harness.fail('outcomes', 'week', { date: 'not-a-date' });
    assert.equal(empty.code, 'invalid');
  });
});
