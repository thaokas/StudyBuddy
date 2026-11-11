import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { boot, dateAfter, item, planPayload } from './helpers.mjs';

const THREE_ITEMS = planPayload({
  availability: [{ date: dateAfter(0), minutes: 180 }],
  items: [
    item({ title: '第二章 习题 1-10', start: null, end: null }),
    item({ title: '错题订正', start: null, end: null }),
    item({ title: '第三章 预习', start: null, end: null }),
  ],
});

async function activePlan(harness, payload = THREE_ITEMS) {
  const draft = await harness.ok('saveDraft', payload);
  const confirmed = await harness.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  return {
    planId: draft.plan.id,
    items: confirmed.revision.data.items,
  };
}

test('progress keeps the latest state per item and the full append-only history', async t => {
  const harness = await boot(t);
  const { planId, items } = await activePlan(harness);
  const [first, second, third] = items;

  const firstRecord = await harness.ok('recordProgress', {
    planId,
    itemId: first.id,
    status: 'done',
    quantityDone: 10,
    quantityTotal: 10,
    note: '全部做完',
  });
  assert.equal(firstRecord.progress.status, 'done');
  assert.equal(firstRecord.progress.confirmed, true);
  assert.equal(firstRecord.record.actor, 'internal');

  await harness.ok('recordProgress', { planId, itemId: second.id, status: 'partial', quantityDone: 2, quantityTotal: 5, note: '做了前两题' });
  await harness.ok('recordProgress', { planId, itemId: third.id, status: 'cancelled', note: '今天不做了' });

  const read = await harness.ok('progress', { planId });
  assert.equal(read.revision, 1);
  assert.equal(read.items.length, 3);
  assert.deepEqual(read.items.map(entry => entry.progress.status), ['done', 'partial', 'cancelled']);
  assert.equal(read.summary.counts.done, 1);
  assert.equal(read.summary.counts.partial, 1);
  assert.equal(read.summary.counts.cancelled, 1);
  assert.equal(read.summary.counts.unrecorded, 0);
  assert.deepEqual(read.summary.completion, {
    countedItems: 2,
    completedItems: 1,
    cancelledItems: 1,
    pendingItems: 0,
    note: '取消不计入完成率；未记录不等于未学习。',
  });
  assert.deepEqual(read.summary.minutes, {
    planned: 180,
    scheduled: 180,
    unscheduled: 0,
    doneEstimate: 60,
    cancelledEstimate: 60,
  });
  assert.equal(read.records, undefined);

  const history = await harness.ok('progress', { planId, history: true });
  assert.equal(history.records.length, 3);

  await harness.ok('recordProgress', { planId, itemId: second.id, status: 'done', quantityDone: 5, quantityTotal: 5 });
  const afterSecond = await harness.ok('progress', { planId });
  assert.equal(afterSecond.items[1].progress.status, 'done');
  assert.equal(afterSecond.summary.counts.done, 2);
  assert.equal(afterSecond.summary.counts.partial, 0);
  assert.equal(afterSecond.summary.completion.completedItems, 2);

  await harness.ok('recordProgress', { planId, itemId: first.id, status: 'in_progress', confirmed: false, note: '按学生口述记录' });
  const unconfirmed = await harness.ok('progress', { planId });
  assert.equal(unconfirmed.items[0].progress.status, 'in_progress');
  assert.equal(unconfirmed.items[0].progress.confirmed, false);
  assert.equal(unconfirmed.summary.counts.pendingConfirmation, 1);
  assert.equal(unconfirmed.summary.counts.inProgress, 1);
  assert.equal(unconfirmed.summary.completion.completedItems, 1);
  assert.equal(unconfirmed.summary.completion.pendingItems, 1);
  assert.equal(unconfirmed.summary.minutes.doneEstimate, 60);

  const week = await harness.ok('week', { planId });
  const today = week.days.find(day => day.date === dateAfter(0));
  assert.deepEqual(today.items.map(entry => entry.progress.status), ['in_progress', 'done', 'cancelled']);
  assert.equal(week.totals.completedItems, 1);

  const onlyFirst = await harness.ok('progress', { planId, itemId: first.id });
  assert.equal(onlyFirst.items.length, 1);
  assert.equal(onlyFirst.items[0].id, first.id);
});

test('progress feedback is validated before it is stored', async t => {
  const harness = await boot(t);
  const { planId, items } = await activePlan(harness);
  const itemId = items[0].id;

  const cases = [
    [{ itemId, status: 'finished' }, 'status'],
    [{ itemId, status: 'done', quantityDone: 6, quantityTotal: 5 }, 'quantityDone'],
    [{ itemId, status: 'done', quantityDone: 4, quantityTotal: 5 }, 'quantityDone'],
    [{ itemId, status: 'partial', quantityDone: -1 }, 'quantityDone'],
    [{ itemId, status: 'partial', note: 'x'.repeat(501) }, 'note'],
    [{ itemId, status: 'partial', date: '2026-02-30' }, 'date'],
  ];
  for (const [payload, field] of cases) {
    const result = await harness.fail('recordProgress', { planId, ...payload });
    assert.equal(result.code, 'invalid', JSON.stringify(payload));
    assert.equal(result.details.field, field, JSON.stringify(payload));
  }

  const unknown = await harness.fail('recordProgress', { planId, itemId: 'item_missing', status: 'done' });
  assert.equal(unknown.code, 'not_found');
  assert.equal(unknown.details.itemId, 'item_missing');

  assert.equal((await harness.ok('progress', { planId, history: true })).records.length, 0);
});

test('progress writes are idempotent per requestId and the table rejects updates', async t => {
  const harness = await boot(t);
  const { planId, items } = await activePlan(harness);
  const payload = { planId, itemId: items[0].id, status: 'done', note: '一次反馈' };

  const first = await harness.call('recordProgress', payload, { requestId: 'progress-once', actor: 'ui' });
  assert.equal(first.ok, true);
  const replay = await harness.call('recordProgress', payload, { requestId: 'progress-once', actor: 'ui' });
  assert.deepEqual(replay, first);

  const conflict = await harness.call('recordProgress', { ...payload, status: 'partial' }, { requestId: 'progress-once', actor: 'ui' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');

  const database = new DatabaseSync(join(harness.directory, 'study.db'));
  try {
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM study_task_progress').get().count), 1);
    assert.throws(() => database.prepare("UPDATE study_task_progress SET status = 'cancelled'").run(), /append-only/);
    assert.throws(() => database.prepare('DELETE FROM study_task_progress').run(), /append-only/);
    assert.equal(
      database.prepare('SELECT status FROM study_task_progress').get().status,
      'done',
      'a refused change leaves the learning record intact',
    );
  } finally {
    database.close();
  }
});

test('a plan that is not confirmed has no recordable progress', async t => {
  const harness = await boot(t);
  const empty = await harness.ok('progress', {});
  assert.equal(empty.planId, null);
  assert.equal(empty.summary, null);
  assert.match(empty.notice, /还没有/);

  const draft = await harness.ok('saveDraft', planPayload());
  const draftProgress = await harness.ok('progress', { planId: draft.plan.id });
  assert.equal(draftProgress.revision, 0);
  assert.deepEqual(draftProgress.items, []);
  assert.equal(draftProgress.summary.itemCount, 0);
  assert.match(draftProgress.notice, /尚未确认/);

  const refused = await harness.fail('recordProgress', { planId: draft.plan.id, itemId: draft.draft.data.items[0].id, status: 'done' });
  assert.equal(refused.code, 'invalid');
  assert.equal(refused.details.reason, 'plan_not_confirmed');

  const noPlan = await harness.fail('recordProgress', { planId: 'plan_missing', itemId: 'item_x', status: 'done' });
  assert.equal(noPlan.code, 'not_found');
});
