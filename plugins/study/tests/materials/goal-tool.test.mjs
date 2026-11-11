/**
 * `study_goal` tool: the agent reads the active goal, fills gaps in the
 * conversation, and updates one field without erasing the others.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boot } from './helpers.mjs';

const tool = (h, args, exec) => h.toolNamed('study_goal', args, exec);

describe('study_goal tool', () => {
  it('reads an empty active goal without failing', async t => {
    const h = await boot(t);
    const value = await tool(h, { action: 'get' });
    assert.deepEqual(value, { goal: null });
    assert.deepEqual(await tool(h, { action: 'list' }), { goals: [] });
  });

  it('creates the goal and reports the fields still missing', async t => {
    const h = await boot(t);
    const { goal, created } = await tool(h, { action: 'save', exam: '2027 考研数学一' });
    assert.equal(created, true);
    assert.equal(goal.exam, '2027 考研数学一');
    assert.equal(goal.active, true);
    assert.deepEqual(goal.missing, ['examYear', 'deadline', 'dailyMinutes']);
    assert.deepEqual((await tool(h, { action: 'get' })).goal.id, goal.id);
  });

  it('updates one field and keeps every other field', async t => {
    const h = await boot(t);
    const { goal } = await tool(h, {
      action: 'save',
      exam: '英语四级',
      examYear: 2027,
      deadline: '2027-06-12',
      dailyMinutes: 90,
      note: '每天背单词',
    });
    const updated = await tool(h, { action: 'save', id: goal.id, dailyMinutes: 120 });
    assert.equal(updated.goal.id, goal.id);
    assert.equal(updated.goal.exam, '英语四级');
    assert.equal(updated.goal.examYear, 2027);
    assert.equal(updated.goal.deadline, '2027-06-12');
    assert.equal(updated.goal.dailyMinutes, 120);
    assert.equal(updated.goal.note, '每天背单词');
    assert.equal(updated.created, false);
    assert.deepEqual(updated.goal.missing, []);
  });

  it('keeps workspace links that the tool never mentions', async t => {
    const h = await boot(t);
    const saved = await h.ok('saveGoal', { exam: '考研数学', workspaceIds: ['ws_1', 'ws_2'] });
    const goal = saved.goal;
    assert.deepEqual(goal.workspaceIds, ['ws_1', 'ws_2']);
    const updated = await tool(h, { action: 'save', id: goal.id, note: '改为晚上学' });
    assert.deepEqual(updated.goal.workspaceIds, ['ws_1', 'ws_2']);
  });

  it('switches the active goal and leaves the other one inactive', async t => {
    const h = await boot(t);
    const first = (await tool(h, { action: 'save', exam: '考研数学' })).goal;
    const second = (await tool(h, { action: 'save', exam: '英语四级' })).goal;
    assert.equal(second.active, true);
    const goals = (await tool(h, { action: 'list' })).goals;
    assert.deepEqual(goals.map(goal => goal.id), [first.id, second.id]);
    assert.deepEqual(goals.map(goal => goal.active), [false, true]);
    const back = await tool(h, { action: 'save', id: first.id, exam: '考研数学', active: true });
    assert.equal(back.goal.active, true);
    assert.equal((await tool(h, { action: 'get' })).goal.id, first.id);
  });

  it('replays one call identity instead of creating a second goal', async t => {
    const h = await boot(t);
    const callId = 'goal-call-once';
    const first = await tool(h, { action: 'save', exam: '考研数学' }, { callId });
    const replay = await tool(h, { action: 'save', exam: '考研数学' }, { callId });
    assert.equal(replay.goal.id, first.goal.id);
    assert.equal((await tool(h, { action: 'list' })).goals.length, 1);
  });

  it('explains a missing exam and an unknown goal id', async t => {
    const h = await boot(t);
    await assert.rejects(
      () => tool(h, { action: 'save', dailyMinutes: 60 }),
      /需要 exam/,
    );
    await assert.rejects(
      () => tool(h, { action: 'save', id: 'goal_missing', exam: '考研数学' }),
      /读取要更新的目标失败/,
    );
    await assert.rejects(
      () => tool(h, { action: 'get', id: 'goal_missing' }),
      /读取备考目标失败/,
    );
  });
});
