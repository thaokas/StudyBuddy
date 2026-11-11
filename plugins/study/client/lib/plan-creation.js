/**
 * Start a plan-creation conversation from the "Create plan" page.
 *
 * The order is the contract: create or reuse the workspace's blank session,
 * store the brief through the study service, and only then open the session and
 * prefill the opening message. The first model step reads the stored brief, so
 * opening the conversation earlier would let a message race in before the
 * snapshot exists.
 */

/**
 * Build the activity callback the page calls.
 * @param {{
 *   uiWorkspace: { connectWorkspace: Function, openSession: Function },
 *   workspaces: { list: { getSnapshot: Function }, initializeDefault: Function },
 *   sessions: { binding: Function },
 *   getConversation: () => { input: { requestDraftInitialization: Function } } | undefined,
 *   call: (namespace: string, method: string, payload?: object) => Promise<object>,
 *   t: (key: string, params?: object) => string,
 * }} deps - Injected client services and the study route caller.
 * @returns {(request?: { goalId?: string | null, brief?: object }) => Promise<string>} Starter.
 */
export function createPlanCreation({ uiWorkspace, workspaces, sessions, getConversation, call, t }) {
  return async function startPlanCreation({ goalId, brief } = {}) {
    const workspacesSnapshot = workspaces?.list?.getSnapshot?.() ?? {};
    const items = Array.isArray(workspacesSnapshot.items) ? workspacesSnapshot.items : [];
    const workspace = items[0] ?? await workspaces?.initializeDefault?.();
    if (workspace === undefined || workspace === null) throw new Error(t('daily.sessionUnavailable'));
    const sessionId = await uiWorkspace.connectWorkspace(workspace.workspaceId);
    await call('planning', 'start', {
      sessionId,
      ...(goalId === undefined || goalId === null ? {} : { goalId }),
      brief: brief ?? {},
    });
    uiWorkspace.openSession(sessionId);
    const binding = sessions?.binding?.(sessionId);
    const conversation = getConversation?.();
    if (binding === undefined || conversation === undefined) return sessionId;
    try {
      conversation.input.requestDraftInitialization(binding, {
        prompt: t('onboarding.brief.seed'),
        whenDraftExists: 'append',
      });
    } catch (error) {
      // The conversation is already open and linked; a missing prefill only
      // costs the student one sentence, so it must not fail the handoff.
      console.warn('[study] plan creation draft was not prefilled:', error);
    }
    return sessionId;
  };
}
