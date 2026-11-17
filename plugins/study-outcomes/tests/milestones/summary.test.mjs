/**
 * T14 week/month stage summary: the numbers in every line come from the
 * outcomes document, a cancellation never raises a rate, and the client
 * dictionary can render every line and milestone key the host emits.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { item, items } from '../outcomes/helpers.mjs';
import feedbackMessages from '../../client/messages/feedback.js';
import { allMilestones, bootMilestones, createClock, localInstant } from './helpers.mjs';

/** Localized dictionaries that must cover the host output. */
const DICTIONARIES = feedbackMessages;

describe('week and month stage summary', () => {
  it('copies every line value from the outcomes document', async t => {
    const harness = await bootMilestones(t, { clock: createClock(localInstant(2026, 11, 9, 8)) });
    const plan = await harness.plan(items(4, { date: '2026-11-10' }));
    harness.clock.setLocal(2026, 11, 10, 8);
    await harness.donePlanItem(plan, 'item_1', '2026-11-10');
    await harness.planProgress(plan.planId, 'item_2', 'cancelled', '2026-11-10');
    await harness.planProgress(plan.planId, 'item_3', 'done', '2026-11-10', { confirmed: false });

    const value = await harness.overview();
    const outcome = await harness.outcomes('week', { date: '2026-11-10' });
    const stage = value.week;
    assert.equal(stage.state, 'ready');
    assert.equal(stage.counts.planned, outcome.completion.adjusted.planned);
    assert.equal(stage.counts.completed, outcome.completion.adjusted.completed);
    assert.equal(stage.counts.cancelled, outcome.completion.adjusted.cancelled);
    assert.equal(stage.counts.pending, outcome.completion.adjusted.pending);
    assert.equal(stage.counts.unrecorded, outcome.completion.adjusted.unrecorded);
    assert.equal(stage.counts.originalPlanned, outcome.completion.original.planned);
    assert.equal(stage.counts.originalCompleted, outcome.completion.original.completed);
    assert.equal(stage.counts.rate, outcome.completion.adjusted.rate);

    const planned = stage.lines.find(line => line.key === 'planned');
    assert.deepEqual(planned.values, {
      planned: 4,
      completed: 1,
      cancelled: 1,
      pending: 1,
      unrecorded: 1,
    });
    const rate = stage.lines.find(line => line.key === 'rate');
    assert.deepEqual(rate.values, { percent: 25, completed: 1, planned: 4 });
    assert.match(rate.text, /25%/);
    assert.match(rate.text, /取消留在分母里/);
    const original = stage.lines.find(line => line.key === 'original');
    assert.deepEqual(original.values, { completed: 1, planned: 4 });
    assert.equal(stage.lines.find(line => line.key === 'pending').values.count, 1);
    assert.equal(stage.lines.find(line => line.key === 'unrecorded').values.count, 1);
    assert.equal(stage.lines.find(line => line.key === 'cancelled').values.count, 1);
    assert.equal(stage.lines.some(line => line.key === 'materials'), false);

    assert.equal(stage.headline, '本周：计划 4 项，已确认完成 1 项，主动取消 1 项。');
    assert.equal(stage.source.service, 'outcomes');
    assert.equal(stage.source.method, 'week');
    assert.equal(stage.source.generatedAt, outcome.generatedAt);
    assert.equal(stage.from, outcome.from);
    assert.equal(stage.to, outcome.to);
  });

  it('names an empty period without inventing a denominator', async t => {
    const harness = await bootMilestones(t);
    const value = await harness.overview();
    const stage = value.week;
    assert.deepEqual(stage.lines.map(line => line.key), ['noPlanned', 'originalNone']);
    assert.deepEqual(stage.lines[0].values, { unplanned: 0 });
    assert.equal(stage.headline, '本周没有计划或进度记录。');
    assert.equal(stage.counts.rate, null);
    assert.equal(stage.milestones.every(milestone => milestone.achieved === false), true);
  });

  it('reports unplanned recorded work as unplanned, not as a plan', async t => {
    const harness = await bootMilestones(t);
    await harness.doneTask('临时加的任务', '2026-11-10');
    const value = await harness.overview();
    const stage = value.week;
    assert.equal(stage.counts.planned, 0);
    assert.equal(stage.counts.recorded, 1);
    assert.equal(stage.counts.unplanned, 1);
    assert.deepEqual(stage.lines.map(line => line.key), ['noPlanned', 'originalNone', 'unplanned']);
    assert.deepEqual(stage.lines[0].values, { unplanned: 1 });
    assert.equal(stage.lines[2].values.count, 1);
    assert.equal(stage.headline, '本周有 1 条进度记录，没有计划项。');
    assert.equal(stage.earnedCount, 1, '真实完成记录仍可达成里程碑，但不进入完成率');
  });

  it('keeps cancelled items in the denominator, so two cancellations never look complete', async t => {
    const harness = await bootMilestones(t);
    const plan = await harness.plan(items(3, { date: '2026-11-10' }));
    await harness.donePlanItem(plan, 'item_1', '2026-11-10');
    await harness.planProgress(plan.planId, 'item_2', 'cancelled', '2026-11-10');
    await harness.planProgress(plan.planId, 'item_3', 'cancelled', '2026-11-10');

    const value = await harness.overview();
    const stage = value.week;
    const rate = stage.lines.find(line => line.key === 'rate');
    assert.equal(stage.counts.completed, 1);
    assert.equal(stage.counts.cancelled, 2);
    assert.equal(stage.counts.planned, 3);
    assert.equal(stage.counts.rate, 0.3333);
    assert.equal(rate.values.percent, 33.3);
    assert.notEqual(rate.values.percent, 100);
    assert.match(rate.text, /33.3%/);
    assert.equal(stage.lines.find(line => line.key === 'cancelled').values.count, 2);
    assert.equal(stage.milestones.find(milestone => milestone.id === 'week.three').count, 1);
  });

  it('summarizes materials with the titles the facts carry', async t => {
    const harness = await bootMilestones(t);
    const material = await harness.material('数学练习册');
    const plan = await harness.plan([item({ id: 'item_1', materialId: material.id, date: '2026-11-10' })]);
    await harness.donePlanItem(plan, 'item_1', '2026-11-10');

    const value = await harness.overview();
    const stage = value.week;
    const line = stage.lines.find(entry => entry.key === 'materials');
    assert.ok(line);
    assert.deepEqual(line.values, { items: 1, materials: 1, titles: '数学练习册' });
    assert.match(line.text, /数学练习册/);
    assert.deepEqual(stage.materials.titles, ['数学练习册']);
    assert.equal(stage.materials.advancedItemCount, 1);
  });

  it('uses the month bounds and wording for the month stage', async t => {
    const harness = await bootMilestones(t);
    await harness.doneTask('本月记录', '2026-11-10');
    const value = await harness.overview();
    assert.deepEqual([value.month.from, value.month.to], ['2026-11-01', '2026-11-30']);
    const noPlanned = value.month.lines.find(line => line.key === 'noPlanned');
    assert.match(noPlanned.text, /本月|这个周期/);
    assert.equal(value.month.headline.startsWith('本月'), true);
    assert.equal(value.week.headline.startsWith('本周'), true);
  });

  it('emits only keys the client dictionary can render', async t => {
    const harness = await bootMilestones(t);
    const plan = await harness.plan(items(2, { date: '2026-11-10' }));
    await harness.donePlanItem(plan, 'item_1', '2026-11-10');
    await harness.planProgress(plan.planId, 'item_2', 'cancelled', '2026-11-10');
    const value = await harness.overview();

    for (const locale of ['en', 'zh']) {
      const dictionary = DICTIONARIES[locale];
      for (const stage of [value.week, value.month]) {
        for (const line of stage.lines) {
          assert.equal(Object.hasOwn(dictionary, `feedback.line.${line.key}`), true, `缺少 ${locale} 文案 feedback.line.${line.key}`);
        }
        for (const milestone of allMilestones(value)) {
          assert.equal(Object.hasOwn(dictionary, `feedback.milestone.${milestone.id}`), true, `缺少 ${locale} 文案 feedback.milestone.${milestone.id}`);
        }
        if (stage.next !== null) {
          assert.equal(Object.hasOwn(dictionary, `feedback.milestone.${stage.next.id}`), true);
        }
      }
    }
  });
});
