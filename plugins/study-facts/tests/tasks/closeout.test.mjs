import assert from 'node:assert/strict';
import { it } from 'node:test';
import { boot } from './helpers.mjs';
import { readRows } from '../progress/helpers.mjs';
import { dateAfter, item } from '../plans/helpers.mjs';
import { randomUUID } from 'node:crypto';

it('SB-15: start-only moves keep duration, identity and reject overnight moves', async t => {
  const h = await boot(t);
  const task = (await h.ok('createTask', { title: 'A' })).value.task;
  const block = (await h.ok('createBlock', { date: '2026-11-15', start: '09:00', end: '09:30', taskId: task.id })).value.block;
  const moved = await h.ok('moveBlock', { id: block.id, date: block.date, start: '14:00' }, { requestId: 'same-day-14' });
  assert.equal(moved.value.block.end, '14:30');
  assert.equal(moved.value.block.id, block.id);
  assert.equal(moved.value.block.taskId, task.id);
  assert.equal(moved.value.block.createdAt, block.createdAt);
  assert.deepEqual(await h.ok('moveBlock', { id: block.id, date: block.date, start: '14:00' }, { requestId: 'same-day-14' }), moved);
  assert.equal(readRows(h, "SELECT COUNT(*) AS n FROM change_log WHERE entity_id = ? AND action = 'move'", block.id)[0].n, 1);
  assert.equal((await h.fail('moveBlock', { id: block.id, start: '23:45' })).code, 'invalid');
  await h.ok('createBlock', { date: '2026-11-16', start: '14:00', end: '15:00', title: 'B' });
  assert.equal((await h.fail('moveBlock', { id: block.id, date: '2026-11-16', start: '14:00' })).code, 'conflict');
  const allowed = await h.ok('moveBlock', { id: block.id, date: '2026-11-16', start: '14:00', allowOverlap: true });
  assert.equal(allowed.value.block.end, '14:30');
  assert.equal((await h.fail('moveBlock', { id: block.id, start: '15:00' }, { expectedRevision: 0 })).code, 'conflict');
});

it('SB-16: replacement appends the plan head while keeping snapshots, old progress and past blocks', async t => {
  const h = await boot(t);
  const call = async (ns, method, payload) => {
    const result = await h.ctx.study.call(ns, method, payload, { requestId: randomUUID() });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  await call('materials', 'saveGoal', { exam: 'Replacement test', dailyMinutes: 120, active: true });
  const draft = await call('plans', 'saveDraft', { title: 'Plan', baseRevision: 0, expectedDraftRevision: 0,
    availability: [{ date: dateAfter(), minutes: 120 }],
    items: [item({ id: 'old-item', title: 'Old book', start: '09:00', end: '09:30', locator: { page: 20, exercise: '1-10' } })] });
  const planId = draft.plan.id;
  await call('plans', 'confirm', { planId, baseRevision: 0, expectedDraftRevision: draft.draft.draftRevision });
  const day = (await h.ok('day', { date: dateAfter() })).value;
  const old = day.tasks[0];
  const oldBlock = day.blocks[0];
  const past = (await h.ok('createBlock', { date: dateAfter(-1), start: '09:00', end: '09:30', taskId: old.id })).value.block;
  await h.ok('recordProgress', { taskId: old.id, status: 'done' });
  const before = readRows(h, 'SELECT snapshot_json FROM study_plan_revision WHERE plan_id = ? AND number = 1', planId)[0].snapshot_json;
  const result = (await h.ok('replaceTask', { id: old.id, title: 'New book', materialRef: 'New p10' })).value;
  assert.equal(result.task.planItem?.planId, planId);
  const detail = await call('plans', 'get', { planId });
  assert.equal(detail.plan.revision, 2);
  assert.equal(detail.applied.data.items[0].taskId, result.task.id);
  assert.equal(detail.applied.data.items[0].locator, null, 'old page/exercise locator must not carry into a different book');
  const replacementSnapshot = JSON.parse(readRows(h, 'SELECT snapshot_json FROM study_plan_revision WHERE plan_id = ? AND number = 2', planId)[0].snapshot_json);
  assert.deepEqual(replacementSnapshot.items[0].blockIds, [oldBlock.id], 'new revision must not claim the original past block');
  assert.equal(readRows(h, 'SELECT snapshot_json FROM study_plan_revision WHERE plan_id = ? AND number = 1', planId)[0].snapshot_json, before);
  const current = (await h.ok('day', { date: dateAfter() })).value;
  assert.deepEqual(current.tasks.map(task => task.id), [result.task.id]);
  assert.equal(current.blocks.find(block => block.id === oldBlock.id).taskId, result.task.id);
  assert.equal((await h.ok('day', { date: dateAfter(-1) })).value.blocks.find(block => block.id === past.id).taskId, old.id);
  assert.equal((await h.ok('progress', { taskId: old.id })).value.items[0].progress.status, 'done');
  assert.equal((await h.ok('progress', { taskId: result.task.id })).value.items[0].progress, null);
  const outcome = await call('outcomes', 'day', { date: dateAfter() });
  assert.equal(outcome.completion.original.completed, 0, 'work created today is outside the day-start baseline');
  assert.equal(outcome.completion.adjusted.planned, 1);
  assert.equal(outcome.completion.adjusted.completed, 0);
  await call('plans', 'revise', { planId, baseRevision: 2, reason: 'Keep replacement when refining later',
    title: 'Updated plan', items: detail.applied.data.items });
  assert.equal((await h.ok('getTask', { id: result.task.id })).value.task.materialRef, 'New p10');
  assert.equal((await h.ok('day', { date: dateAfter(-1) })).value.blocks.find(block => block.id === past.id).taskId, old.id);
});

it('SB-16: replacement retires old work, preserves history and starts unverified without progress', async t => {
  const h = await boot(t);
  const old = (await h.ok('createTask', { title: '旧书题目', materialRef: '旧书 p20 1-10', completionCriteria: '旧书10题' })).value.task;
  const dependent = (await h.ok('createTask', { title: '后续复习', prerequisites: [old.id] })).value.task;
  await h.ok('recordProgress', { taskId: old.id, status: 'partial', quantityDone: 5, quantityTotal: 10 });
  assert.equal((await h.fail('replaceTask', { id: old.id, title: 'stale' }, { expectedRevision: 0 })).code, 'conflict');
  const replaced = await h.ok('replaceTask', { id: old.id, title: '新书题目' }, { requestId: 'replace-once' });
  const fresh = replaced.value.task;
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.replacesTaskId, old.id);
  assert.equal(fresh.materialRef, null);
  assert.equal(fresh.completionCriteria, null);
  assert.equal(fresh.materialVerification, 'unverified');
  const oldRead = (await h.ok('getTask', { id: old.id })).value.task;
  assert.equal(oldRead.supersededBy, fresh.id);
  assert.ok(oldRead.retiredAt);
  assert.deepEqual(new Set((await h.ok('listTasks', {})).value.tasks.map(task => task.id)), new Set([dependent.id, fresh.id]));
  assert.deepEqual((await h.ok('getTask', { id: dependent.id })).value.task.prerequisiteIds, [fresh.id]);
  assert.equal((await h.ok('progress', { taskId: old.id, includeHistory: true })).value.records[0].quantityDone, 5);
  assert.equal((await h.ok('progress', { taskId: fresh.id, includeHistory: true })).value.items[0].progress, null);
  assert.deepEqual(await h.ok('replaceTask', { id: old.id, title: '新书题目' }, { requestId: 'replace-once' }), replaced);
  assert.equal((await h.fail('updateTask', { id: fresh.id, materialRef: '另一本书 p30' })).details.reason, 'explicit_replacement_required');
});
