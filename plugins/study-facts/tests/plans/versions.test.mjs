import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { boot, dateAfter, item, planPayload } from './helpers.mjs';

async function confirmedPlan(harness, payload = planPayload()) {
  const draft = await harness.ok('saveDraft', payload);
  const confirmed = await harness.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  return { planId: draft.plan.id, draft, confirmed };
}

test('confirmation creates revision 1 and a revision keeps its reason, diff, and item identity', async t => {
  const harness = await boot(t);
  const { planId, confirmed } = await confirmedPlan(harness);
  assert.equal(confirmed.plan.revision, 1);
  assert.equal(confirmed.plan.status, 'active');
  assert.equal(confirmed.changes.added.length, 2);
  assert.equal(confirmed.changes.summary, '新增 2 项、调整 0 项、移除 0 项');
  const [first, second] = confirmed.revision.data.items;

  const revised = await harness.ok('revise', {
    planId,
    baseRevision: 1,
    reason: '把第一项缩短到 30 分钟',
    title: '第二版计划',
    items: [
      item({ id: first.id, title: first.title, estimateMinutes: 30 }),
      second,
    ],
  });
  assert.equal(revised.plan.revision, 2);
  assert.equal(revised.revision.action, 'revise');
  assert.equal(revised.revision.reason, '把第一项缩短到 30 分钟');
  assert.equal(revised.changes.changed.length, 1);
  assert.deepEqual(revised.changes.changed[0], {
    id: first.id,
    title: first.title,
    fields: ['estimateMinutes'],
  });
  assert.equal(revised.changes.titleChanged, true);
  assert.equal(revised.changes.totals.beforeMinutes, 120);
  assert.equal(revised.changes.totals.afterMinutes, 90);
  assert.equal(revised.revision.data.items[0].id, first.id);

  const read = await harness.ok('get', { planId });
  assert.equal(read.plan.title, '第二版计划');
  assert.equal(read.plan.revision, 2);
  assert.equal(read.revisions.length, 2);
  assert.deepEqual(read.revisions.map(revision => [revision.number, revision.status]), [[2, 'applied'], [1, 'superseded']]);
  assert.equal(read.applied.number, 2);
  assert.equal(read.draft, null);

  const revisions = await harness.ok('revisions', { planId, limit: 1 });
  assert.equal(revisions.revision, 2);
  assert.equal(revisions.revisions.length, 1);
  assert.equal(revisions.revisions[0].number, 2);
  assert.equal(revisions.revisions[0].reason, '把第一项缩短到 30 分钟');
});

test('a stale draft is rejected and the response carries the latest version', async t => {
  const harness = await boot(t);
  const { planId, confirmed } = await confirmedPlan(harness);
  const [first] = confirmed.revision.data.items;
  await harness.ok('revise', {
    planId,
    baseRevision: 1,
    reason: '第一版修订',
    title: '最新版',
    items: [item({ id: first.id, title: first.title })],
  });

  const stale = await harness.fail('saveDraft', {
    planId,
    baseRevision: 1,
    title: '过期草案',
    items: [item()],
  });
  assert.equal(stale.code, 'conflict');
  assert.equal(stale.details.baseRevision, 1);
  assert.equal(stale.details.revision, 2);
  assert.equal(stale.details.latest.plan.revision, 2);
  assert.equal(stale.details.latest.plan.title, '最新版');
  assert.equal(stale.details.latest.applied.number, 2);
  assert.equal(stale.details.latest.applied.data.title, '最新版');
  assert.equal(stale.details.latest.draft, null);

  const read = await harness.ok('get', { planId });
  assert.equal(read.draft, null, 'a rejected draft must not be stored');
  assert.equal(read.plan.revision, 2);
});

test('confirmation also rejects a baseRevision that fell behind and returns the pending draft', async t => {
  const harness = await boot(t);
  const { planId, confirmed } = await confirmedPlan(harness);
  const [first] = confirmed.revision.data.items;
  const draft = await harness.ok('saveDraft', {
    planId,
    baseRevision: 1,
    title: '待确认草案',
    items: [item({ id: first.id, title: first.title })],
  });
  assert.equal(draft.draft.baseRevision, 1);

  const stale = await harness.fail('confirm', { planId, baseRevision: 0 });
  assert.equal(stale.code, 'conflict');
  assert.equal(stale.details.revision, 1);
  assert.equal(stale.details.latest.draft.data.title, '待确认草案');
  assert.equal((await harness.ok('get', { planId })).draft.data.title, '待确认草案');

  const applied = await harness.ok('confirm', { planId, baseRevision: 1 });
  assert.equal(applied.plan.revision, 2);
  assert.equal(applied.plan.title, '待确认草案');
});

test('the global expectedRevision rejects a stale write, and requestId replays only the same content', async t => {
  const harness = await boot(t);
  const payload = planPayload({ title: '幂等草案' });
  const first = await harness.call('saveDraft', payload, { requestId: 'draft-once', actor: 'ui' });
  assert.equal(first.ok, true);
  const replay = await harness.call('saveDraft', payload, { requestId: 'draft-once', actor: 'ui' });
  assert.deepEqual(replay, first);

  const conflict = await harness.call('saveDraft', planPayload({ title: '不同内容' }), { requestId: 'draft-once', actor: 'ui' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');

  const stale = await harness.call('saveDraft', planPayload({ title: '全局过期' }), { expectedRevision: first.revision + 10 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'conflict');
  assert.equal(stale.details.expectedRevision, first.revision + 10);
  assert.equal(stale.details.revision, first.revision);

  const read = await harness.call('get', {});
  assert.equal(read.ok, true);
  assert.equal(read.revision, first.revision);
  assert.equal(read.value.plan.title, '幂等草案');
});

test('a draft never replaces the confirmed plan used by today and week', async t => {
  const harness = await boot(t);
  const { planId, confirmed } = await confirmedPlan(harness);
  const [first] = confirmed.revision.data.items;
  assert.equal((await harness.ok('today', { planId })).items.length, 2);

  await harness.ok('saveDraft', {
    planId,
    baseRevision: 1,
    title: '未确认的新安排',
    items: [item({ id: first.id, title: first.title, estimateMinutes: 15 })],
  });
  const today = await harness.ok('today', { planId });
  assert.equal(today.plan.title, '2026 考研数学计划');
  assert.equal(today.items.length, 2);
  assert.equal(today.plan.hasDraft, true);

  const confirmedAgain = await harness.ok('confirm', { planId, baseRevision: 1 });
  assert.equal(confirmedAgain.plan.title, '未确认的新安排');
  assert.equal((await harness.ok('today', { planId })).items.length, 1);
});

test('undo appends a new revision that restores the previous arrangement without touching progress', async t => {
  const harness = await boot(t);
  const { planId, confirmed } = await confirmedPlan(harness);
  const [first, second] = confirmed.revision.data.items;
  const v1Ids = confirmed.revision.data.items.map(entry => entry.id);

  await harness.ok('recordProgress', {
    planId,
    itemId: first.id,
    status: 'done',
    quantityDone: 10,
    quantityTotal: 10,
    note: '全部做完',
  });

  const revised = await harness.ok('revise', {
    planId,
    baseRevision: 1,
    reason: '换掉第二项',
    items: [
      item({ id: first.id, title: first.title, estimateMinutes: 30 }),
      item({ title: '第三章 预习', estimateMinutes: 60, start: '20:10', end: '21:10' }),
    ],
  });
  assert.equal(revised.plan.revision, 2);
  const removedId = second.id;
  assert.ok(revised.changes.removed.some(entry => entry.id === removedId));

  const undone = await harness.ok('undo', { planId, baseRevision: 2 });
  assert.equal(undone.plan.revision, 3);
  assert.equal(undone.revision.action, 'undo');
  assert.equal(undone.revision.reason, '撤销修订 2');
  assert.deepEqual(undone.revision.data.items.map(entry => entry.id), v1Ids);
  assert.equal(undone.revision.data.items.length, 2);
  assert.equal(undone.undone.number, 2);
  assert.equal(undone.undone.status, 'undone');
  assert.ok(undone.changes.removed.some(entry => entry.title === '第三章 预习'));

  const read = await harness.ok('get', { planId });
  assert.deepEqual(read.revisions.map(revision => [revision.number, revision.status, revision.undoneBy]), [
    [3, 'applied', null],
    [2, 'undone', 3],
    [1, 'superseded', null],
  ]);

  const progress = await harness.ok('progress', { planId });
  const firstItem = progress.items.find(entry => entry.id === first.id);
  assert.equal(firstItem.progress.status, 'done');
  assert.equal(firstItem.progress.confirmed, true);
  assert.equal(progress.summary.counts.done, 1);
  assert.equal(progress.summary.counts.unrecorded, 1);
  assert.equal(progress.summary.minutes.doneEstimate, 60);

  const database = new DatabaseSync(join(harness.directory, 'study.db'), { readOnly: true });
  try {
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM study_task_progress').get().count), 1);
  } finally {
    database.close();
  }
});

test('a pending draft must be acknowledged before a revision or undo replaces it', async t => {
  const harness = await boot(t);
  const { planId, confirmed } = await confirmedPlan(harness);
  const [first] = confirmed.revision.data.items;
  const draft = await harness.ok('saveDraft', {
    planId,
    baseRevision: 1,
    title: '学生手动草案',
    items: [item({ id: first.id, title: first.title })],
  });

  const guarded = await harness.fail('revise', {
    planId,
    baseRevision: 1,
    reason: '晚间重排',
    items: [item({ id: first.id, title: first.title })],
  });
  assert.equal(guarded.code, 'conflict');
  assert.equal(guarded.details.reason, 'draft_pending');
  assert.equal(guarded.details.draftId, draft.draft.id);
  assert.equal(guarded.details.latest.draft.data.title, '学生手动草案');

  const undoGuard = await harness.fail('undo', { planId, baseRevision: 1 });
  assert.equal(undoGuard.code, 'conflict');
  assert.equal(undoGuard.details.reason, 'draft_pending');
  assert.equal((await harness.ok('get', { planId })).draft.data.title, '学生手动草案');

  const revised = await harness.ok('revise', {
    planId,
    baseRevision: 1,
    draftId: draft.draft.id,
    reason: '合并草案后修订',
    items: [item({ id: first.id, title: '合并后的任务' })],
  });
  assert.equal(revised.plan.revision, 2);
  assert.equal(revised.plan.title, '学生手动草案');
  assert.equal((await harness.ok('get', { planId })).draft, null);
});

test('undoing the first revision keeps the plan and clears its items', async t => {
  const harness = await boot(t);
  const { planId, confirmed } = await confirmedPlan(harness);
  const undone = await harness.ok('undo', { planId, baseRevision: 1, reason: '第一版作废' });
  assert.equal(undone.plan.revision, 2);
  assert.equal(undone.plan.title, confirmed.plan.title);
  assert.equal(undone.plan.counts.items, 0);
  assert.deepEqual(undone.revision.data.items, []);
  assert.equal(undone.changes.removed.length, 2);
  assert.equal((await harness.ok('today', { planId })).items.length, 0);
});

test('undo only accepts the latest revision and a current base revision', async t => {
  const harness = await boot(t);
  const { planId, confirmed } = await confirmedPlan(harness);
  await harness.ok('revise', {
    planId,
    baseRevision: 1,
    reason: '修订一',
    items: [item({ id: confirmed.revision.data.items[0].id, title: confirmed.revision.data.items[0].title })],
  });
  await harness.ok('revise', {
    planId,
    baseRevision: 2,
    reason: '修订二',
    items: [item({ id: confirmed.revision.data.items[0].id, title: confirmed.revision.data.items[0].title, estimateMinutes: 30 })],
  });

  const notLatest = await harness.fail('undo', { planId, baseRevision: 3, revisionNumber: 1 });
  assert.equal(notLatest.code, 'invalid');
  assert.equal(notLatest.details.reason, 'undo_not_latest');
  assert.equal(notLatest.details.latest, 3);

  const stale = await harness.fail('undo', { planId, baseRevision: 2 });
  assert.equal(stale.code, 'conflict');
  assert.equal(stale.details.revision, 3);
  assert.equal(stale.details.latest.applied.number, 3);

  await harness.ok('undo', { planId, baseRevision: 3 });
  assert.equal((await harness.ok('get', { planId })).plan.revision, 4);
});

test('revision validation names what is missing or not yet confirmed', async t => {
  const harness = await boot(t);
  const draft = await harness.ok('saveDraft', planPayload());
  assert.equal(draft.plan.revision, 0);

  const unconfirmed = await harness.fail('revise', { planId: draft.plan.id, baseRevision: 0, reason: '提前修订', items: [item()] });
  assert.equal(unconfirmed.code, 'invalid');
  assert.equal(unconfirmed.details.reason, 'plan_not_confirmed');

  await harness.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  const noReason = await harness.fail('revise', { planId: draft.plan.id, baseRevision: 1, items: [item()] });
  assert.equal(noReason.code, 'invalid');
  assert.equal(noReason.details.field, 'reason');

  const missingPlan = await harness.fail('revise', { planId: 'plan_missing', reason: '没有计划', items: [item()] });
  assert.equal(missingPlan.code, 'not_found');
  assert.equal(missingPlan.details.planId, 'plan_missing');
});

test('discarding a draft removes it, and an empty plan disappears from the list', async t => {
  const harness = await boot(t);
  const draft = await harness.ok('saveDraft', planPayload({ title: '临时草案' }));
  const discarded = await harness.ok('discardDraft', { planId: draft.plan.id, baseRevision: 0 });
  assert.equal(discarded.discarded, true);
  assert.equal(discarded.plan, null);
  assert.deepEqual((await harness.ok('list', {})).plans, []);

  const kept = await harness.ok('saveDraft', planPayload({ title: '保留的计划' }));
  await harness.ok('confirm', { planId: kept.plan.id, baseRevision: 0 });
  await harness.ok('saveDraft', { planId: kept.plan.id, baseRevision: 1, title: '待丢弃', items: [item()] });
  const keptDiscard = await harness.ok('discardDraft', { planId: kept.plan.id, baseRevision: 1 });
  assert.equal(keptDiscard.discarded, true);
  assert.equal(keptDiscard.plan.revision, 1);
  assert.equal(keptDiscard.plan.hasDraft, false);

  const stale = await harness.fail('discardDraft', { planId: kept.plan.id, baseRevision: 0 });
  assert.equal(stale.code, 'conflict');
  assert.equal(stale.details.latest.plan.revision, 1);
});

test('a reopen reads the same revisions, trial flag, and review date', async t => {
  const harness = await boot(t, { cleanup: false });
  const today = dateAfter(0);
  const draft = await harness.ok('saveDraft', planPayload({
    availability: [{ date: today, minutes: 60 }],
    items: [item({ title: '排不下的任务', estimateMinutes: 120, start: '19:00', end: '21:00' })],
  }));
  await harness.ok('confirm', { planId: draft.plan.id, baseRevision: 0, trial: true });
  const directory = harness.directory;

  await harness.fiber.dispose();
  const reopened = await boot(t, { directory });
  const read = await reopened.ok('get', {});
  assert.equal(read.plan.revision, 1);
  assert.equal(read.plan.trial, true);
  assert.equal(read.plan.reviewAt, dateAfter(7));
  assert.equal(read.applied.data.items.length, 1);
  assert.equal(read.capacity.requiresTrial, true);
  assert.equal(read.capacity.verdict, 'over_capacity');
});
