/**
 * Task CRUD through the real study service: every field the workbench form
 * writes, the stable task identity, prerequisite integrity, idempotent
 * retries, and a restart read-back.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { boot } from './helpers.mjs';

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

describe('task CRUD', () => {
  it('creates a task with every workbench field and reads it back unchanged', async t => {
    const harness = await boot(t);
    const created = await harness.ok('createTask', {
      title: '数学分析 第3章 习题',
      subject: '数学',
      materialRef: '数学分析 第三版 第3章 第2节',
      completionCriteria: '做完 1-20 题并订正错题',
      estimatedMinutes: 90,
    });

    assert.equal(created.revision, 1);
    assert.match(created.value.task.id, /^task_[0-9a-f-]{36}$/);
    assert.deepEqual(created.value.task, {
      goalId: 'unassigned', materialId: null, planItem: null,
      scheduledDate: null, projectId: null, projectTitle: null,
      id: created.value.task.id,
      title: '数学分析 第3章 习题',
      subject: '数学',
      materialRef: '数学分析 第三版 第3章 第2节',
      completionCriteria: '做完 1-20 题并订正错题',
      estimatedMinutes: 90,
      prerequisiteIds: [],
      prerequisites: [],
      deletedAt: null,
      createdAt: created.value.task.createdAt,
      updatedAt: created.value.task.updatedAt,
    });

    const read = await harness.ok('getTask', { id: created.value.task.id });
    assert.deepEqual(read.value.task, created.value.task);

    const list = await harness.ok('listTasks', {});
    assert.deepEqual(list.value.tasks, [created.value.task]);
  });

  it('updates fields while the task id stays the same', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '初稿', subject: '数学', estimatedMinutes: 30 });

    const updated = await harness.ok('updateTask', {
      id: task.id,
      title: '数学分析 第3章 习题',
      subject: '数学分析',
      estimatedMinutes: 120,
    });
    assert.equal(updated.value.task.id, task.id);
    assert.equal(updated.value.task.title, '数学分析 第3章 习题');
    assert.equal(updated.value.task.subject, '数学分析');
    assert.equal(updated.value.task.estimatedMinutes, 120);
    assert.equal(updated.value.task.createdAt, task.createdAt);

    const cleared = await harness.ok('updateTask', { id: task.id, subject: null, estimatedMinutes: null });
    assert.equal(cleared.value.task.subject, null);
    assert.equal(cleared.value.task.estimatedMinutes, null);
    assert.equal(cleared.value.task.id, task.id);
  });

  it('rejects malformed task fields with a field name', async t => {
    const harness = await boot(t);

    const missingTitle = await harness.fail('createTask', { subject: '数学' });
    assert.equal(missingTitle.code, 'invalid');
    assert.equal(missingTitle.details.field, 'title');

    const negative = await harness.fail('createTask', { title: 'A', estimatedMinutes: -1 });
    assert.equal(negative.code, 'invalid');
    assert.equal(negative.details.field, 'estimatedMinutes');

    const fractional = await harness.fail('createTask', { title: 'A', estimatedMinutes: 1.5 });
    assert.equal(fractional.code, 'invalid');

    const badSubject = await harness.fail('createTask', { title: 'A', subject: 42 });
    assert.equal(badSubject.code, 'invalid');

    const badPrerequisites = await harness.fail('createTask', { title: 'A', prerequisites: 'task_x' });
    assert.equal(badPrerequisites.code, 'invalid');
    assert.equal(badPrerequisites.details.field, 'prerequisites');

    const missingUpdate = await harness.fail('updateTask', { id: 'task_missing', title: 'A' });
    assert.equal(missingUpdate.code, 'not_found');
  });

  it('deletes a task and stops listing it, without losing its id', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '要删除的任务' });

    const deleted = await harness.ok('deleteTask', { id: task.id });
    assert.equal(deleted.value.task.id, task.id);
    assert.ok(deleted.value.task.deletedAt);

    const list = await harness.ok('listTasks', {});
    assert.deepEqual(list.value.tasks, []);

    const withDeleted = await harness.ok('listTasks', { includeDeleted: true });
    assert.equal(withDeleted.value.tasks.length, 1);
    assert.equal(withDeleted.value.tasks[0].id, task.id);
    assert.ok(withDeleted.value.tasks[0].deletedAt);

    const again = await harness.fail('deleteTask', { id: task.id });
    assert.equal(again.code, 'not_found');
  });
});

describe('task prerequisites', () => {
  it('stores prerequisite ids and resolves their titles', async t => {
    const harness = await boot(t);
    const first = await createTask(harness, { title: '第一章' });
    const second = await createTask(harness, { title: '第二章', prerequisites: [first.id] });

    assert.deepEqual(second.prerequisiteIds, [first.id]);
    assert.deepEqual(second.prerequisites, [{ id: first.id, title: '第一章', deleted: false }]);

    const read = await harness.ok('getTask', { id: second.id });
    assert.deepEqual(read.value.task.prerequisites, second.prerequisites);
  });

  it('rejects unknown, self, duplicate, and cyclic prerequisites', async t => {
    const harness = await boot(t);
    const first = await createTask(harness, { title: 'A' });
    const second = await createTask(harness, { title: 'B', prerequisites: [first.id] });

    const unknown = await harness.fail('createTask', { title: 'C', prerequisites: ['task_missing'] });
    assert.equal(unknown.code, 'not_found');
    assert.equal(unknown.details.taskId, 'task_missing');

    const self = await harness.fail('updateTask', { id: first.id, prerequisites: [first.id] });
    assert.equal(self.code, 'invalid');
    assert.equal(self.details.reason, 'dependency_cycle');

    const duplicate = await harness.fail('createTask', { title: 'D', prerequisites: [first.id, first.id] });
    assert.equal(duplicate.code, 'invalid');
    assert.equal(duplicate.details.field, 'prerequisites');

    const cycle = await harness.fail('updateTask', { id: first.id, prerequisites: [second.id] });
    assert.equal(cycle.code, 'invalid');
    assert.equal(cycle.details.reason, 'dependency_cycle');
  });

  it('refuses to delete a prerequisite that active tasks still use', async t => {
    const harness = await boot(t);
    const first = await createTask(harness, { title: 'A' });
    const second = await createTask(harness, { title: 'B', prerequisites: [first.id] });

    const blocked = await harness.fail('deleteTask', { id: first.id });
    assert.equal(blocked.code, 'conflict');
    assert.deepEqual(blocked.details.dependents, [{ id: second.id, title: 'B' }]);

    await harness.ok('deleteTask', { id: second.id });
    const removed = await harness.ok('deleteTask', { id: first.id });
    assert.equal(removed.value.task.id, first.id);

    const withDeleted = await harness.fail('createTask', { title: 'C', prerequisites: [first.id] });
    assert.equal(withDeleted.code, 'not_found');
  });
});

describe('task idempotency and persistence', () => {
  it('applies one create per requestId and rejects reusing it for other content', async t => {
    const harness = await boot(t);
    const first = await harness.ok('createTask', { title: '只创建一次' }, { requestId: 'task-request-1', actor: 'ui' });
    const replay = await harness.ok('createTask', { title: '只创建一次' }, { requestId: 'task-request-1', actor: 'ui' });

    assert.equal(replay.value.task.id, first.value.task.id);
    assert.equal(replay.revision, first.revision);

    const list = await harness.ok('listTasks', {});
    assert.equal(list.value.tasks.length, 1);

    const conflict = await harness.fail('createTask', { title: '另一个任务' }, { requestId: 'task-request-1', actor: 'ui' });
    assert.equal(conflict.code, 'conflict');
  });

  it('reads tasks and their time blocks back after a restart', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'study-tasks-restart-'));
    let first;
    let second;
    try {
      first = await boot(t, { directory });
      const task = await createTask(first, { title: '重启后还在', subject: '英语', estimatedMinutes: 45 });
      const block = await first.ok('createBlock', {
        date: '2026-11-12',
        start: '09:00',
        end: '09:45',
        taskId: task.id,
      });
      const moved = await first.ok('updateBlock', {
        id: block.value.block.id,
        date: '2026-11-13',
        start: '10:15',
        end: '11:05',
      });
      assert.equal(moved.value.block.id, block.value.block.id);
      await first.fiber.dispose();

      second = await boot(t, { directory });
      const read = await second.ok('getTask', { id: task.id });
      assert.equal(read.value.task.id, task.id);
      assert.equal(read.value.task.title, '重启后还在');
      assert.equal(read.value.task.subject, '英语');

      const oldDay = await second.ok('day', { date: '2026-11-12' });
      assert.deepEqual(oldDay.value.blocks, []);

      const day = await second.ok('day', { date: '2026-11-13' });
      assert.equal(day.value.blocks.length, 1);
      assert.equal(day.value.blocks[0].id, block.value.block.id);
      assert.equal(day.value.blocks[0].taskId, task.id);
      assert.equal(day.value.blocks[0].start, '10:15');
      assert.equal(day.value.blocks[0].end, '11:05');
      assert.equal(day.value.blocks[0].minutes, 50);
      assert.equal(day.value.tasks[0].id, task.id);
    } finally {
      // Both fibers must release the SQLite handle before the directory goes away.
      try { await first?.fiber.dispose(); } catch { /* Already disposed. */ }
      try { await second?.fiber.dispose(); } catch { /* Already disposed. */ }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
