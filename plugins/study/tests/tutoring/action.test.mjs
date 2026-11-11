/**
 * The "ask about this task" client action: it links the task to the caller's
 * session through the study route, or returns the brief when the page has no
 * session yet. The action never creates a session itself; the page owns
 * navigation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import askTask from '../../client/actions/ask-task.js';
import dictionary from '../../client/messages/tutoring.js';

/** Translate one key with the test dictionary, like the page's `t`. */
function translate(locale, key, params = {}) {
  const template = dictionary[locale][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

describe('ask-task action', () => {
  it('declares the workbench action and a bilingual label', () => {
    assert.equal(askTask.id, 'ask-task');
    assert.equal(askTask.page, 'workbench');
    assert.equal(askTask.label, 'tutoring.ask');
    assert.equal(typeof askTask.run, 'function');
    assert.equal(dictionary.en['tutoring.ask'], 'Ask about this task');
    assert.equal(dictionary.zh['tutoring.ask'], '问这道题');
  });

  it('links the task to the given session and returns it', async () => {
    const calls = [];
    const opened = [];
    const value = await askTask.run({
      taskId: 'task_1',
      sessionId: 'sess-1',
      call: async (namespace, method, payload) => {
        calls.push({ namespace, method, payload });
        return {
          ok: true,
          revision: 3,
          value: { status: 'injected', sessionId: 'sess-1', task: { id: 'task_1', title: '极限习题' }, injected: true },
        };
      },
      openSession: sessionId => opened.push(sessionId),
      t: key => translate('zh', key),
    });

    assert.equal(typeof calls[0].payload.requestId,'string');
    delete calls[0].payload.requestId;
    assert.deepEqual(calls, [{ namespace: 'tutoring', method: 'open', payload: { taskId: 'task_1', sessionId: 'sess-1' } }]);
    assert.deepEqual(opened, ['sess-1']);
    assert.equal(value.task.id, 'task_1');
    assert.equal(value.status, 'injected');
  });

  it('accepts a task object and returns the brief when no session is open', async () => {
    const calls = [];
    const value = await askTask.run({
      task: { id: 'task_2' },
      call: async (namespace, method, payload) => {
        calls.push({ namespace, method, payload });
        return { ok: true, revision: 1, value: { task: { id: 'task_2' }, text: 'brief', digest: 'abc' } };
      },
      t: key => translate('en', key),
    });

    assert.deepEqual(calls, [{ namespace: 'tutoring', method: 'brief', payload: { taskId: 'task_2' } }]);
    assert.equal(value.status, 'brief');
    assert.equal(value.task.id, 'task_2');
  });

  it('rejects a call with no task before touching the route', async () => {
    let called = false;
    await assert.rejects(
      askTask.run({
        call: async () => { called = true; },
        t: key => translate('zh', key),
      }),
      /请先打开一个任务/,
    );
    assert.equal(called, false);
  });

  it('surfaces a service failure unchanged', async () => {
    const failure = Object.assign(new Error('找不到任务 task_1'), { code: 'not_found' });
    await assert.rejects(
      askTask.run({
        taskId: 'task_1',
        sessionId: 'sess-1',
        call: async () => { throw failure; },
        t: key => translate('en', key),
      }),
      error => error === failure,
    );
  });
});
