/**
 * Time-block CRUD and the today/week views: stable ids, date/start/end
 * validation, the fixed/study split in the summary, Monday-first weeks, and
 * unscheduled-task reporting. The fixed-course rule is asserted through the
 * summary: fixed minutes and fixed tasks never reach the study totals.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boot, localDate } from './helpers.mjs';

/**
 * Create a task and return its view.
 * @param {{ ok: Function }} harness - Booted service fixture.
 * @param {object} payload - Task fields.
 * @returns {Promise<object>} Created task view.
 */
async function createTask(harness, payload) {
  const envelope = await harness.ok('createTask', payload);
  return envelope.value.task;
}

describe('time block CRUD', () => {
  it('creates a block with a stable id, times, fixed flag, and task link', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '数学分析 第3章', subject: '数学' });

    const created = await harness.ok('createBlock', {
      date: '2026-11-11',
      start: '09:05',
      end: '10:35',
      fixed: false,
      taskId: task.id,
      note: '先看例题',
    });
    const block = created.value.block;

    assert.match(block.id, /^block_[0-9a-f-]{36}$/);
    assert.equal(block.date, '2026-11-11');
    assert.equal(block.start, '09:05');
    assert.equal(block.end, '10:35');
    assert.equal(block.startMinute, 545);
    assert.equal(block.endMinute, 635);
    assert.equal(block.minutes, 90);
    assert.equal(block.fixed, false);
    assert.equal(block.taskId, task.id);
    assert.deepEqual(block.task, { id: task.id, title: task.title, subject: '数学', deleted: false });
    assert.equal(block.note, '先看例题');
  });

  it('changes date and times without changing the block id', async t => {
    const harness = await boot(t);
    const block = (await harness.ok('createBlock', {
      date: '2026-11-11',
      start: '09:00',
      end: '10:00',
      title: '复习错题',
    })).value.block;

    const updated = await harness.ok('updateBlock', {
      id: block.id,
      date: '2026-11-12',
      start: '14:00',
      end: '15:30',
      title: '复习错题（改期）',
    });
    assert.equal(updated.value.block.id, block.id);
    assert.equal(updated.value.block.date, '2026-11-12');
    assert.equal(updated.value.block.start, '14:00');
    assert.equal(updated.value.block.end, '15:30');
    assert.equal(updated.value.block.minutes, 90);
    assert.equal(updated.value.block.title, '复习错题（改期）');

    const emptyDate = await harness.fail('updateBlock', { id: block.id, date: null });
    assert.equal(emptyDate.code, 'invalid');
    assert.equal(emptyDate.details.field, 'date');
  });

  it('accepts an end at 24:00 but no block that wraps past midnight', async t => {
    const harness = await boot(t);
    const late = await harness.ok('createBlock', {
      date: '2026-11-11',
      start: '23:00',
      end: '24:00',
      title: '晚间复盘',
    });
    assert.equal(late.value.block.end, '24:00');
    assert.equal(late.value.block.minutes, 60);

    const wrap = await harness.fail('createBlock', {
      date: '2026-11-11',
      start: '22:00',
      end: '02:00',
      title: '跨夜',
    });
    assert.equal(wrap.code, 'invalid');
    assert.equal(wrap.details.field, 'end');

    const midnightStart = await harness.fail('createBlock', {
      date: '2026-11-11',
      start: '24:00',
      end: '24:30',
      title: '非法开始',
    });
    assert.equal(midnightStart.code, 'invalid');
    assert.equal(midnightStart.details.field, 'start');
  });

  it('rejects malformed dates, times, flags, and blocks with no task or title', async t => {
    const harness = await boot(t);
    const badDate = await harness.fail('createBlock', {
      date: '2026-02-30', start: '09:00', end: '10:00', title: 'x',
    });
    assert.equal(badDate.code, 'invalid');
    assert.equal(badDate.details.field, 'date');

    const badTime = await harness.fail('createBlock', {
      date: '2026-11-11', start: '9:00', end: '10:00', title: 'x',
    });
    assert.equal(badTime.code, 'invalid');
    assert.equal(badTime.details.field, 'start');

    const badFixed = await harness.fail('createBlock', {
      date: '2026-11-11', start: '09:00', end: '10:00', title: 'x', fixed: 'yes',
    });
    assert.equal(badFixed.code, 'invalid');
    assert.equal(badFixed.details.field, 'fixed');

    const empty = await harness.fail('createBlock', {
      date: '2026-11-11', start: '09:00', end: '10:00',
    });
    assert.equal(empty.code, 'invalid');
    assert.equal(empty.details.field, 'taskId');
  });

  it('requires an existing, undeleted task when one is linked', async t => {
    const harness = await boot(t);
    const missing = await harness.fail('createBlock', {
      date: '2026-11-11', start: '09:00', end: '10:00', taskId: 'task_missing',
    });
    assert.equal(missing.code, 'not_found');
    assert.equal(missing.details.taskId, 'task_missing');

    const task = await createTask(harness, { title: '会被删除' });
    await harness.ok('deleteTask', { id: task.id });

    const deleted = await harness.fail('createBlock', {
      date: '2026-11-11', start: '09:00', end: '10:00', taskId: task.id,
    });
    assert.equal(deleted.code, 'not_found');
  });

  it('deletes a block once and reports the second delete as not found', async t => {
    const harness = await boot(t);
    const block = (await harness.ok('createBlock', {
      date: '2026-11-11', start: '09:00', end: '10:00', title: '临时安排',
    })).value.block;

    const deleted = await harness.ok('deleteBlock', { id: block.id });
    assert.deepEqual(deleted.value, { id: block.id, deleted: true });

    const day = await harness.ok('day', { date: '2026-11-11' });
    assert.deepEqual(day.value.blocks, []);

    const again = await harness.fail('deleteBlock', { id: block.id });
    assert.equal(again.code, 'not_found');
  });

  it('applies one block create per requestId', async t => {
    const harness = await boot(t);
    const payload = { date: '2026-11-11', start: '09:00', end: '10:00', title: '只安排一次' };
    const first = await harness.ok('createBlock', payload, { requestId: 'block-request-1', actor: 'ui' });
    const replay = await harness.ok('createBlock', payload, { requestId: 'block-request-1', actor: 'ui' });

    assert.equal(replay.value.block.id, first.value.block.id);
    assert.equal(replay.revision, first.revision);
    const day = await harness.ok('day', { date: '2026-11-11' });
    assert.equal(day.value.blocks.length, 1);
  });
});

describe('day and week views', () => {
  it('keeps fixed courses out of the study totals', async t => {
    const harness = await boot(t);
    const date = '2026-11-11';
    const task = await createTask(harness, { title: '数学分析 第3章', subject: '数学' });
    const other = await createTask(harness, { title: '还没安排的任务' });

    await harness.ok('createBlock', {
      date, start: '08:00', end: '09:30', fixed: true, taskId: task.id, title: '高等数学课',
    });
    await harness.ok('createBlock', {
      date, start: '10:00', end: '11:00', fixed: false, taskId: task.id,
    });
    await harness.ok('createBlock', {
      date, start: '13:00', end: '13:30', fixed: false, title: '复盘笔记',
    });

    const day = (await harness.ok('day', { date })).value;
    assert.deepEqual(day.summary.study, { blockCount: 2, minuteCount: 90, taskCount: 1 });
    assert.deepEqual(day.summary.fixed, { blockCount: 1, minuteCount: 90, taskCount: 1 });
    assert.equal(day.summary.study.minuteCount + day.summary.fixed.minuteCount, 180);
    assert.deepEqual(day.blocks.map(block => block.start), ['08:00', '10:00', '13:00']);
    assert.deepEqual(day.unscheduledTaskIds, [other.id]);
    assert.deepEqual(day.tasks.map(item => item.id), [task.id, other.id]);

    const week = (await harness.ok('week', { date })).value;
    assert.deepEqual(week.summary.study, { blockCount: 2, minuteCount: 90, taskCount: 1 });
    assert.deepEqual(week.summary.fixed, { blockCount: 1, minuteCount: 90, taskCount: 1 });
    assert.deepEqual(week.unscheduledTaskIds, [other.id]);
  });

  it('starts the week on Monday and groups blocks by local date', async t => {
    const harness = await boot(t);
    await harness.ok('createBlock', { date: '2026-12-28', start: '09:00', end: '10:00', title: '周一' });
    await harness.ok('createBlock', { date: '2027-01-03', start: '19:00', end: '20:00', title: '周日' });
    await harness.ok('createBlock', { date: '2027-01-04', start: '09:00', end: '10:00', title: '下一周' });

    const week = (await harness.ok('week', { date: '2027-01-01' })).value;
    assert.equal(week.startDate, '2026-12-28');
    assert.equal(week.endDate, '2027-01-03');
    assert.deepEqual(week.days.map(day => day.date), [
      '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03',
    ]);
    assert.deepEqual(week.days.map(day => day.weekday), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(week.days[0].blocks[0].title, '周一');
    assert.equal(week.days[6].blocks[0].title, '周日');
    assert.equal(week.summary.study.blockCount, 2, '下一周的块不能计入本周');

    const friday = (await harness.ok('day', { date: '2027-01-01' })).value;
    assert.equal(friday.weekday, 5);
    assert.equal(friday.weekStart, '2026-12-28');
    assert.equal(friday.weekEnd, '2027-01-03');
  });

  it('defaults to the host local date and a Monday-first week', async t => {
    const harness = await boot(t);
    const expected = localDate();
    const day = (await harness.ok('day', {})).value;
    assert.equal(day.date, expected);

    const week = (await harness.ok('week', {})).value;
    assert.equal(week.days.length, 7);
    assert.equal(week.days[0].weekday, 1);
    assert.ok(week.days.some(entry => entry.date === expected));
  });

  it('keeps a block after its task is deleted and marks the task as deleted', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '会被删除的任务' });
    const block = (await harness.ok('createBlock', {
      date: '2026-11-11', start: '10:00', end: '11:00', taskId: task.id,
    })).value.block;

    await harness.ok('deleteTask', { id: task.id });
    const day = (await harness.ok('day', { date: '2026-11-11' })).value;

    assert.equal(day.blocks[0].id, block.id);
    assert.equal(day.blocks[0].taskId, task.id);
    assert.deepEqual(day.blocks[0].task, {
      id: task.id, title: '会被删除的任务', subject: null, deleted: true,
    });
    assert.deepEqual(day.tasks, []);
    assert.deepEqual(day.unscheduledTaskIds, []);
    assert.equal(day.summary.study.blockCount, 1);
  });
});
