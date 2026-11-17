/**
 * The shipped plugin view of the timer: module discovery, schema creation,
 * authenticated routes through the real host entry, no Agent tool (the timer is
 * deterministic and never calls a model), and restart recovery after a real
 * plugin dispose.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MINUTE, bootHost } from './helpers.mjs';

describe('timer host integration', () => {
  it('loads as a discovered module with its namespace, routes, and schema', async t => {
    const harness = await bootHost(t);
    const status = (await harness.ok('kernel', 'status', {})).value;
    assert.ok(status.modules.some(module => module.id === 'timer'), 'timer 模块应被自动发现');
    const namespace = status.namespaces.find(entry => entry.ns === 'timer');
    assert.ok(namespace, 'timer 命名空间应已注册');
    assert.deepEqual(namespace.methods.sort(), ['confirm', 'finish', 'pause', 'resume', 'start', 'status', 'updateSettings']);
    assert.deepEqual(namespace.writes.sort(), ['confirm', 'finish', 'pause', 'resume', 'start', 'updateSettings']);

    const paths = harness.routes.map(route => route.path);
    for (const method of namespace.methods) {
      assert.ok(paths.includes(`/api/study/timer/${method}`), `缺少路由 /api/study/timer/${method}`);
    }
    const toolNames = harness.tools.map(tool => tool.name);
    assert.equal(toolNames.includes('study_timer'), false, '番茄钟不注册模型工具');
    assert.equal(toolNames.includes('study_status'), true, '其他模块的工具仍在');
    assert.equal(status.modules.find(module => module.id === 'timer').schemaVersion, 1);
  });

  it('serves the timer route with the success envelope and rejects a bad write', async t => {
    const harness = await bootHost(t);
    const statusRoute = harness.routes.find(route => route.path === '/api/study/timer/status');
    const response = await statusRoute.fetch(new Request('http://localhost/api/study/timer/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'timer-route-status' }),
    }));
    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.value.settings, { studyMinutes: 25, restMinutes: 5 });
    assert.equal(envelope.value.session, null);

    const startRoute = harness.routes.find(route => route.path === '/api/study/timer/start');
    const badStart = await startRoute.fetch(new Request('http://localhost/api/study/timer/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'nap', requestId: 'bad-start' }),
    }));
    assert.equal(badStart.status, 400);
    const failure = await badStart.json();
    assert.equal(failure.code, 'invalid');
    assert.equal(failure.details.field, 'kind');
  });

  it('drives a real-clock session through the shipped service', async t => {
    const harness = await bootHost(t);
    const task = (await harness.ok('tasks', 'createTask', { title: '普通物理 第2章' })).value.task;
    const started = (await harness.ok('timer', 'start', { kind: 'study', taskId: task.id })).value.session;
    assert.equal(started.phase, 'running');
    assert.equal(started.task.title, '普通物理 第2章');

    const paused = (await harness.ok('timer', 'pause', { id: started.id })).value.session;
    assert.equal(paused.phase, 'paused');
    assert.ok(paused.focusedMs >= 0 && paused.focusedMs < 10_000);

    const resumed = (await harness.ok('timer', 'resume', { id: started.id })).value.session;
    assert.equal(resumed.phase, 'running');
    await harness.ctx.study.call('timer', 'status', {}, { actor: 'ui' });
    const finished = (await harness.ok('timer', 'finish', { id: started.id })).value.session;
    assert.equal(finished.phase, 'finished');
    assert.equal(finished.outcome, 'ended');
    assert.ok(finished.focusedMs >= 0 && finished.focusedMs < 10_000);
    assert.ok(finished.focusedMs <= MINUTE);

    const taskAfter = (await harness.ok('tasks', 'getTask', { id: task.id })).value.task;
    assert.ok(!('completed' in taskAfter), '任务没有被计时器改写');
  });

  it('recovers a running session as interrupted after the plugin is reopened', async t => {
    const first = await bootHost(t);
    const started = (await first.ok('timer', 'start', { kind: 'study' }, { requestId: 'host-restart' })).value.session;
    await first.fiber.dispose();

    const second = await bootHost(t, { directory: first.directory });
    const session = (await second.ok('timer', 'status', {})).value.session;
    assert.equal(session.id, started.id);
    assert.equal(session.phase, 'interrupted');
    assert.equal(session.interruption.reason, 'restart');
    assert.equal(session.focusedMs, 0);
    const confirmed = (await second.ok('timer', 'confirm', { id: started.id, action: 'finish' })).value.session;
    assert.equal(confirmed.phase, 'finished');
    assert.equal(confirmed.outcome, 'ended');
    await second.fiber.dispose();
  });
});
