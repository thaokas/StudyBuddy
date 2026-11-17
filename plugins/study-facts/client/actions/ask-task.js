/**
 * "Ask about this task" action.
 *
 * The page supplies the task and, when a conversation is open, its session id.
 * With a session the action links the task through the study route and lets the
 * host inject the tutoring context; without one it returns the brief so the
 * page can start a conversation for the student. The action owns neither
 * session creation nor navigation: those stay with the page and the DSH client
 * services, so free chat is never bound to a task by accident.
 */

/** Read a non-empty id from a string or from an object with the given field. */
function idOf(value, field) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  const nested = value?.[field];
  return typeof nested === 'string' && nested.trim().length > 0 ? nested.trim() : '';
}

/** Resolve one dictionary key, falling back to an English diagnostic in tests. */
function message(t, key, fallback) {
  return typeof t === 'function' ? t(key) : fallback;
}

export default {
  id: 'ask-task',
  page: 'workbench',
  label: 'tutoring.ask',
  /**
   * Link the task to the caller's session, or return its brief when no session
   * is open yet.
   * @param {{ call: Function, taskId?: string, task?: { id?: string }, sessionId?: string,
   *   session?: { id?: string }, openSession?: (sessionId: string) => void, t?: Function }} context
   *   Action context supplied by the page.
   * @returns {Promise<object>} Host result including the task.
   * @throws {Error} When the task id is missing or the study route rejects the call.
   */
  async run(context = {}) {
    const taskId = idOf(context.taskId, 'id') || idOf(context.task, 'id');
    if (taskId === '') {
      throw new Error(message(context.t, 'tutoring.ask.missingTask', 'Open a task first, then ask about it.'));
    }
    if (typeof context.call !== 'function') throw new Error('ask-task needs the study route caller');
    const sessionId = idOf(context.sessionId, 'id') || idOf(context.session, 'id') || (typeof context.ensureSession === 'function' ? await context.ensureSession() : '');
    if (sessionId === '') {
      const envelope = await context.call('tutoring', 'brief', { taskId });
      return { status: 'brief', ...(envelope?.value ?? {}) };
    }
    const envelope = await context.call('tutoring', 'open', { taskId, sessionId, requestId: context.requestId ?? globalThis.crypto?.randomUUID?.() });
    const value = envelope?.value ?? {};
    if (typeof context.openSession === 'function') context.openSession(sessionId);
    return value;
  },
};
