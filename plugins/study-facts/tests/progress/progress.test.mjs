/**
 * T06 progress evidence: the five-state task machine, the independent
 * "pending confirmation" marker, quantities, the completion rule that keeps
 * cancelled tasks in the plan denominator, the unrecorded/not-started
 * distinction, duplicate-write suppression, append-only history, and
 * stale-revision retries.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { openStudyDatabase } from '../../../study-core/host/db.mjs';
import { boot, createBlock, createTask, historyOf } from './helpers.mjs';

const DAY_ONE = '2026-11-11';
const DAY_TWO = '2026-11-12';

/** The T05 table shapes, used to build a database that predates T06. */
const LEGACY_TASKS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS study_task (
    id                  TEXT PRIMARY KEY,
    title               TEXT NOT NULL,
    subject             TEXT,
    material_ref        TEXT,
    completion_criteria TEXT,
    estimated_minutes   INTEGER,
    prerequisites_json  TEXT NOT NULL DEFAULT '[]',
    deleted_at          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_task_active ON study_task (deleted_at, created_at)',
  `CREATE TABLE IF NOT EXISTS study_time_block (
    id           TEXT PRIMARY KEY,
    date         TEXT NOT NULL,
    start_minute INTEGER NOT NULL,
    end_minute   INTEGER NOT NULL,
    fixed        INTEGER NOT NULL DEFAULT 0,
    task_id      TEXT,
    title        TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    CHECK (start_minute >= 0 AND start_minute < 1440),
    CHECK (end_minute > start_minute AND end_minute <= 1440)
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_time_block_date ON study_time_block (date, start_minute)',
];

/**
 * Read the progress view of one task.
 * @param {{ ok: Function }} harness - Booted service fixture.
 * @param {string} taskId - Task id.
 * @returns {Promise<object>} Progress read result.
 */
async function readProgress(harness, taskId) {
  return (await harness.ok('progress', { taskId })).value;
}

describe('task progress state machine', () => {
  it('records every state and keeps the latest one', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '状态机' });

    const steps = [
      ['not_started', {}],
      ['in_progress', {}],
      ['partial', { quantityDone: 3, quantityTotal: 10, note: '做了 3 题' }],
      ['done', { quantityDone: 10, quantityTotal: 10 }],
      ['cancelled', { note: '先不做了' }],
    ];
    for (const [status, extra] of steps) {
      const envelope = await harness.ok('recordProgress', {
        taskId: task.id, status, date: DAY_ONE, ...extra,
      });
      assert.equal(envelope.value.created, true);
      assert.equal(envelope.value.record.status, status);
      assert.equal(envelope.value.record.taskId, task.id);
      assert.equal(envelope.value.record.date, DAY_ONE);
    }

    const latest = await readProgress(harness, task.id);
    assert.equal(latest.items.length, 1);
    assert.equal(latest.items[0].taskId, task.id);
    assert.equal(latest.items[0].progress.status, 'cancelled');
    assert.equal(latest.items[0].progress.quantityDone, null);
    assert.equal(latest.items[0].progress.note, '先不做了');
    assert.deepEqual(latest.unrecorded, []);
    assert.deepEqual(
      latest.records.map(record => record.status),
      ['not_started', 'in_progress', 'partial', 'done', 'cancelled'],
    );
    assert.equal(latest.records[2].quantityDone, 3);
    assert.equal(latest.records[2].quantityTotal, 10);
    assert.deepEqual(historyOf(harness, 'task_progress', task.id).map(row => row.action), [
      'not_started', 'in_progress', 'partial', 'done', 'cancelled',
    ]);
  });

  it('validates status, quantities, notes, dates, and task existence', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '校验' });

    const badStatus = await harness.fail('recordProgress', { taskId: task.id, status: 'finished' });
    assert.equal(badStatus.code, 'invalid');
    assert.equal(badStatus.details.field, 'status');
    assert.deepEqual(badStatus.details.allowed, ['not_started', 'in_progress', 'partial', 'done', 'cancelled']);

    const overTotal = await harness.fail('recordProgress', {
      taskId: task.id, status: 'partial', quantityDone: 11, quantityTotal: 10,
    });
    assert.equal(overTotal.code, 'invalid');
    assert.equal(overTotal.details.field, 'quantityDone');

    const doneBelowTotal = await harness.fail('recordProgress', {
      taskId: task.id, status: 'done', quantityDone: 9, quantityTotal: 10,
    });
    assert.equal(doneBelowTotal.code, 'invalid');
    assert.equal(doneBelowTotal.details.reason, 'quantity_below_total');

    const negative = await harness.fail('recordProgress', {
      taskId: task.id, status: 'partial', quantityDone: -1,
    });
    assert.equal(negative.code, 'invalid');
    assert.equal(negative.details.field, 'quantityDone');

    const longNote = await harness.fail('recordProgress', {
      taskId: task.id, status: 'in_progress', note: 'x'.repeat(501),
    });
    assert.equal(longNote.code, 'invalid');
    assert.equal(longNote.details.field, 'note');

    const badDate = await harness.fail('recordProgress', {
      taskId: task.id, status: 'in_progress', date: '2026-13-01',
    });
    assert.equal(badDate.code, 'invalid');
    assert.equal(badDate.details.field, 'date');

    const missing = await harness.fail('recordProgress', {
      taskId: 'task_missing', status: 'in_progress',
    });
    assert.equal(missing.code, 'not_found');
    assert.equal(missing.details.taskId, 'task_missing');

    await harness.ok('deleteTask', { id: task.id });
    const deleted = await harness.fail('recordProgress', { taskId: task.id, status: 'done' });
    assert.equal(deleted.code, 'not_found');
  });
});

describe('pending confirmation and completion', () => {
  it('keeps "pending confirmation" separate from both complete and incomplete', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '待确认' });

    const proposed = await harness.ok('recordProgress', {
      taskId: task.id, status: 'done', quantityDone: 10, quantityTotal: 10, confirmed: false,
    });
    assert.equal(proposed.value.record.confirmed, false);
    assert.equal(proposed.value.completion.taskCount, 1);
    assert.equal(proposed.value.completion.counts.pendingConfirmation, 1);
    assert.equal(proposed.value.completion.counts.done, 1);
    assert.equal(proposed.value.completion.completion.completedTasks, 0, '待确认不能算完成');
    assert.equal(proposed.value.completion.completion.pendingTasks, 1);
    assert.equal(proposed.value.completion.completion.rate, 0);

    const confirmed = await harness.ok('recordProgress', {
      taskId: task.id, status: 'done', quantityDone: 10, quantityTotal: 10, confirmed: true,
    });
    assert.equal(confirmed.value.created, true);
    assert.equal(confirmed.value.completion.counts.pendingConfirmation, 0);
    assert.equal(confirmed.value.completion.completion.completedTasks, 1);
    assert.equal(confirmed.value.completion.completion.rate, 1);

    const latest = await readProgress(harness, task.id);
    assert.equal(latest.items[0].progress.confirmed, true);
    assert.equal(latest.records.length, 2);
  });

  it('keeps cancelled tasks in the plan denominator and does not call unrecorded "not started"', async t => {
    const harness = await boot(t);
    const done = await createTask(harness, { title: '完成' });
    const cancelled = await createTask(harness, { title: '取消' });
    const partial = await createTask(harness, { title: '部分' });
    const unrecorded = await createTask(harness, { title: '没记录' });

    await harness.ok('recordProgress', { taskId: done.id, status: 'done', confirmed: true });
    await harness.ok('recordProgress', { taskId: cancelled.id, status: 'cancelled', note: '不做了' });
    await harness.ok('recordProgress', { taskId: partial.id, status: 'partial', quantityDone: 2, quantityTotal: 8 });

    const read = (await harness.ok('progress', {})).value;
    assert.equal(read.items.length, 4);
    const unrecordedItem = read.items.find(item => item.taskId === unrecorded.id);
    assert.equal(unrecordedItem.progress, null, '未勾选不能推断成未开始');
    assert.deepEqual(read.unrecorded, [unrecorded.id]);
    assert.equal(read.completion.counts.notStarted, 0);
    assert.equal(read.completion.counts.unrecorded, 1);
    assert.equal(read.completion.counts.cancelled, 1);
    assert.deepEqual(read.completion.completion, {
      countedTasks: 4,
      plannedTasks: 4,
      completedTasks: 1,
      cancelledTasks: 1,
      pendingTasks: 0,
      unrecordedTasks: 1,
      rate: 0.25,
    });

    const allCancelled = await boot(t);
    const task = await createTask(allCancelled, { title: '只有取消' });
    await allCancelled.ok('recordProgress', { taskId: task.id, status: 'cancelled' });
    const empty = (await allCancelled.ok('progress', {})).value;
    assert.equal(empty.completion.completion.countedTasks, 1);
    assert.equal(empty.completion.completion.plannedTasks, 1);
    assert.equal(empty.completion.completion.rate, 0, '取消的任务留在分母，完成率是 0 而不是抬高的 100% 或伪造的 null');
    const noTasks = await boot(t);
    assert.equal((await noTasks.ok('progress', {})).value.completion.completion.rate, null, '没有任务时不伪造完成率');
  });

  it('does not append a second identical record', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '重复点击' });
    const payload = { taskId: task.id, status: 'in_progress', note: '开始' };

    const first = await harness.ok('recordProgress', payload);
    const second = await harness.ok('recordProgress', payload);
    assert.equal(first.value.created, true);
    assert.equal(second.value.created, false);
    assert.equal(second.value.record.recordId, first.value.record.recordId);
    assert.equal(historyOf(harness, 'task_progress', task.id).length, 1);
    assert.equal((await readProgress(harness, task.id)).records.length, 1);

    const changedNote = await harness.ok('recordProgress', { ...payload, note: '换一条文字反馈' });
    assert.equal(changedNote.value.created, true);
    assert.equal((await readProgress(harness, task.id)).records.length, 2);
  });
});

describe('progress history and concurrency', () => {
  it('adds the progress table to a database created before T06', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'study-progress-legacy-'));
    let harness;
    try {
      const legacy = { id: 'tasks', deps: [], schema: LEGACY_TASKS_SCHEMA, schemaVersion: 1 };
      const database = await openStudyDatabase({ file: join(directory, 'study.db') });
      database.verifyModules([legacy]);
      await database.applyModuleSchemas([legacy]);
      assert.equal(
        database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'study_task_progress'"),
        undefined,
        '测试前置：旧库还没有进度表',
      );
      database.close();

      harness = await boot(t, { directory });
      const task = await createTask(harness, { title: '旧库升级' });
      const recorded = await harness.ok('recordProgress', { taskId: task.id, status: 'in_progress' });
      assert.equal(recorded.value.created, true);
      assert.equal(recorded.value.record.status, 'in_progress');
      assert.equal(
        (await harness.ok('progress', { taskId: task.id })).value.records.length,
        1,
      );
      await harness.fiber.dispose();
    } finally {
      try { await harness?.fiber.dispose(); } catch { /* Already disposed. */ }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('keeps progress append-only and reads it back after a restart', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'study-progress-restart-'));
    let first;
    let second;
    try {
      first = await boot(t, { directory });
      const task = await createTask(first, { title: '重启后' });
      await first.ok('recordProgress', {
        taskId: task.id, status: 'partial', quantityDone: 4, quantityTotal: 10, note: '一半',
      });
      await first.fiber.dispose();

      const db = new DatabaseSync(join(directory, 'study.db'));
      try {
        assert.throws(
          () => db.prepare("UPDATE study_task_progress SET status = 'done'").run(),
          /append-only/,
        );
        assert.throws(() => db.prepare('DELETE FROM study_task_progress').run(), /append-only/);
      } finally {
        db.close();
      }

      second = await boot(t, { directory });
      const latest = await readProgress(second, task.id);
      assert.equal(latest.items[0].progress.status, 'partial');
      assert.equal(latest.items[0].progress.quantityDone, 4);
      assert.equal(latest.items[0].progress.note, '一半');
      assert.equal(latest.records.length, 1);
    } finally {
      try { await first?.fiber.dispose(); } catch { /* Already disposed. */ }
      try { await second?.fiber.dispose(); } catch { /* Already disposed. */ }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects a stale revision and appends the retry on the fresh one', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '进度并发' });
    const first = await harness.ok('recordProgress', {
      taskId: task.id, status: 'in_progress',
    }, { requestId: 'progress-1', actor: 'ui' });
    assert.equal(first.revision, 2);

    await harness.ok('createTask', { title: '别处的新任务' });

    const stale = await harness.call('recordProgress', {
      taskId: task.id, status: 'done', confirmed: true,
    }, { expectedRevision: first.revision, requestId: 'progress-stale', actor: 'ui' });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'conflict');
    assert.equal(stale.details.expectedRevision, first.revision);
    assert.equal(stale.details.revision, 3);
    assert.equal((await readProgress(harness, task.id)).records.length, 1, '过期提交不能落库');

    const retried = await harness.ok('recordProgress', {
      taskId: task.id, status: 'done', confirmed: true,
    }, { expectedRevision: stale.details.revision, requestId: 'progress-retry', actor: 'ui' });
    assert.equal(retried.value.created, true);
    assert.equal(retried.value.record.status, 'done');
    assert.equal((await readProgress(harness, task.id)).records.length, 2);
  });

  it('includes latest progress and the completion summary in day and week views', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { title: '带上进度' });
    const idle = await createTask(harness, { title: '还没记录' });
    await createBlock(harness, { date: DAY_ONE, start: '09:00', end: '10:00', taskId: task.id });
    await harness.ok('recordProgress', { taskId: task.id, status: 'done', date: DAY_ONE });

    const day = (await harness.ok('day', { date: DAY_ONE })).value;
    assert.equal(day.progress[task.id].status, 'done');
    assert.equal(day.progress[idle.id], undefined);
    assert.equal(day.completion.counts.done, 1);
    assert.equal(day.completion.counts.unrecorded, 1);
    assert.equal(day.completion.completion.completedTasks, 1);
    assert.equal('progress' in day.tasks[0], false, '任务视图不能因进度改变字段形状');

    const week = (await harness.ok('week', { date: DAY_TWO })).value;
    assert.equal(week.progress[task.id].status, 'done');
    assert.equal(week.completion.taskCount, 2);
  });
});
