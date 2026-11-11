import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, boot, createGoal, createMaterial, dateAfter, item, planPayload, weekStartOf } from './helpers.mjs';

test('a draft stays a draft: it fills no applied revision and today shows no tasks until confirmation', async t => {
  const harness = await boot(t);
  const created = await harness.ok('saveDraft', planPayload());

  assert.equal(created.plan.status, 'draft');
  assert.equal(created.plan.revision, 0);
  assert.equal(created.plan.hasDraft, true);
  assert.equal(created.plan.counts.items, 2);
  assert.equal(created.plan.counts.minutes, 120);
  assert.equal(created.capacity.verdict, 'fits');
  assert.equal(created.capacity.requiresTrial, false);
  assert.equal(created.draft.baseRevision, 0);
  assert.equal(created.draft.data.items.length, 2);
  assert.equal(created.draft.data.title, '2026 考研数学计划');
  assert.equal(created.requiresTrial, false);

  const planId = created.plan.id;
  assert.match(planId, /^plan_/);
  for (const current of created.draft.data.items) assert.match(current.id, /^item_/);

  const read = await harness.ok('get', { planId });
  assert.equal(read.applied, null);
  assert.equal(read.plan.revision, 0);
  assert.equal(read.draft.data.items.length, 2);
  assert.deepEqual(read.revisions, []);

  const today = await harness.ok('today', { planId });
  assert.equal(today.plan.status, 'draft');
  assert.deepEqual(today.items, []);
  assert.match(today.notice, /尚未确认|未确认/);

  const progress = await harness.ok('progress', { planId });
  assert.equal(progress.summary.itemCount, 0);
  assert.match(progress.notice, /尚未确认|未确认/);
});

test('a draft edit replaces the same draft and keeps explicit item ids stable', async t => {
  const harness = await boot(t);
  const first = await harness.ok('saveDraft', planPayload());
  const firstIds = first.draft.data.items.map(current => current.id);

  const edited = await harness.ok('saveDraft', {
    planId: first.plan.id,
    baseRevision: 0,
    ...planPayload({ title: '修改后的计划', items: first.draft.data.items }),
  });
  const secondIds = edited.draft.data.items.map(current => current.id);
  assert.deepEqual(secondIds, firstIds);
  assert.equal(edited.plan.id, first.plan.id);
  assert.equal(edited.plan.revision, 0);
  assert.equal(edited.draft.data.title, '修改后的计划');
  assert.equal(edited.plan.title, '修改后的计划');

  const missingBase = await harness.fail('saveDraft', {
    planId: first.plan.id,
    title: '缺少版本号',
    items: [item()],
  });
  assert.equal(missingBase.code, 'invalid');
  assert.equal(missingBase.details.field, 'baseRevision');
});

test('capacity keeps work that does not fit and confirmation requires an explicit trial plan', async t => {
  const harness = await boot(t);
  const today = dateAfter(0);
  const draft = await harness.ok('saveDraft', planPayload({
    availability: [{ date: today, minutes: 120 }],
    items: [
      item({ title: '第二章 习题 1-10', estimateMinutes: 90, start: '19:00', end: '20:30' }),
      item({ title: '错题订正', estimateMinutes: 90, start: '20:30', end: '22:00' }),
      item({ title: '第三章 预习', estimateMinutes: 60, date: null, start: null, end: null }),
    ],
  }));
  assert.equal(draft.capacity.verdict, 'over_capacity');
  assert.equal(draft.capacity.requiresTrial, true);
  assert.equal(draft.capacity.unscheduled.count, 1);
  assert.equal(draft.capacity.unscheduled.minutes, 60);
  assert.deepEqual(draft.capacity.unscheduled.items.map(entry => entry.title), ['第三章 预习']);
  const overCapacity = draft.capacity.conflicts.find(conflict => conflict.code === 'over_capacity');
  assert.equal(overCapacity.date, today);
  assert.equal(overCapacity.minutes, 60);
  assert.equal(draft.draft.data.items.length, 3, 'unscheduled work must stay in the draft');

  const blocked = await harness.fail('confirm', { planId: draft.plan.id, baseRevision: 0 });
  assert.equal(blocked.code, 'invalid');
  assert.equal(blocked.details.reason, 'trial_required');
  assert.equal(blocked.details.capacity.verdict, 'over_capacity');
  assert.equal((await harness.ok('get', { planId: draft.plan.id })).applied, null);

  const confirmed = await harness.ok('confirm', { planId: draft.plan.id, baseRevision: 0, trial: true });
  assert.equal(confirmed.plan.status, 'trial');
  assert.equal(confirmed.plan.revision, 1);
  assert.equal(confirmed.plan.trial, true);
  assert.equal(confirmed.plan.reviewAt, dateAfter(7));
  assert.equal(confirmed.revision.action, 'confirm');
  assert.equal(confirmed.revision.data.items.length, 3);
  assert.equal(confirmed.changes.totals.afterItems, 3);
  assert.equal(confirmed.changes.totals.afterUnscheduled, 1);

  const todayView = await harness.ok('today', { planId: draft.plan.id });
  assert.equal(todayView.items.length, 2);
  assert.equal(todayView.unscheduled.length, 1);
  assert.equal(todayView.unscheduled[0].title, '第三章 预习');
  assert.equal(todayView.capacity.availableMinutes, 120);
  assert.equal(todayView.capacity.scheduledMinutes, 180);
  assert.equal(todayView.capacity.remainingMinutes, -60);
  assert.ok(todayView.items.every(entry => entry.progress.status === 'unrecorded'));
});

test('a goal daily budget is the availability default, and missing availability is reported, not invented', async t => {
  const harness = await boot(t);
  const goal = await createGoal(harness);
  const withGoal = await harness.ok('saveDraft', planPayload({
    goalId: goal.id,
    availability: undefined,
  }));
  assert.equal(withGoal.plan.goalId, goal.id);
  assert.equal(withGoal.capacity.days[0].availabilitySource, 'goal_daily_minutes');
  assert.equal(withGoal.capacity.days[0].availableMinutes, 120);
  assert.equal(withGoal.capacity.verdict, 'fits');
  assert.deepEqual(withGoal.capacity.goal, { id: goal.id, dailyMinutes: 120, deadline: dateAfter(40) });

  const trialed = await harness.ok('confirm', {
    planId: withGoal.plan.id,
    baseRevision: 0,
    trial: true,
    reviewAt: dateAfter(3),
  });
  assert.equal(trialed.plan.trial, true);
  assert.equal(trialed.plan.status, 'trial');
  assert.equal(trialed.plan.reviewAt, dateAfter(3));

  const derived = await harness.ok('saveDraft', {
    goalId: goal.id,
    baseRevision: 0,
    availability: [{ date: dateAfter(0), minutes: 60 }],
    items: [item({ estimateMinutes: 60, start: null, end: null })],
  });
  assert.equal(derived.plan.title, '考研数学一 学习计划');
  assert.equal(derived.plan.goalId, goal.id);

  const bare = await harness.ok('saveDraft', planPayload({ title: '没有目标与可用时间', availability: [], goalId: 'unassigned' }));
  assert.equal(bare.capacity.days[0].availabilitySource, 'unknown');
  assert.equal(bare.capacity.days[0].availableMinutes, null);
  const unknown = bare.capacity.conflicts.find(conflict => conflict.code === 'unknown_availability');
  assert.equal(unknown.date, dateAfter(0));
  assert.equal(bare.capacity.verdict, 'partial');
  assert.equal(bare.capacity.requiresTrial, false);
});

test('overlapping slots and dependency order are conflicts with an explanation', async t => {
  const harness = await boot(t);
  const today = dateAfter(0);
  const overlap = await harness.ok('saveDraft', planPayload({
    availability: [{ date: today, minutes: 300 }],
    items: [
      item({ title: 'A', start: '19:00', end: '20:00' }),
      item({ title: 'B', start: '19:30', end: '20:30' }),
    ],
  }));
  const overlapConflict = overlap.capacity.conflicts.find(conflict => conflict.code === 'overlap');
  assert.deepEqual(overlapConflict.itemIds, overlap.draft.data.items.map(entry => entry.id));
  assert.equal(overlap.capacity.requiresTrial, true);
  assert.ok(overlap.capacity.risks.some(text => /重叠/.test(text)));

  const ordered = await harness.ok('saveDraft', planPayload({
    availability: [{ date: today, minutes: 300 }, { date: dateAfter(1), minutes: 300 }],
    items: [
      item({ title: '基础练习', subject: '数学', date: dateAfter(1), start: null, end: null }),
      item({ title: '综合练习', subject: '数学', date: today, start: null, end: null, dependencies: ['基础练习'] }),
    ],
  }));
  assert.deepEqual(ordered.draft.data.items[1].dependencies, [ordered.draft.data.items[0].id]);
  const dependencyConflict = ordered.capacity.conflicts.find(conflict => conflict.code === 'dependency_order');
  assert.equal(dependencyConflict.itemIds[0], ordered.draft.data.items[1].id);
  assert.equal(dependencyConflict.dependsOn, ordered.draft.data.items[0].id);
  const blocked = await harness.fail('confirm', { planId: ordered.plan.id, baseRevision: 0 });
  assert.equal(blocked.code, 'invalid');
  assert.equal(blocked.details.reason, 'dependency_order');
  assert.equal((await harness.ok('get', { planId: ordered.plan.id })).applied, null);

  const unscheduledFirst = await harness.ok('saveDraft', planPayload({
    availability: [{ date: today, minutes: 300 }],
    items: [
      item({ title: '基础练习', date: null, start: null, end: null }),
      item({ title: '综合练习', date: today, start: null, end: null, dependencies: ['基础练习'] }),
    ],
  }));
  const warning = unscheduledFirst.capacity.conflicts.find(conflict => conflict.code === 'dependency_unscheduled');
  assert.equal(warning.itemIds[0], unscheduledFirst.draft.data.items[1].id);
});

test('plan content is validated before a draft is stored', async t => {
  const harness = await boot(t);
  const cases = [
    [{ ...planPayload(), items: undefined }, 'items'],
    [{ ...planPayload(), title: undefined }, 'title'],
    [{ ...planPayload(), items: [item({ estimateMinutes: 0 })] }, 'items[0].estimateMinutes'],
    [{ ...planPayload(), items: [item({ date: '2026-02-30' })] }, 'items[0].date'],
    [{ ...planPayload(), items: [item({ start: '19:00', end: null })] }, 'items[0].end'],
    [{ ...planPayload(), items: [item({ start: '20:00', end: '19:00' })] }, 'items[0].end'],
    [{ ...planPayload(), items: [item({ date: null, start: '19:00', end: '20:00' })] }, 'items[0].start'],
    [{ ...planPayload(), items: [item({ id: 'same' }), item({ id: 'same' })] }, 'items[1].id'],
    [{ ...planPayload(), items: [item({ dependencies: ['missing'] })] }, 'items[0].dependencies'],
    [{ ...planPayload(), availability: [{ date: dateAfter(0), minutes: 60 }, { date: dateAfter(0), minutes: 60 }] }, 'availability[1].date'],
    [{ ...planPayload(), items: [item({ locator: { page: 3, unverified: ['page'] } })] }, 'items[0].locator.unverified'],
    [{ ...planPayload(), items: [item({ title: '同名任务' }), item({ title: '同名任务', dependencies: ['同名任务'] })] }, 'items[1].dependencies'],
  ];
  for (const [payload, field] of cases) {
    const result = await harness.fail('saveDraft', payload);
    assert.equal(result.code, 'invalid', JSON.stringify(payload));
    assert.equal(result.details.field, field, JSON.stringify(payload));
  }

  const cycle = await harness.ok('saveDraft', planPayload({
    items: [item({ title: 'A' }), item({ title: 'B' })],
  }));
  const ids = cycle.draft.data.items.map(entry => entry.id);
  const cyclic = await harness.fail('saveDraft', {
    planId: cycle.plan.id,
    baseRevision: 0,
    ...planPayload({
      items: [
        item({ id: ids[0], title: 'A', dependencies: [ids[1]] }),
        item({ id: ids[1], title: 'B', dependencies: [ids[0]] }),
      ],
    }),
  });
  assert.equal(cyclic.code, 'invalid');
  assert.equal(cyclic.details.reason, 'dependency_cycle');

  assert.deepEqual((await harness.ok('list', {})).plans.map(entry => entry.revision), [0]);
});

test('a plan can reference an imported material and a valid goal', async t => {
  const harness = await boot(t);
  const goal = await createGoal(harness);
  const material = await createMaterial(harness);

  const created = await harness.ok('saveDraft', planPayload({
    goalId: goal.id,
    items: [item({ materialId: material.id, locator: { chapter: '第二章 导数', page: 12, exercise: '1-10' } })],
  }));
  assert.equal(created.plan.goalId, goal.id);
  assert.equal(created.draft.data.items[0].materialId, material.id);
  assert.deepEqual(created.draft.data.items[0].locator, { chapter: '第二章 导数', page: 12, exercise: '1-10', unverified: [] });
  const byGoal = await harness.ok('list', { goalId: goal.id });
  assert.deepEqual(byGoal.plans.map(entry => entry.id), [created.plan.id]);

  const unknownGoal = await harness.fail('saveDraft', planPayload({ goalId: 'goal_missing' }));
  assert.equal(unknownGoal.code, 'not_found');
  assert.equal(unknownGoal.details.goalId, 'goal_missing');

  const unknownMaterial = await harness.fail('saveDraft', planPayload({
    items: [item({ materialId: 'mat_missing' })],
  }));
  assert.equal(unknownMaterial.code, 'not_found');
  assert.equal(unknownMaterial.details.materialId, 'mat_missing');
});

test('week goals are grouped by their Monday and stage goals stay visible in the plan', async t => {
  const harness = await boot(t);
  const midweek = dateAfter(2);
  const created = await harness.ok('saveDraft', planPayload({
    weekGoals: [{ weekStart: midweek, title: '本周目标', target: '完成 20 题' }],
  }));
  assert.equal(created.draft.data.weekGoals[0].weekStart, weekStartOf(midweek));
  assert.equal(created.draft.data.stageGoals[0].title, '完成高数强化');

  const confirmed = await harness.ok('confirm', { planId: created.plan.id, baseRevision: 0 });
  assert.equal(confirmed.plan.revision, 1);

  const week = await harness.ok('week', { planId: created.plan.id, date: midweek });
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].date, weekStartOf(midweek));
  assert.equal(week.days[6].date, addDays(weekStartOf(midweek), 6));
  assert.equal(week.start, weekStartOf(midweek));
  assert.equal(week.end, addDays(weekStartOf(midweek), 6));
});
