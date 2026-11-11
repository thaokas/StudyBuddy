/**
 * "Plan with the assistant" sequencing: create the session, store the brief,
 * only then open the conversation and prefill the opening message.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPlanCreation } from '../../client/lib/plan-creation.js';

/** Build the dependency fakes and record the calls in order. */
function harness(overrides = {}) {
  const calls = [];
  const deps = {
    uiWorkspace: {
      connectWorkspace: async workspaceId => {
        calls.push(['connect', workspaceId]);
        return 'session-1';
      },
      openSession: sessionId => { calls.push(['open', sessionId]); },
    },
    workspaces: {
      list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1' }] }) },
      initializeDefault: async () => {
        calls.push(['initialize']);
        return { workspaceId: 'ws-default' };
      },
    },
    sessions: { binding: sessionId => ({ id: sessionId }) },
    getConversation: () => ({
      input: {
        requestDraftInitialization: (binding, options) => { calls.push(['draft', binding.id, options]); },
      },
    }),
    call: async (namespace, method, payload) => {
      calls.push(['call', namespace, method, payload]);
      return { ok: true };
    },
    t: key => key === 'onboarding.brief.seed' ? 'SEED' : key,
    ...overrides,
  };
  return { deps, calls, start: createPlanCreation(deps) };
}

describe('createPlanCreation', () => {
  it('creates, links, opens and prefills in that order', async () => {
    const { calls, start } = harness();
    const sessionId = await start({ goalId: 'goal-1', brief: { planTitle: '数学计划' } });
    assert.equal(sessionId, 'session-1');
    assert.deepEqual(calls, [
      ['connect', 'ws-1'],
      ['call', 'planning', 'start', { sessionId: 'session-1', goalId: 'goal-1', brief: { planTitle: '数学计划' } }],
      ['open', 'session-1'],
      ['draft', 'session-1', { prompt: 'SEED', whenDraftExists: 'append' }],
    ]);
  });

  it('omits a missing goal and defaults the brief', async () => {
    const { calls, start } = harness();
    await start();
    const startCall = calls.find(call => call[1] === 'planning');
    assert.deepEqual(startCall[3], { sessionId: 'session-1', brief: {} });
  });

  it('creates a default workspace when none is listed', async () => {
    const { calls, start } = harness({
      workspaces: {
        list: { getSnapshot: () => ({ items: [] }) },
        initializeDefault: async () => {
          calls.push(['initialize']);
          return { workspaceId: 'ws-default' };
        },
      },
    });
    await start({ brief: {} });
    assert.deepEqual(calls[0], ['initialize']);
    assert.deepEqual(calls[1], ['connect', 'ws-default']);
  });

  it('fails before opening anything when no workspace is available', async () => {
    const { calls, start } = harness({
      workspaces: {
        list: { getSnapshot: () => ({ items: [] }) },
        initializeDefault: async () => undefined,
      },
    });
    await assert.rejects(() => start({ brief: {} }), /daily\.sessionUnavailable/);
    assert.deepEqual(calls, []);
  });

  it('does not open the conversation when the brief cannot be stored', async () => {
    const { calls, start } = harness({
      call: async () => { throw new Error('route failed'); },
    });
    await assert.rejects(() => start({ brief: {} }), /route failed/);
    assert.equal(calls.some(call => call[0] === 'open'), false);
  });

  it('opens the conversation without a prefill when either side is unavailable', async () => {
    const noBinding = harness({ sessions: { binding: () => undefined } });
    assert.equal(await noBinding.start({ brief: {} }), 'session-1');
    assert.equal(noBinding.calls.some(call => call[0] === 'draft'), false);

    const noConversation = harness({ getConversation: () => undefined });
    assert.equal(await noConversation.start({ brief: {} }), 'session-1');
    assert.ok(noConversation.calls.some(call => call[0] === 'open'));
  });

  it('keeps the handoff successful when the prefill itself throws', async () => {
    const { start } = harness({
      getConversation: () => ({
        input: { requestDraftInitialization: () => { throw new Error('blocked'); } },
      }),
    });
    assert.equal(await start({ brief: {} }), 'session-1');
  });
});
