import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { boot, item, dateAfter } from './helpers.mjs';

async function fixture(t) {
  const h = await boot(t);
  const call = async (ns, method, payload = {}, requestId = randomUUID()) => {
    const result = await h.ctx.study.call(ns, method, payload, { requestId });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const goal = await call('materials', 'saveGoal', { exam: 'A', dailyMinutes: 120, active: true });
  return { ...h, call, goal: goal.goal };
}

async function plan(h, title = 'A') {
  const draft = await h.call('plans', 'saveDraft', { title, baseRevision: 0, expectedDraftRevision: 0,
    availability: [{ date: dateAfter(), minutes: 120 }], items: [item({ id: 'stable-item', start: '09:00', end: '10:00' })] });
  await h.call('plans', 'confirm', { planId: draft.plan.id, baseRevision: 0, expectedDraftRevision: draft.draft.draftRevision });
  return draft.plan.id;
}

test('SB-01: confirm materializes, moving reads live, progress and outcomes count one task', async t => {
  const h = await fixture(t);
  const planId = await plan(h);
  const day = await h.call('tasks', 'day');
  assert.equal(day.tasks.length, 1);
  assert.equal(day.blocks.length, 1);
  const taskId = day.tasks[0].id;
  await h.call('tasks', 'moveBlock', { id: day.blocks[0].id, date: dateAfter(), start: '10:00', end: '11:00' });
  const today = await h.call('plans', 'today');
  assert.equal(today.items[0].start, '10:00');
  assert.equal(today.items[0].taskId, taskId);
  const tool = await h.tool('study_plan', { action: 'today' });
  assert.equal(tool.items[0].start, '10:00');
  await h.call('plans', 'recordProgress', { planId, itemId: 'stable-item', status: 'done' });
  const progress = await h.call('tasks', 'progress', { taskId, history: true });
  assert.equal(progress.records.length, 1);
  const outcome = await h.call('outcomes', 'day');
  assert.equal(outcome.completion.adjusted.planned, 1);
  assert.equal(outcome.completion.adjusted.completed, 1);
});

test('SB-05: switching goals scopes plans, tasks, outcomes and review by goal/date', async t => {
  const h = await fixture(t);
  await plan(h);
  const a = h.goal;
  const { goal: b } = await h.call('materials', 'saveGoal', { exam: 'B', active: true, dailyMinutes: 120 });
  await plan(h, 'B');
  for (const goal of [a, b]) {
    await h.call('materials', 'saveGoal', { ...goal, active: true });
    assert.equal((await h.call('plans', 'get')).plan.goalId, goal.id);
    assert.equal((await h.call('tasks', 'day')).tasks.length, 1);
    assert.equal((await h.call('outcomes', 'day')).completion.adjusted.planned, 1);
    await h.call('followup', 'review', { goalId: goal.id, date: dateAfter() });
    assert.equal((await h.call('followup', 'reviewStatus', { goalId: goal.id })).review.goalId, goal.id);
  }
});

test('SB-03: draft CAS rejects stale save and confirmation, survives restart', async t => {
  const h = await fixture(t);
  const d = await h.call('plans', 'saveDraft', { title: 'first', baseRevision: 0, expectedDraftRevision: 0, items: [] });
  const payload = { planId: d.plan.id, title: 'manual', baseRevision: 0, expectedDraftRevision: 1, items: [] };
  const next = await h.call('plans', 'saveDraft', payload);
  assert.equal(next.draft.draftRevision, 2);
  for (const [method, body] of [['saveDraft', payload], ['confirm', { ...payload }]]) {
    const result = await h.ctx.study.call('plans', method, body, { requestId: randomUUID() });
    assert.equal(result.code, 'conflict');
    assert.equal(result.details.draftRevision, 2);
  }
  await h.fiber.dispose();
  const reopened = await boot(t, { directory: h.directory });
  assert.equal((await reopened.ok('get', { planId: d.plan.id })).draft.draftRevision, 2);
  await reopened.fiber.dispose();
});

test('SB-08: missing request ID rejected, creates replay and mismatched payload conflicts', async t => {
  const h = await fixture(t);
  const raw = h.ctx.study.call;
  assert.equal((await raw('tasks', 'createTask', { title: 'missing' })).code, 'invalid');
  for (const [ns, method, payload] of [
    ['materials', 'saveGoal', { exam: 'C' }],
    ['materials', 'importText', { title: 'notes', text: '导数知识', kind: 'notes' }],
    ['memory', 'remember', { text: '晚上学习', kind: 'preference' }],
  ]) {
    const id = randomUUID();
    const first = await h.call(ns, method, payload, id);
    assert.deepEqual(await h.call(ns, method, payload, id), first);
    const conflict = await raw(ns, method, { ...payload, note: 'changed' }, { requestId: id });
    assert.equal(conflict.code, 'conflict');
  }
});

test('SB-08: memory and request receipt roll back together when the database write fails', async t => {
  const h = await fixture(t);
  const db = new DatabaseSync(join(h.directory, 'study.db'));
  db.exec("CREATE TRIGGER fail_request BEFORE INSERT ON request_log BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const result = await h.ctx.study.call('memory', 'remember', { text: 'rollback only' }, { requestId: 'rollback-memory' });
  assert.equal(result.ok, false);
  db.exec('DROP TRIGGER fail_request');
  db.close();
  assert.equal((await h.call('memory', 'recall')).items.length, 0);
});

test('SB-03: discard and recreate cannot reuse a stale draft version', async t => {
  const h = await fixture(t);
  const planId = await plan(h);
  const draft = await h.call('plans', 'saveDraft', { planId, baseRevision: 1, expectedDraftRevision: 0, items: [] });
  await h.call('plans', 'discardDraft', { planId, baseRevision: 1, expectedDraftRevision: draft.draft.draftRevision });
  const replacement = await h.call('plans', 'saveDraft', { planId, baseRevision: 1, expectedDraftRevision: 0, items: [] });
  assert.ok(replacement.draft.draftRevision > draft.draft.draftRevision);
  const stale = await h.ctx.study.call('plans', 'confirm', { planId, baseRevision: 1,
    expectedDraftRevision: draft.draft.draftRevision }, { requestId: randomUUID() });
  assert.equal(stale.code, 'conflict');
});

test('SB-05: another goal schedule cannot create a conflict or leak memories', async t => {
  const h = await fixture(t);
  await plan(h);
  await h.call('memory', 'remember', { text: 'A preference' });
  const { goal: b } = await h.call('materials', 'saveGoal', { exam: 'B', active: true });
  assert.equal((await h.call('memory', 'recall')).items.length, 0);
  const { task } = await h.call('tasks', 'createTask', { title: 'B task' });
  await h.call('tasks', 'createBlock', { taskId: task.id, date: dateAfter(), start: '09:00', end: '10:00' });
  const sameGoal = await h.ctx.study.call('tasks', 'createBlock',
    { taskId: task.id, date: dateAfter(), start: '09:30', end: '10:30' }, { requestId: randomUUID() });
  assert.equal(sameGoal.code, 'conflict', '同一目标内的重叠仍要拒绝');
  assert.equal(sameGoal.details.reason, 'overlap');
  assert.equal((await h.call('tasks', 'day')).blocks.length, 1);
  assert.equal((await h.call('tasks', 'day', { goalId: h.goal.id })).blocks.length, 1);
  assert.equal((await h.call('memory', 'recall', { goalId: h.goal.id })).items.length, 1);
  assert.equal((await h.call('tasks', 'day')).tasks[0].goalId, b.id);
});

test('SB-08: Agent tool executor callId replays material imports and memory writes', async t => {
  const h = await fixture(t);
  const memory = { text: 'Agent preference' };
  assert.deepEqual(await h.tool('memory_remember', memory, { callId: 'same-memory-call' }),
    await h.tool('memory_remember', memory, { callId: 'same-memory-call' }));
  await assert.rejects(h.tool('memory_remember', { text: 'different' }, { callId: 'same-memory-call' }), /conflict/);
  const material = { action: 'import_text', title: 'Agent notes', text: '导数学习资料' };
  const a = await h.tool('study_materials', material, { callId: 'same-material-call' });
  const b = await h.tool('study_materials', material, { callId: 'same-material-call' });
  assert.equal(a.material.id, b.material.id);
});
