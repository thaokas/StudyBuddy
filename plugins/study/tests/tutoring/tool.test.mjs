/**
 * The Agent-facing `study_tutoring` tool: it targets the calling session, so
 * the student can ask about a task from any conversation without a client
 * button.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boot, createTask } from './helpers.mjs';

/** A fake Agent carrying the session identity the tool reads. */
function sessionAgent(sessionId) {
  const agent = {
    id: sessionId,
    messages: [],
    inject(message) { agent.messages.push(message); },
  };
  return agent;
}

describe('study_tutoring tool', () => {
  it('registers with the expected shape', async t => {
    const harness = await boot(t);
    const tool = harness.tools.find(item => item.name === 'study_tutoring');
    assert.ok(tool);
    assert.equal(typeof tool.execute, 'function');
    assert.deepEqual(tool.parameters.properties.action.enum, ['open', 'context', 'close']);
    assert.deepEqual(tool.parameters.required, ['action']);
  });

  it('opens the calling session and returns the task', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const agent = sessionAgent('sess-tool-open');
    harness.agents.agents.set('sess-tool-open', agent);

    const value = await harness.tool('study_tutoring', { action: 'open', taskId: task.id }, { agent });

    assert.equal(value.status, 'injected');
    assert.equal(value.task.id, task.id);
    assert.equal(agent.messages.length, 1);
    assert.equal(agent.messages[0].source.kind, 'study-tutoring');
    assert.equal(harness.link('sess-tool-open').task_id, task.id);
    const changes = harness.changes('tutoring_link');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].actor, 'agent');
  });

  it('reads the association and closes it through the same session', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    const agent = sessionAgent('sess-tool-close');
    harness.agents.agents.set('sess-tool-close', agent);
    await harness.tool('study_tutoring', { action: 'open', taskId: task.id }, { agent });

    const context = await harness.tool('study_tutoring', { action: 'context' }, { agent });
    assert.equal(context.status, 'linked');
    assert.equal(context.task.id, task.id);
    assert.equal(context.stale, false);

    const closed = await harness.tool('study_tutoring', { action: 'close' }, { agent });
    assert.equal(closed.closed, true);
    assert.equal(harness.link('sess-tool-close'), undefined);
  });

  it('refuses to run without a calling Agent', async t => {
    const harness = await boot(t);
    const task = await createTask(harness);
    await assert.rejects(
      harness.tool('study_tutoring', { action: 'open', taskId: task.id }),
      /当前对话没有可关联的会话/,
    );
    assert.equal(harness.link('sess-tool-open'), undefined);
  });

  it('requires a task id for open', async t => {
    const harness = await boot(t);
    const agent = sessionAgent('sess-tool-missing');
    await assert.rejects(
      harness.tool('study_tutoring', { action: 'open' }, { agent }),
      /taskId/,
    );
    assert.equal(agent.messages.length, 0);
  });

  it('surfaces a service failure instead of announcing success', async t => {
    const harness = await boot(t);
    const agent = sessionAgent('sess-tool-fail');
    await assert.rejects(
      harness.tool('study_tutoring', { action: 'open', taskId: 'task_missing' }, { agent }),
      /找不到任务/,
    );
    assert.equal(harness.link('sess-tool-fail'), undefined);
  });
});
