import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { boot } from './helpers.mjs';

test('a goal keeps what the student stated and names what is still missing', async t => {
  const { ok, call } = await boot(t);

  const created = await ok('saveGoal', { exam: '考研数学一' });
  assert.equal(created.created, true);
  assert.equal(created.goal.exam, '考研数学一');
  assert.equal(created.goal.examYear, null);
  assert.equal(created.goal.deadline, null);
  assert.equal(created.goal.dailyMinutes, null);
  assert.equal(created.goal.active, true);
  assert.deepEqual(created.goal.missing, ['examYear', 'deadline', 'dailyMinutes']);

  const read = await ok('getGoal', {});
  assert.deepEqual(read.goal, created.goal);

  const update = await call('saveGoal', { id: created.goal.id, exam: '考研数学一', examYear: 2027, deadline: '2026-12-20', dailyMinutes: 180 });
  assert.equal(update.ok, true);
  assert.equal(update.value.created, false);
  assert.deepEqual(update.value.goal.missing, []);
  assert.equal(update.value.goal.examYear, 2027);
  assert.equal(update.value.goal.deadline, '2026-12-20');
  assert.equal(update.value.goal.dailyMinutes, 180);
  assert.equal(update.value.goal.createdAt, created.goal.createdAt);
  assert.equal(update.revision, 2);
});

test('a goal links several DSH workspaces and keeps the selection across edits', async t => {
  const { ok, call } = await boot(t);

  const created = await ok('saveGoal', {
    exam: '考研数学一',
    workspaceIds: ['ws_math', 'ws_english', 'ws_math'],
  });
  assert.deepEqual(created.goal.workspaceIds, ['ws_math', 'ws_english']);
  assert.deepEqual((await ok('getGoal', {})).goal.workspaceIds, ['ws_math', 'ws_english']);
  assert.deepEqual((await ok('listGoals', {})).goals[0].workspaceIds, ['ws_math', 'ws_english']);

  const renamed = await ok('saveGoal', { id: created.goal.id, exam: '考研数学一（强化）' });
  assert.deepEqual(renamed.goal.workspaceIds, ['ws_math', 'ws_english'], 'omitting workspaceIds must leave existing links untouched');

  const replaced = await ok('saveGoal', {
    id: created.goal.id,
    exam: '考研数学一（强化）',
    workspaceIds: ['ws_notes'],
  });
  assert.deepEqual(replaced.goal.workspaceIds, ['ws_notes']);

  const cleared = await call('saveGoal', {
    id: created.goal.id,
    exam: '考研数学一（强化）',
    workspaceIds: [],
  });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.value.goal.workspaceIds, []);
});

test('workspace ids are validated before any goal write', async t => {
  const { fail, ok } = await boot(t);

  const cases = [
    [{ exam: '考研数学一', workspaceIds: 'ws_math' }, 'workspaceIds'],
    [{ exam: '考研数学一', workspaceIds: ['ws_math', 2] }, 'workspaceIds'],
    [{ exam: '考研数学一', workspaceIds: Array.from({ length: 33 }, (_, index) => `ws_${index}`) }, 'workspaceIds'],
  ];
  for (const [payload, field] of cases) {
    const result = await fail('saveGoal', payload);
    assert.equal(result.code, 'invalid', JSON.stringify(payload));
    assert.equal(result.details.field, field, JSON.stringify(payload));
  }
  assert.deepEqual((await ok('listGoals', {})).goals, []);
});

test('only one goal is active, and listing shows the others', async t => {
  const { ok } = await boot(t);

  const first = await ok('saveGoal', { exam: '高考数学', examYear: 2027 });
  const second = await ok('saveGoal', { exam: '英语四级', active: true });
  assert.equal(second.goal.active, true);

  const active = await ok('getGoal', {});
  assert.equal(active.goal.id, second.goal.id);

  const all = await ok('listGoals', {});
  assert.equal(all.goals.length, 2);
  assert.deepEqual(all.goals.map(goal => [goal.exam, goal.active]), [['高考数学', false], ['英语四级', true]]);

  const reactivated = await ok('saveGoal', { id: first.goal.id, exam: '高考数学', examYear: 2027, active: true });
  assert.equal(reactivated.created, false);
  assert.equal((await ok('getGoal', {})).goal.id, first.goal.id);
});

test('an unknown goal id is not silently created', async t => {
  const harness = await boot(t);
  assert.deepEqual((await harness.ok('getGoal', {})).goal, null);

  const save = await harness.fail('saveGoal', { id: 'goal_missing', exam: '考研数学一' });
  assert.equal(save.code, 'not_found');
  assert.equal(save.details.goalId, 'goal_missing');

  const read = await harness.fail('getGoal', { id: 'goal_missing' });
  assert.equal(read.code, 'not_found');
  assert.equal(read.details.goalId, 'goal_missing');
});

test('goal fields are validated before anything is stored', async t => {
  const { fail, ok } = await boot(t);

  const cases = [
    [{ exam: '' }, 'exam'],
    [{ exam: '   ' }, 'exam'],
    [{ exam: '考研数学一', examYear: 1800 }, 'examYear'],
    [{ exam: '考研数学一', examYear: 2026.5 }, 'examYear'],
    [{ exam: '考研数学一', deadline: '2026-02-30' }, 'deadline'],
    [{ exam: '考研数学一', deadline: '2026/12/20' }, 'deadline'],
    [{ exam: '考研数学一', dailyMinutes: -30 }, 'dailyMinutes'],
    [{ exam: '考研数学一', dailyMinutes: 2000 }, 'dailyMinutes'],
  ];
  for (const [payload, field] of cases) {
    const result = await fail('saveGoal', payload);
    assert.equal(result.code, 'invalid', JSON.stringify(payload));
    assert.equal(result.details.field, field, JSON.stringify(payload));
  }
  assert.deepEqual((await ok('listGoals', {})).goals, []);
});

test('a repeated requestId replays the first goal write and conflicts on new content', async t => {
  const { call } = await boot(t);

  const first = await call('saveGoal', { exam: '考研数学一' }, { requestId: 'goal-once', actor: 'ui' });
  assert.equal(first.ok, true);
  const replay = await call('saveGoal', { exam: '考研数学一' }, { requestId: 'goal-once', actor: 'ui' });
  assert.deepEqual(replay, first);

  const conflict = await call('saveGoal', { exam: '英语四级' }, { requestId: 'goal-once', actor: 'ui' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');
});

test('the goal-workspace table is added to a database created before the feature', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-goal-workspace-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  const first = await boot(t, { directory });
  await first.ok('saveGoal', { exam: '升级前目标' });
  await first.fiber.dispose();

  const database = new DatabaseSync(join(directory, 'study.db'));
  database.exec('DROP TABLE study_goal_workspace');
  database.close();

  const second = await boot(t, { directory });
  const saved = await second.ok('saveGoal', { exam: '升级前目标', workspaceIds: ['ws_after_upgrade'] });
  assert.deepEqual(saved.goal.workspaceIds, ['ws_after_upgrade']);
  assert.deepEqual((await second.ok('getGoal', {})).goal.workspaceIds, ['ws_after_upgrade']);
  await second.fiber.dispose();
});
