/**
 * End-to-end evidence for T10: the page's own payload builders drive the real
 * plans/materials services through `ctx.study`, with no model and no browser.
 *
 * These tests prove the acceptance rules that a pure view test cannot:
 * a draft never changes the formal arrangement, confirmation appends revision
 * one, undo restores the previous snapshot and names a pending draft, the
 * trial gate needs an explicit acknowledgement, material sources survive the
 * round trip, and the local workbench path works after skipping setup.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';
import { boot, createGoal, dateAfter } from '../plans/helpers.mjs';
import { loadDictionary, translatorFor } from './helpers.mjs';

installReactStub();

const {
  defaultPlanForm, emptyGoalDraft, emptyOnboardingState, emptyPlanForm, parseConfirm,
  parseGoalDraft, parsePlanForm, skipOnboarding,
} = await import('../../client/pages/onboarding.js');
const { diffPlanDocuments, materialSourceOf, missingPlanInfo, summarizeDiff, undoPayload } = await import('../../client/pages/plan.js');
const zh = translatorFor(await loadDictionary(), 'zh');

/** Parse the minimal goal form and save it through the materials service. */
async function saveMinimalGoal(harness, exam = 'Postgraduate mathematics') {
  const parsed = parseGoalDraft({ ...emptyGoalDraft(), exam });
  assert.equal(parsed.ok, true);
  const envelope = await harness.materials('saveGoal', parsed.payload);
  assert.equal(envelope.ok, true, `saveGoal: ${JSON.stringify(envelope)}`);
  return envelope.value.goal;
}

/** Build and validate the quick-start draft form for one goal. */
function quickStartForm(goal, overrides = {}) {
  return defaultPlanForm({
    ...emptyPlanForm(),
    planTitle: `${goal.exam} plan`,
    ...overrides,
  }, goal, zh);
}

test('the minimal path: exam name only, empty draft, confirmation, undo', async t => {
  const harness = await boot(t);
  const goal = await saveMinimalGoal(harness);
  assert.deepEqual(goal.missing, ['examYear', 'deadline', 'dailyMinutes']);
  assert.equal(goal.dailyMinutes, null);

  const form = quickStartForm(goal);
  const parsed = parsePlanForm({ form, goal, plan: null });
  assert.equal(parsed.ok, true);
  const draft = await harness.ok('saveDraft', parsed.payload);
  assert.equal(draft.plan.revision, 0);
  assert.equal(draft.plan.hasDraft, true);
  assert.equal(draft.plan.status, 'draft');
  assert.equal(draft.draft.data.items.length, 0);

  // The unconfirmed draft fills no formal revision and no formal arrangement.
  const getBefore = await harness.ok('get', {});
  assert.equal(getBefore.applied, null);
  assert.equal(getBefore.plan.revision, 0);
  const todayBefore = await harness.ok('today', {});
  assert.deepEqual(todayBefore.items, []);
  assert.match(todayBefore.notice, /尚未确认|未确认/);

  const confirmation = parseConfirm({
    plan: draft.plan,
    draft: draft.draft,
    capacity: draft.capacity,
    trialAcknowledged: false,
  });
  assert.equal(confirmation.ok, true);
  assert.deepEqual(confirmation.payload, { planId: draft.plan.id, baseRevision: 0, expectedDraftRevision: 1 });

  const confirmed = await harness.ok('confirm', confirmation.payload);
  assert.equal(confirmed.plan.revision, 1);
  assert.equal(confirmed.plan.status, 'active');

  const getAfter = await harness.ok('get', {});
  assert.equal(getAfter.applied.number, 1);
  assert.equal(getAfter.applied.data.items.length, 0);
  assert.equal(getAfter.revisions[0].action, 'confirm');
  assert.match(summarizeDiff(zh, getAfter.revisions[0].diff), /新增 0 项/);
  assert.equal(missingPlanInfo({
    plan: getAfter.plan,
    applied: getAfter.applied,
    draft: null,
    capacity: getAfter.capacity,
    goal,
    materials: [],
  }).some(entry => entry.code === 'noItems'), true);

  const undo = undoPayload(getAfter);
  assert.ok(undo);
  const undone = await harness.ok('undo', undo);
  assert.equal(undone.plan.revision, 2);
  assert.equal(undone.revision.action, 'undo');

  const getUndone = await harness.ok('get', {});
  assert.equal(getUndone.applied.number, 2);
  assert.equal(getUndone.applied.data.items.length, 0);
  assert.equal(getUndone.revisions[0].action, 'undo');
});

test('a draft with a task changes nothing until it is confirmed', async t => {
  const harness = await boot(t);
  const goal = await createGoal(harness, { dailyMinutes: 120 });
  const today = dateAfter(0);
  const form = quickStartForm(goal, {
    itemTitle: 'Chapter 2 exercises',
    estimateMinutes: '60',
    date: today,
    availabilityMinutes: '90',
  });
  const parsed = parsePlanForm({ form, goal, plan: null });
  assert.equal(parsed.ok, true);
  const draft = await harness.ok('saveDraft', parsed.payload);
  assert.equal(draft.draft.data.items.length, 1);
  assert.equal(draft.capacity.verdict, 'fits');

  const before = await harness.ok('today', {});
  assert.equal(before.plan.revision, 0);
  assert.deepEqual(before.items, []);

  const tasksBefore = await harness.ctx.study.call('tasks', 'day', { date: today });
  assert.equal(tasksBefore.ok, true);
  assert.deepEqual(tasksBefore.value.blocks, []);
  assert.deepEqual(tasksBefore.value.tasks, []);

  const confirmed = await harness.ok('confirm', parseConfirm({
    plan: draft.plan,
    draft: draft.draft,
    capacity: draft.capacity,
    trialAcknowledged: false,
  }).payload);
  assert.equal(confirmed.plan.revision, 1);

  const after = await harness.ok('today', {});
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].title, 'Chapter 2 exercises');
  assert.equal(after.items[0].progress.status, 'unrecorded');
  assert.equal(after.plan.revision, 1);

  const get = await harness.ok('get', {});
  const diff = diffPlanDocuments(null, get.applied.data);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.totals.afterItems, 1);
  assert.match(summarizeDiff(zh, get.revisions[0].diff), /新增 1 项/);

  // Confirmed items are the same execution facts the workbench reads.
  const tasksAfter = await harness.ctx.study.call('tasks', 'day', { date: today });
  assert.equal(tasksAfter.value.tasks.length, 1);
});

test('an over-capacity draft needs the explicit trial acknowledgement', async t => {
  const harness = await boot(t);
  const goal = await createGoal(harness, { dailyMinutes: 120 });
  const today = dateAfter(0);
  const form = quickStartForm(goal, {
    itemTitle: 'Long practice set',
    estimateMinutes: '120',
    date: today,
    availabilityMinutes: '30',
  });
  const draft = await harness.ok('saveDraft', parsePlanForm({ form, goal, plan: null }).payload);
  assert.equal(draft.capacity.verdict, 'over_capacity');
  assert.equal(draft.capacity.requiresTrial, true);
  assert.ok(draft.capacity.risks.length > 0);
  assert.equal(draft.plan.status, 'draft');

  const blocked = parseConfirm({
    plan: draft.plan,
    draft: draft.draft,
    capacity: draft.capacity,
    trialAcknowledged: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.field, 'trial');

  const trial = parseConfirm({
    plan: draft.plan,
    draft: draft.draft,
    capacity: draft.capacity,
    trialAcknowledged: true,
    reviewAt: dateAfter(14),
  });
  assert.equal(trial.ok, true);
  assert.equal(trial.payload.trial, true);
  assert.equal(trial.payload.reviewAt, dateAfter(14));

  const confirmed = await harness.ok('confirm', trial.payload);
  assert.equal(confirmed.plan.status, 'trial');
  assert.equal(confirmed.plan.trial, true);
  assert.equal(confirmed.plan.reviewAt, dateAfter(14));

  const get = await harness.ok('get', {});
  assert.equal(get.applied.data.trial, true);
  assert.equal(get.applied.reviewAt, dateAfter(14));
  assert.ok(get.capacity.risks.length > 0);
  assert.equal(get.applied.data.items.length, 1);
});

test('material sources round-trip and stay findable and explicitly unverified', async t => {
  const harness = await boot(t);
  const goal = await createGoal(harness, { dailyMinutes: 120 });
  const materialEnvelope = await harness.materials('importText', {
    kind: 'workbook',
    title: 'Calculus workbook',
    text: '第二章 导数\n第一题：求导。\n第二题：求导。',
  });
  assert.equal(materialEnvelope.ok, true);
  const material = materialEnvelope.value.material;

  const today = dateAfter(0);
  const form = quickStartForm(goal, {
    itemTitle: 'Chapter 2 exercises',
    estimateMinutes: '45',
    date: today,
    availabilityMinutes: '90',
    materialId: material.id,
  });
  const parsed = parsePlanForm({ form, goal, plan: null });
  parsed.payload.items[0].locator = { chapter: '第二章', unverified: ['page'] };
  const draft = await harness.ok('saveDraft', parsed.payload);
  assert.equal(draft.draft.data.items[0].materialId, material.id);
  const confirmed = await harness.ok('confirm', parseConfirm({
    plan: draft.plan,
    draft: draft.draft,
    capacity: draft.capacity,
    trialAcknowledged: false,
  }).payload);
  assert.equal(confirmed.plan.revision, 1);

  const get = await harness.ok('get', {});
  const item = get.applied.data.items[0];
  assert.equal(item.materialId, material.id);
  assert.deepEqual(item.locator, { chapter: '第二章', page: null, exercise: null, unverified: ['page'] });

  const materialsEnvelope = await harness.materials('list', {});
  const known = (materialsEnvelope.value.materials ?? []).find(entry => entry.id === material.id);
  assert.ok(known);
  const source = materialSourceOf(item, new Map([[known.id, known]]));
  assert.equal(source.material.title, 'Calculus workbook');
  assert.equal(source.chapter, '第二章');
  assert.equal(source.page, null);
  assert.deepEqual(source.unverified, ['page']);

  const missing = missingPlanInfo({
    plan: get.plan,
    applied: get.applied,
    draft: null,
    capacity: get.capacity,
    goal,
    materials: materialsEnvelope.value.materials,
  });
  assert.equal(missing.some(entry => entry.code === 'unverifiedLocator' && entry.count === 1), true);
});

test('skipping setup writes nothing and local operations keep working without a model', async t => {
  const harness = await boot(t);
  const skipped = skipOnboarding(emptyOnboardingState());
  assert.equal(skipped.phase, 'skipped');

  // No tool in this test is ever executed; only local services are called.
  const goal = await createGoal(harness, { dailyMinutes: 60 });
  const today = dateAfter(0);
  const form = quickStartForm(goal, {
    itemTitle: 'Local plan task',
    estimateMinutes: '30',
    date: today,
    availabilityMinutes: '60',
  });
  const draft = await harness.ok('saveDraft', parsePlanForm({ form, goal, plan: null }).payload);
  const confirmed = await harness.ok('confirm', parseConfirm({
    plan: draft.plan,
    draft: draft.draft,
    capacity: draft.capacity,
    trialAcknowledged: false,
  }).payload);
  assert.equal(confirmed.plan.revision, 1);

  const taskEnvelope = await harness.ctx.study.call('tasks', 'createTask', {
    title: 'Workbench task without a model',
    estimatedMinutes: 30,
  }, { requestId: crypto.randomUUID() });
  assert.equal(taskEnvelope.ok, true);
  const taskId = taskEnvelope.value.task.id;
  const blockEnvelope = await harness.ctx.study.call('tasks', 'createBlock', {
    date: today,
    start: '09:00',
    end: '09:30',
    taskId,
  }, { requestId: crypto.randomUUID() });
  assert.equal(blockEnvelope.ok, true);

  const day = await harness.ctx.study.call('tasks', 'day', { date: today });
  assert.equal(day.ok, true);
  assert.equal(day.value.blocks.length, 1);
  assert.equal(day.value.blocks[0].taskId, taskId);
  assert.equal(day.value.summary.study.minuteCount, 30);
});

test('undo names a pending draft instead of silently discarding it', async t => {
  const harness = await boot(t);
  const goal = await createGoal(harness, { dailyMinutes: 120 });
  const today = dateAfter(0);
  const firstForm = quickStartForm(goal, {
    itemTitle: 'First arrangement',
    estimateMinutes: '60',
    date: today,
    availabilityMinutes: '90',
  });
  const draft = await harness.ok('saveDraft', parsePlanForm({ form: firstForm, goal, plan: null }).payload);
  const confirmed = await harness.ok('confirm', parseConfirm({
    plan: draft.plan,
    draft: draft.draft,
    capacity: draft.capacity,
    trialAcknowledged: false,
  }).payload);
  assert.equal(confirmed.plan.revision, 1);

  const second = await harness.ok('saveDraft', {
    planId: confirmed.plan.id,
    baseRevision: 1,
    title: 'Replacement arrangement',
    items: [],
  });
  assert.equal(second.draft.baseRevision, 1);
  assert.equal(second.plan.hasDraft, true);

  const current = await harness.ok('get', {});
  const payload = undoPayload(current);
  assert.equal(payload.draftId, current.draft.id);

  const withoutDraft = await harness.call('undo', { planId: current.plan.id, baseRevision: 1 });
  assert.equal(withoutDraft.ok, false);
  assert.equal(withoutDraft.code, 'conflict');
  assert.equal(withoutDraft.details.reason, 'draft_pending');

  const undone = await harness.ok('undo', payload);
  assert.equal(undone.plan.revision, 2);
  assert.equal(undone.revision.action, 'undo');

  const after = await harness.ok('get', {});
  assert.equal(after.applied.number, 2);
  assert.equal(after.draft, null);
  assert.equal(after.revisions[0].action, 'undo');
  assert.equal(after.revisions[0].diff.removed.length, 1);
  assert.match(summarizeDiff(zh, after.revisions[0].diff), /移除 1 项/);
});
