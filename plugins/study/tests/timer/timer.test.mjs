/**
 * Timer service behavior through the real study kernel: start/pause/resume/end,
 * adjustable study and rest durations, the optional task link, input validation,
 * and the rule that a finished timer never completes a task.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MINUTE, bootTimer } from './helpers.mjs';

/**
 * All change-log actions recorded for a task entity.
 * @param {object} harness - Booted timer fixture.
 * @returns {string[]} Actions in append order.
 */
function taskActions(harness) {
  return harness.kernel.database
    .all("SELECT action FROM change_log WHERE entity = 'task' ORDER BY id")
    .map(row => String(row.action));
}

describe('timer session lifecycle', () => {
  it('starts, pauses, resumes, and ends a study session linked to a task', async t => {
    const harness = await bootTimer(t);
    const task = await harness.createTask('数学分析 第3章');
    const taskBefore = (await harness.ok('tasks', 'getTask', { id: task.id })).value.task;

    const started = (await harness.ok('timer', 'start', { kind: 'study', taskId: task.id })).value.session;
    assert.match(started.id, /^timer_[0-9a-f-]{36}$/);
    assert.equal(started.phase, 'running');
    assert.equal(started.kind, 'study');
    assert.equal(started.plannedMinutes, 25);
    assert.equal(started.plannedMs, 25 * MINUTE);
    assert.equal(started.focusedMs, 0);
    assert.equal(started.remainingMs, 25 * MINUTE);
    assert.deepEqual(started.task, { id: task.id, title: '数学分析 第3章', deleted: false });
    assert.equal(started.outcome, null);
    assert.equal(started.interruption, null);

    harness.tick(10 * MINUTE);
    const paused = (await harness.ok('timer', 'pause', { id: started.id })).value.session;
    assert.equal(paused.phase, 'paused');
    assert.equal(paused.focusedMs, 10 * MINUTE);
    assert.equal(paused.resumedAt, null);

    // Paused time is wall time, not study time.
    harness.sleep(5 * MINUTE);
    const stillPaused = (await harness.ok('timer', 'status', {})).value.session;
    assert.equal(stillPaused.phase, 'paused');
    assert.equal(stillPaused.focusedMs, 10 * MINUTE);

    const resumed = (await harness.ok('timer', 'resume', { id: started.id })).value.session;
    assert.equal(resumed.phase, 'running');
    harness.tick(3 * MINUTE);

    const finished = (await harness.ok('timer', 'finish', { id: started.id })).value.session;
    assert.equal(finished.phase, 'finished');
    assert.equal(finished.outcome, 'ended');
    assert.equal(finished.focusedMs, 13 * MINUTE);
    assert.ok(finished.endedAt);

    const status = (await harness.ok('timer', 'status', {})).value;
    assert.equal(status.session.id, started.id);
    assert.equal(status.session.phase, 'finished');
    assert.equal(status.lastFinished, null);

    const taskAfter = (await harness.ok('tasks', 'getTask', { id: task.id })).value.task;
    assert.deepEqual(taskAfter, taskBefore, '计时结束不得改写任务');
    assert.deepEqual(taskActions(harness), ['create'], '计时结束不得写任务');
  });

  it('records a completed session without completing the linked task', async t => {
    const harness = await bootTimer(t);
    const task = await harness.createTask('线性代数 习题 1-20');
    const taskBefore = (await harness.ok('tasks', 'getTask', { id: task.id })).value.task;
    const started = (await harness.ok('timer', 'start', {
      kind: 'study',
      taskId: task.id,
      minutes: 1,
    })).value.session;

    harness.tick(2 * MINUTE);
    const session = (await harness.ok('timer', 'status', {})).value.session;
    assert.equal(session.phase, 'finished');
    assert.equal(session.outcome, 'completed');
    assert.equal(session.focusedMs, MINUTE);
    assert.equal(session.remainingMs, 0);

    const taskAfter = (await harness.ok('tasks', 'getTask', { id: task.id })).value.task;
    assert.deepEqual(taskAfter, taskBefore, '计时到点只结束计时，不完成任务');
    assert.deepEqual(taskActions(harness), ['create']);
    assert.equal(started.plannedMinutes, 1);
  });

  it('refuses a second session while one is active', async t => {
    const harness = await bootTimer(t);
    const started = (await harness.ok('timer', 'start', { kind: 'study' })).value.session;
    const conflict = await harness.fail('timer', 'start', { kind: 'rest' });
    assert.equal(conflict.code, 'conflict');
    assert.equal(conflict.details.reason, 'session_active');
    assert.equal(conflict.details.sessionId, started.id);
    assert.equal((await harness.ok('timer', 'status', {})).value.session.id, started.id);
  });

  it('reports a missing session instead of creating one on a stray write', async t => {
    const harness = await bootTimer(t);
    const missing = await harness.fail('timer', 'pause', { id: 'timer_missing' });
    assert.equal(missing.code, 'not_found');
    assert.equal(missing.details.sessionId, 'timer_missing');
    assert.equal((await harness.ok('timer', 'status', {})).value.session, null);
  });

  it('keeps requestId idempotent across retries and rejects a changed payload', async t => {
    const harness = await bootTimer(t);
    const first = await harness.ok('timer', 'start', { kind: 'study', minutes: 5 }, { requestId: 'timer-retry-1' });
    const replay = await harness.ok('timer', 'start', { kind: 'study', minutes: 5 }, { requestId: 'timer-retry-1' });
    assert.equal(replay.value.session.id, first.value.session.id);
    assert.equal(harness.kernel.revision(), 1);
    assert.equal(harness.kernel.database.get('SELECT COUNT(*) AS count FROM study_timer_session').count, 1);

    const changed = await harness.fail('timer', 'start', { kind: 'study', minutes: 6 }, { requestId: 'timer-retry-1' });
    assert.equal(changed.code, 'conflict');
  });

  it('serves status as a read without bumping the revision or writing history', async t => {
    const harness = await bootTimer(t);
    await harness.ok('timer', 'start', { kind: 'study' });
    const revision = harness.kernel.revision();
    const changes = harness.kernel.database.get('SELECT COUNT(*) AS count FROM change_log').count;
    const status = (await harness.ok('timer', 'status', {})).value;
    assert.equal(status.session.phase, 'running');
    assert.equal(harness.kernel.revision(), revision);
    assert.equal(harness.kernel.database.get('SELECT COUNT(*) AS count FROM change_log').count, changes);
  });
});

describe('durations and settings', () => {
  it('uses 25/5 minute defaults, updates them, and starts from the saved values', async t => {
    const harness = await bootTimer(t);
    const initial = (await harness.ok('timer', 'status', {})).value;
    assert.deepEqual(initial.settings, { studyMinutes: 25, restMinutes: 5 });

    const updated = (await harness.ok('timer', 'updateSettings', { studyMinutes: 40, restMinutes: 10 })).value;
    assert.deepEqual(updated.settings, { studyMinutes: 40, restMinutes: 10 });

    const study = (await harness.ok('timer', 'start', { kind: 'study' })).value.session;
    assert.equal(study.plannedMinutes, 40);
    await harness.ok('timer', 'finish', { id: study.id });

    const rest = (await harness.ok('timer', 'start', { kind: 'rest' })).value.session;
    assert.equal(rest.plannedMinutes, 10);
    assert.equal(rest.task, null);
  });

  it('accepts a per-session duration and updates only the provided setting', async t => {
    const harness = await bootTimer(t);
    await harness.ok('timer', 'updateSettings', { studyMinutes: 30 });
    assert.deepEqual((await harness.ok('timer', 'status', {})).value.settings, { studyMinutes: 30, restMinutes: 5 });

    const session = (await harness.ok('timer', 'start', { kind: 'study', minutes: 3 })).value.session;
    assert.equal(session.plannedMinutes, 3);
    assert.equal(session.plannedMs, 3 * MINUTE);
  });

  it('rejects malformed settings and starts with a field name', async t => {
    const harness = await bootTimer(t);
    const zero = await harness.fail('timer', 'updateSettings', { studyMinutes: 0 });
    assert.equal(zero.code, 'invalid');
    assert.equal(zero.details.field, 'studyMinutes');

    const empty = await harness.fail('timer', 'updateSettings', {});
    assert.equal(empty.code, 'invalid');

    const fractional = await harness.fail('timer', 'start', { kind: 'study', minutes: 1.5 });
    assert.equal(fractional.code, 'invalid');
    assert.equal(fractional.details.field, 'minutes');

    const tooLong = await harness.fail('timer', 'start', { kind: 'study', minutes: 181 });
    assert.equal(tooLong.code, 'invalid');

    const wrongKind = await harness.fail('timer', 'start', { kind: 'nap' });
    assert.equal(wrongKind.code, 'invalid');
    assert.equal(wrongKind.details.field, 'kind');
  });

  it('rejects a task on a rest timer and a task that is gone', async t => {
    const harness = await bootTimer(t);
    const task = await harness.createTask('待删除任务');
    const restWithTask = await harness.fail('timer', 'start', { kind: 'rest', taskId: task.id });
    assert.equal(restWithTask.code, 'invalid');
    assert.equal(restWithTask.details.field, 'taskId');

    const unknown = await harness.fail('timer', 'start', { kind: 'study', taskId: 'task_missing' });
    assert.equal(unknown.code, 'not_found');
    assert.equal(unknown.details.taskId, 'task_missing');

    await harness.ok('tasks', 'deleteTask', { id: task.id });
    const deleted = await harness.fail('timer', 'start', { kind: 'study', taskId: task.id });
    assert.equal(deleted.code, 'not_found');
  });
});

describe('session settlement', () => {
  it('settles a timer whose planned time passed before a new session starts', async t => {
    const harness = await bootTimer(t);
    const first = (await harness.ok('timer', 'start', { kind: 'study', minutes: 1 })).value.session;
    harness.tick(30_000);
    // 35 s without a heartbeat: longer than the planned end but inside the
    // heartbeat tolerance, so the session counts as completed, not interrupted.
    harness.sleep(35_000);
    const second = (await harness.ok('timer', 'start', { kind: 'rest' })).value.session;
    assert.notEqual(second.id, first.id);

    const status = (await harness.ok('timer', 'status', {})).value;
    assert.equal(status.session.id, second.id);
    assert.equal(status.lastFinished.id, first.id);
    assert.equal(status.lastFinished.phase, 'finished');
    assert.equal(status.lastFinished.outcome, 'completed');
    assert.equal(status.lastFinished.focusedMs, MINUTE);
  });

  it('marks a linked task as deleted in the session view but keeps the snapshot title', async t => {
    const harness = await bootTimer(t);
    const task = await harness.createTask('会被删掉的任务');
    await harness.ok('timer', 'start', { kind: 'study', taskId: task.id });
    await harness.ok('tasks', 'deleteTask', { id: task.id });
    const session = (await harness.ok('timer', 'status', {})).value.session;
    assert.deepEqual(session.task, { id: task.id, title: '会被删掉的任务', deleted: true });
  });

  it('ends a rest session early without touching settings', async t => {
    const harness = await bootTimer(t);
    const rest = (await harness.ok('timer', 'start', { kind: 'rest', minutes: 5 })).value.session;
    harness.tick(30_000);
    const finished = (await harness.ok('timer', 'finish', { id: rest.id })).value.session;
    assert.equal(finished.outcome, 'ended');
    assert.equal(finished.focusedMs, 30_000);
    assert.deepEqual((await harness.ok('timer', 'status', {})).value.settings, { studyMinutes: 25, restMinutes: 5 });
  });
});
