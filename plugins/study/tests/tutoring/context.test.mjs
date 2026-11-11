import { randomUUID } from 'node:crypto';
/**
 * T11 tutoring context: task ↔ session association, the injected context
 * message, deduplication, refresh, restart persistence, and isolation from
 * free chat.
 *
 * The plugin is booted through `host/index.mjs`, so these tests exercise module
 * discovery, the real service contract, and the real `tasks`, `materials` and
 * `plans` services the brief reads.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { boot, createMaterial, createPlan, createTask, dateAfter, readRows } from './helpers.mjs';

/** One injected context message's text. */
function textOf(message) {
  return message.content.map(part => part.text ?? '').join('');
}

describe('tutoring context injection', () => {
  it('registers only the tutoring routes on the authenticated study route table', async t => {
    const harness = await boot(t);
    const paths = harness.routes.map(route => route.path).filter(path => path.startsWith('/api/study/tutoring/')).sort();
    assert.deepEqual(paths, [
      '/api/study/tutoring/brief',
      '/api/study/tutoring/close',
      '/api/study/tutoring/context',
      '/api/study/tutoring/flush',
      '/api/study/tutoring/open',
    ]);
  });

  it('injects the task, material snippets and the latest plan once when opened', async t => {
    const harness = await boot(t);
    const material = await createMaterial(harness);
    const task = await createTask(harness, { materialRef: material.id });
    await createPlan(harness);
    const agent = harness.agents.add('sess-1');

    const value = await harness.ok('open', { taskId: task.id, sessionId: 'sess-1' }, { actor: 'ui' });

    assert.equal(value.status, 'injected');
    assert.equal(value.injected, true);
    assert.equal(value.sessionId, 'sess-1');
    assert.equal(value.task.id, task.id);
    assert.equal(value.sourceKind, 'study-tutoring');
    assert.equal(agent.messages.length, 1);

    const message = agent.messages[0];
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, 'study-tutoring');
    assert.equal(message.source.taskId, task.id);
    assert.match(message.source.digest, /^[a-f0-9]{64}$/);
    const text = textOf(message);
    assert.match(text, /第二章 导数习题/);
    assert.match(text, /做完 1-10 题并订正错题/);
    assert.match(text, /数学练习册/);
    assert.match(text, /第一题：求 x\^2 的导数/);
    assert.match(text, /最新计划「冒烟学习计划」修订 1/);
    assert.match(text, /19:00–19:30/);
    assert.match(text, /不是聊天副本/);
    assert.doesNotMatch(text, /chat-only-secret/);

    const link = harness.link('sess-1');
    assert.equal(link.task_id, task.id);
    assert.equal(link.digest, message.source.digest);
    assert.notEqual(link.injected_at, null);
    assert.equal(harness.changes('tutoring_link').length, 1);
    assert.equal(harness.changes('tutoring_link')[0].action, 'inject');
    assert.equal(harness.changes('tutoring_link')[0].actor, 'ui');
  });

  it('does not inject again when the same task is asked twice', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const agent = harness.agents.add('sess-repeat');

    await harness.ok('open', { taskId: task.id, sessionId: 'sess-repeat' });
    const second = await harness.ok('open', { taskId: task.id, sessionId: 'sess-repeat' });
    const third = await harness.ok('open', { taskId: task.id, sessionId: 'sess-repeat' });

    assert.equal(second.status, 'already_injected');
    assert.equal(second.injected, false);
    assert.equal(third.status, 'already_injected');
    assert.equal(agent.messages.length, 1);
    assert.equal(harness.changes('tutoring_link').length, 1);
  });

  it('replays the first result for the same requestId and rejects a different payload', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const agent = harness.agents.add('sess-request');
    const options = { requestId: 'tutoring-open-1' };

    const first = await harness.ok('open', { taskId: task.id, sessionId: 'sess-request' }, options);
    const replay = await harness.ok('open', { taskId: task.id, sessionId: 'sess-request' }, options);
    assert.deepEqual(replay, first);
    assert.equal(agent.messages.length, 1);

    const conflict = await harness.fail('open', { taskId: task.id, sessionId: 'sess-other' }, options);
    assert.equal(conflict.code, 'conflict');
    assert.equal(agent.messages.length, 1);
  });

  it('keeps a pending link for an unloaded session and flushes it once the session is live', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);

    const pending = await harness.ok('open', { taskId: task.id, sessionId: 'sess-pending' });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.injected, false);
    assert.equal(harness.link('sess-pending').injected_at, null);
    assert.deepEqual(harness.changes('tutoring_link').map(row => row.action), ['link']);

    const agent = harness.agents.add('sess-pending');
    const flushed = await harness.ok('flush', { sessionId: 'sess-pending' });
    assert.equal(flushed.status, 'injected');
    assert.equal(agent.messages.length, 1);
    assert.notEqual(harness.link('sess-pending').injected_at, null);
    assert.deepEqual(harness.changes('tutoring_link').map(row => row.action), ['link', 'inject']);

    const again = await harness.ok('flush', { sessionId: 'sess-pending' });
    assert.equal(again.status, 'already_injected');
    assert.equal(agent.messages.length, 1);
  });

  it('flushes a pending link when the Agent is created after the link', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);

    await harness.ok('open', { taskId: task.id, sessionId: 'sess-created-later' });
    assert.equal(harness.link('sess-created-later').injected_at, null);

    const agent = harness.agents.add('sess-created-later');
    harness.ctx.emit('agent/created', { agent, source: 'resume' });
    assert.equal(await harness.waitFor(() => agent.messages.length === 1), true);
    assert.notEqual(harness.link('sess-created-later').injected_at, null);
    assert.deepEqual(harness.changes('tutoring_link').map(row => row.action), ['link', 'inject']);
  });

  it('leaves free chat and unlinked sessions untouched', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const freeAgent = harness.agents.add('sess-free');

    const context = await harness.ok('context', { sessionId: 'sess-free' });
    assert.equal(context.status, 'no_link');
    assert.equal(context.task, null);
    const flushed = await harness.ok('flush', { sessionId: 'sess-free' });
    assert.equal(flushed.status, 'no_link');
    const brief = await harness.ok('brief', { taskId: task.id });
    assert.equal(brief.task.id, task.id);
    assert.equal(freeAgent.messages.length, 0);
    assert.equal(harness.link('sess-free'), undefined);

    // A linked session does not affect a different free conversation.
    harness.agents.add('sess-linked');
    await harness.ok('open', { taskId: task.id, sessionId: 'sess-linked' });
    assert.equal(freeAgent.messages.length, 0);
  });

  it('switches the task of one session and injects the new task', async t => {
    const harness = await boot(t);
    const first = await createTask(harness, { title: '第二章 导数习题' });
    const second = await createTask(harness, { title: '第三章 积分习题' });
    const agent = harness.agents.add('sess-switch');

    await harness.ok('open', { taskId: first.id, sessionId: 'sess-switch' });
    const switched = await harness.ok('open', { taskId: second.id, sessionId: 'sess-switch' });

    assert.equal(switched.status, 'injected');
    assert.equal(switched.changedTask, true);
    assert.equal(switched.previousTaskId, first.id);
    assert.equal(harness.link('sess-switch').task_id, second.id);
    assert.equal(agent.messages.length, 2);
    assert.match(textOf(agent.messages[1]), /第三章 积分习题/);
  });

  it('reports a stale brief and re-injects only when refresh is explicit', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const agent = harness.agents.add('sess-refresh');

    await harness.ok('open', { taskId: task.id, sessionId: 'sess-refresh' });
    const updated = await harness.ctx.study.call('tasks', 'updateTask', {
      id: task.id,
      title: '第二章 导数习题（修订）',
      completionCriteria: '做完 1-20 题',
    }, {requestId:randomUUID()});
    assert.equal(updated.ok, true);

    const stale = await harness.ok('open', { taskId: task.id, sessionId: 'sess-refresh' });
    assert.equal(stale.status, 'stale');
    assert.equal(stale.injected, false);
    assert.notEqual(stale.digest, harness.link('sess-refresh').digest);
    assert.equal(agent.messages.length, 1);

    const refreshed = await harness.ok('open', { taskId: task.id, sessionId: 'sess-refresh', refresh: true });
    assert.equal(refreshed.status, 'refreshed');
    assert.equal(refreshed.injected, true);
    assert.equal(agent.messages.length, 2);
    assert.match(textOf(agent.messages[1]), /第二章 导数习题（修订）/);
    assert.match(textOf(agent.messages[1]), /做完 1-20 题/);
    assert.equal(harness.link('sess-refresh').digest, refreshed.digest);
  });

  it('closes the association without touching the other session state', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const agent = harness.agents.add('sess-close');
    await harness.ok('open', { taskId: task.id, sessionId: 'sess-close' });

    const closed = await harness.ok('close', { sessionId: 'sess-close' });
    assert.equal(closed.closed, true);
    assert.equal(closed.taskId, task.id);
    assert.equal(harness.link('sess-close'), undefined);
    assert.equal(agent.messages.length, 1, 'closing never edits the injected chat message');

    const context = await harness.ok('context', { sessionId: 'sess-close' });
    assert.equal(context.status, 'no_link');
    const missing = await harness.ok('close', { sessionId: 'sess-close' });
    assert.equal(missing.closed, false);
  });

  it('survives a restart without injecting the same task twice', async t => {
    const first = await boot(t);
    const task = await createTask(first);
    first.agents.add('sess-restart');
    await first.ok('open', { taskId: task.id, sessionId: 'sess-restart' });
    await first.fiber.dispose();

    const second = await boot(t, { directory: first.directory, cleanup: false });
    const agent = second.agents.add('sess-restart');
    const replay = await second.ok('open', { taskId: task.id, sessionId: 'sess-restart' });
    assert.equal(replay.status, 'already_injected');
    assert.equal(agent.messages.length, 0);
    assert.equal(second.changes('tutoring_link').length, 1);
    // WAL side files can stay locked for a moment after a read-only assertion
    // connection closes on Windows; dispose and retry the removal explicitly.
    await second.fiber.dispose();
    await new Promise(resolve => setTimeout(resolve, 200));
    await rm(second.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('keeps the link when no Agent service exists and flushes later', async t => {
    const harness = await boot(t, { withoutAgents: true });
    const task = await createTask(harness);
    const pending = await harness.ok('open', { taskId: task.id, sessionId: 'sess-offline' });
    assert.equal(pending.status, 'pending');
    assert.equal(harness.link('sess-offline').injected_at, null);
    const flushed = await harness.ok('flush', { sessionId: 'sess-offline' });
    assert.equal(flushed.status, 'pending');
  });
});

describe('tutoring brief', () => {
  it('returns the task even when no materials or plan exist', async t => {
    const harness = await boot(t);
    const task = await createTask(harness, { materialRef: '数学分析 第三版 第3章', completionCriteria: null, subject: null });

    const brief = await harness.ok('brief', { taskId: task.id });
    assert.equal(brief.task.id, task.id);
    assert.equal(brief.task.title, '第二章 导数习题');
    assert.deepEqual(brief.materials.hits, []);
    assert.equal(brief.plan.available, false);
    assert.equal(brief.plan.applied, false);
    assert.match(brief.plan.notice, /还没有任何学习计划/);
    assert.match(brief.text, /数学分析 第三版 第3章/);
    assert.match(brief.text, /没有找到相关资料片段/);
    assert.match(brief.text, /还没有任何学习计划/);
    assert.equal(brief.digest.length, 64);
  });

  it('does not treat an unconfirmed draft as the latest formal plan', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const draft = await harness.ctx.study.call('plans', 'saveDraft', {
      title: '未确认草案',
      baseRevision: 0, expectedDraftRevision:0,
      availability: [{ date: dateAfter(0), minutes: 120 }],
      items: [{ title: '第二章 导数习题', subject: '数学', estimateMinutes: 30, date: dateAfter(0), start: '19:00', end: '19:30' }],
    }, {requestId:randomUUID()});
    assert.equal(draft.ok, true);

    const brief = await harness.ok('brief', { taskId: task.id });
    assert.equal(brief.plan.applied, false);
    assert.match(brief.plan.notice, /计划尚未确认/);
    assert.doesNotMatch(brief.text, /未确认草案/);
  });

  it('reports a deleted task as not found and refuses to link it', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const removed = await harness.ctx.study.call('tasks', 'deleteTask', { id: task.id }, {requestId:randomUUID()});
    assert.equal(removed.ok, true);

    const brief = await harness.fail('brief', { taskId: task.id });
    assert.equal(brief.code, 'not_found');
    assert.match(brief.message, /已删除/);
    const opened = await harness.fail('open', { taskId: task.id, sessionId: 'sess-deleted' });
    assert.equal(opened.code, 'not_found');
    assert.equal(harness.link('sess-deleted'), undefined);
  });

  it('validates the payload and the task id', async t => {
    const harness = await boot(t);
    const missingTask = await harness.fail('open', { sessionId: 'sess-1' });
    assert.equal(missingTask.code, 'invalid');
    const missingSession = await harness.fail('open', { taskId: 'task_x' });
    assert.equal(missingSession.code, 'invalid');
    const unknownTask = await harness.fail('brief', { taskId: 'task_unknown' });
    assert.equal(unknownTask.code, 'not_found');
    const nonObject = await harness.fail('open', []);
    assert.equal(nonObject.code, 'invalid');
    const extra = await harness.fail('brief', { taskId: 'task_x', plan: 'copy' });
    assert.equal(extra.code, 'invalid');
  });

  it('never reads a session to build the brief', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const agent = {
      id: 'sess-no-session',
      messages: [],
      get session() { throw new Error('tutoring must not read chat state'); },
      inject(message) { this.messages.push(message); },
    };
    harness.agents.agents.set('sess-no-session', agent);
    const value = await harness.ok('open', { taskId: task.id, sessionId: 'sess-no-session' });
    assert.equal(value.status, 'injected');
    assert.equal(agent.messages.length, 1);
  });

  it('records one revision-bumping link row and keeps the table append-free', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    harness.agents.add('sess-table');
    const before = await harness.ctx.study.call('kernel', 'status');
    await harness.ok('open', { taskId: task.id, sessionId: 'sess-table' });
    const after = await harness.ctx.study.call('kernel', 'status');
    assert.equal(after.value.revision, before.value.revision + 1);
    const rows = readRows(harness, 'SELECT session_id, task_id, digest, injected_at FROM study_tutoring_link');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, 'sess-table');
    assert.equal(rows[0].task_id, task.id);
  });
});
