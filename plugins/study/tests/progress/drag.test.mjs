/**
 * T06 drag evidence: a block moves as one unit to another day, keeps its id,
 * its task association, and its creation time, never touches the other blocks
 * or the task record, and refuses to land on an existing block unless the
 * student explicitly keeps the overlap.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boot, createBlock, createTask, historyOf, readRows } from './helpers.mjs';

const DAY_ONE = '2026-11-11';
const DAY_TWO = '2026-11-12';

describe('single-block drag', () => {
  it('moves only the selected block across days and keeps task identity and history', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '数学分析 第3章', subject: '数学' });
    const moving = await createBlock(harness, {
      date: DAY_ONE, start: '09:00', end: '10:00', taskId: task.id, note: '拖我',
    });
    const staying = await createBlock(harness, {
      date: DAY_ONE, start: '14:00', end: '15:00', taskId: task.id,
    });
    const otherDay = await createBlock(harness, {
      date: DAY_TWO, start: '20:00', end: '21:00', title: '别动我',
    });
    assert.deepEqual(historyOf(harness, 'time_block', moving.id).map(row => row.action), ['create']);

    const moved = await harness.ok('moveBlock', {
      id: moving.id,
      date: DAY_TWO,
      reason: '拖拽移动',
    }, { actor: 'ui' });

    assert.equal(moved.value.moved, true);
    assert.equal(moved.value.block.id, moving.id);
    assert.equal(moved.value.block.taskId, task.id);
    assert.equal(moved.value.block.date, DAY_TWO);
    assert.equal(moved.value.block.start, moving.start);
    assert.equal(moved.value.block.end, moving.end);
    assert.equal(moved.value.block.createdAt, moving.createdAt);
    assert.equal(moved.value.block.task.title, task.title);

    const firstDay = (await harness.ok('day', { date: DAY_ONE })).value;
    assert.deepEqual(firstDay.blocks.map(block => block.id), [staying.id]);
    const secondDay = (await harness.ok('day', { date: DAY_TWO })).value;
    assert.deepEqual(secondDay.blocks.map(block => block.id), [moving.id, otherDay.id]);

    const stayingView = secondDay.blocks.find(block => block.id === moving.id);
    assert.equal(stayingView.taskId, task.id);    const untouched = (await harness.ok('getTask', { id: task.id })).value.task;
    assert.deepEqual(untouched, task, '拖拽不能改任务身份或任务历史');

    const history = historyOf(harness, 'time_block', moving.id);
    assert.deepEqual(history.map(row => row.action), ['create', 'move']);
    const moveRow = history[1];
    assert.equal(moveRow.actor, 'ui');
    assert.equal(JSON.parse(moveRow.before_json).date, DAY_ONE);
    assert.equal(JSON.parse(moveRow.after_json).date, DAY_TWO);
    assert.equal(JSON.parse(moveRow.after_json).taskId, task.id);
    assert.equal(moveRow.reason, '拖拽移动');
    assert.deepEqual(historyOf(harness, 'time_block', staying.id).map(row => row.action), ['create']);
    assert.deepEqual(historyOf(harness, 'time_block', otherDay.id).map(row => row.action), ['create']);
  });

  it('does not write anything when the drop target equals the current slot', async t => {
    const harness = await boot(t);
    const block = await createBlock(harness, {
      date: DAY_ONE, start: '09:00', end: '10:00', title: '原地',
    });
    const changesBefore = readRows(harness, 'SELECT COUNT(*) AS count FROM change_log')[0].count;

    const same = await harness.ok('moveBlock', { id: block.id, date: DAY_ONE, start: '09:00', end: '10:00' });
    assert.equal(same.value.moved, false);
    assert.deepEqual(same.value.block, block);

    const again = await harness.ok('moveBlock', { id: block.id, date: DAY_ONE });
    assert.equal(again.value.moved, false);

    assert.equal(readRows(harness, 'SELECT COUNT(*) AS count FROM change_log')[0].count, changesBefore);
  });

  it('changes the time inside the same day as well', async t => {
    const harness = await boot(t);
    const block = await createBlock(harness, {
      date: DAY_ONE, start: '09:00', end: '10:00', title: '同日内挪动',
    });
    const moved = await harness.ok('moveBlock', { id: block.id, start: '15:30', end: '16:15' });
    assert.equal(moved.value.moved, true);
    assert.equal(moved.value.block.date, DAY_ONE);
    assert.equal(moved.value.block.start, '15:30');
    assert.equal(moved.value.block.end, '16:15');
    assert.equal(moved.value.block.minutes, 45);
    assert.equal(moved.value.block.id, block.id);
  });

  it('rejects a missing block and malformed targets', async t => {
    const harness = await boot(t);
    const block = await createBlock(harness, {
      date: DAY_ONE, start: '09:00', end: '10:00', title: '参数检查',
    });

    const missing = await harness.fail('moveBlock', { id: 'block_missing', date: DAY_TWO });
    assert.equal(missing.code, 'not_found');
    assert.equal(missing.details.blockId, 'block_missing');

    const badDate = await harness.fail('moveBlock', { id: block.id, date: '2026-02-30' });
    assert.equal(badDate.code, 'invalid');
    assert.equal(badDate.details.field, 'date');

    const backwards = await harness.fail('moveBlock', { id: block.id, start: '11:00', end: '10:00' });
    assert.equal(backwards.code, 'invalid');
    assert.equal(backwards.details.field, 'end');

    const midnight = await harness.fail('moveBlock', { id: block.id, start: '24:00', end: '24:30' });
    assert.equal(midnight.code, 'invalid');
    assert.equal(midnight.details.field, 'start');

    const untouched = (await harness.ok('day', { date: DAY_ONE })).value;
    assert.equal(untouched.blocks[0].start, '09:00');
  });

  it('applies one move per requestId and reports a reused id with other content as conflict', async t => {
    const harness = await boot(t);
    const block = await createBlock(harness, { date: DAY_ONE, start: '09:00', end: '10:00', title: '幂等' });
    const payload = { id: block.id, date: DAY_TWO };
    const first = await harness.ok('moveBlock', payload, { requestId: 'move-request-1', actor: 'ui' });
    const replay = await harness.ok('moveBlock', payload, { requestId: 'move-request-1', actor: 'ui' });
    assert.equal(replay.value.block.date, DAY_TWO);
    assert.equal(replay.revision, first.revision);
    assert.equal(historyOf(harness, 'time_block', block.id).filter(row => row.action === 'move').length, 1);

    const conflict = await harness.fail('moveBlock', { id: block.id, date: DAY_ONE }, {
      requestId: 'move-request-1',
      actor: 'ui',
    });
    assert.equal(conflict.code, 'conflict');
    assert.equal(conflict.details.requestId, 'move-request-1');
  });

  it('rejects a stale revision and accepts the retry on the fresh one', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '并发' });
    const blockEnvelope = await harness.ok('createBlock', {
      date: DAY_ONE, start: '09:00', end: '10:00', taskId: task.id,
    });
    const block = blockEnvelope.value.block;
    await harness.ok('createTask', { title: '别处的新任务' });

    const stale = await harness.call('moveBlock', { id: block.id, date: DAY_TWO }, {
      expectedRevision: blockEnvelope.revision,
      requestId: 'stale-move',
      actor: 'ui',
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'conflict');
    assert.equal(stale.details.expectedRevision, blockEnvelope.revision);
    assert.ok(stale.details.revision > blockEnvelope.revision);
    assert.equal((await harness.ok('day', { date: DAY_ONE })).value.blocks[0].id, block.id, '过期提交不能落库');

    const retried = await harness.ok('moveBlock', { id: block.id, date: DAY_TWO }, {
      expectedRevision: stale.details.revision,
      requestId: 'retry-move',
      actor: 'ui',
    });
    assert.equal(retried.value.block.date, DAY_TWO);
  });
});

describe('overlap conflicts', () => {
  it('refuses an overlapping move until the overlap is explicitly kept', async t => {
    const harness = await boot(t);
    const first = await createBlock(harness, { date: DAY_ONE, start: '10:00', end: '11:00', title: 'A' });
    const second = await createBlock(harness, { date: DAY_TWO, start: '10:30', end: '11:30', title: 'B' });

    const blocked = await harness.fail('moveBlock', { id: first.id, date: DAY_TWO });
    assert.equal(blocked.code, 'conflict');
    assert.equal(blocked.details.reason, 'overlap');
    assert.equal(blocked.details.date, DAY_TWO);
    assert.deepEqual(blocked.details.conflicts.map(item => item.id), [second.id]);
    assert.equal(blocked.details.conflicts[0].start, '10:30');
    assert.equal(blocked.details.conflicts[0].end, '11:30');
    assert.match(blocked.message, /allowOverlap/);

    const unchanged = (await harness.ok('day', { date: DAY_TWO })).value;
    assert.deepEqual(unchanged.blocks.map(block => block.id), [second.id], '冲突未确认时不保存');

    const kept = await harness.ok('moveBlock', { id: first.id, date: DAY_TWO, allowOverlap: true });
    assert.equal(kept.value.moved, true);
    assert.equal(kept.value.block.date, DAY_TWO);

    const after = (await harness.ok('day', { date: DAY_TWO })).value;
    assert.deepEqual(after.blocks.map(block => block.id), [first.id, second.id]);
    const history = historyOf(harness, 'time_block', first.id);
    assert.deepEqual(history.map(row => row.action), ['create', 'move']);
  });

  it('detects overlaps on create and update as well, and only keeps them when asked', async t => {
    const harness = await boot(t);
    await createBlock(harness, { date: DAY_ONE, start: '09:00', end: '10:00', fixed: true, title: '高等数学课' });

    const conflictCreate = await harness.fail('createBlock', {
      date: DAY_ONE, start: '09:30', end: '10:30', title: '撞课',
    });
    assert.equal(conflictCreate.code, 'conflict');
    assert.equal(conflictCreate.details.reason, 'overlap');
    assert.equal(conflictCreate.details.conflicts[0].fixed, true);
    assert.equal((await harness.ok('day', { date: DAY_ONE })).value.blocks.length, 1);

    const kept = await harness.ok('createBlock', {
      date: DAY_ONE, start: '09:30', end: '10:30', title: '撞课但要保留', allowOverlap: true,
    });
    assert.equal(kept.value.block.title, '撞课但要保留');

    const conflictUpdate = await harness.fail('updateBlock', {
      id: kept.value.block.id, start: '08:30', end: '09:20',
    });
    assert.equal(conflictUpdate.code, 'conflict');
    assert.equal(conflictUpdate.details.reason, 'overlap');

    const moved = await harness.ok('updateBlock', {
      id: kept.value.block.id, start: '08:30', end: '09:20', allowOverlap: true,
    });
    assert.equal(moved.value.block.start, '08:30');
  });

  it('treats touching but non-overlapping ranges as free', async t => {
    const harness = await boot(t);
    await createBlock(harness, { date: DAY_ONE, start: '09:00', end: '10:00', title: 'A' });
    const touching = await harness.ok('createBlock', {
      date: DAY_ONE, start: '10:00', end: '11:00', title: 'B',
    });
    assert.equal(touching.value.block.start, '10:00');
    const before = await harness.ok('createBlock', {
      date: DAY_ONE, start: '08:00', end: '09:00', title: 'C',
    });
    assert.equal(before.value.block.start, '08:00');
  });
});
