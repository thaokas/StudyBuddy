/**
 * Browser half of the study service route: `POST /api/study/<namespace>/<method>`
 * with a JSON envelope, authenticated by the page's own cookie.
 *
 * The envelope is the host's frozen contract:
 * success `{ ok: true, value, revision }`, failure `{ ok: false, code, message, details }`.
 * Failures become {@link StudyCallError} so callers can localize the surface
 * text while keeping the host's diagnostic message.
 */

/** Failure raised by {@link createStudyCall}; `code` is `network`, `malformed`, or a service code. */
export class StudyCallError extends Error {
  /**
   * @param {string} code - `network` (no response), `malformed` (unreadable envelope), or the host's service code.
   * @param {string} message - Diagnostic text from the host or the transport.
   * @param {{ namespace?: string, method?: string, details?: object }} [context] - Call identification.
   */
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'StudyCallError';
    this.code = code;
    this.namespace = context.namespace;
    this.method = context.method;
    this.details = context.details ?? {};
  }
}

/**
 * Create the caller bound to one route prefix.
 * @param {string} [base] - Prefix before `api/study/`; empty for the document origin.
 * @returns {(namespace: string, method: string, payload?: object) => Promise<{ ok: true, value: unknown, revision: number }>}
 *   Caller resolving with the success envelope.
 */
export function createStudyCall(base = '') {
  const transport = async function call(namespace, method, payload = {}) {
    const context = { namespace, method };
    let response;
    try {
      response = await fetch(`${base}api/study/${namespace}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new StudyCallError('network', error instanceof Error ? error.message : String(error), context);
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch (error) {
      throw new StudyCallError('malformed', `HTTP ${response.status}：响应不是 JSON`, { ...context, details: { reason: String(error) } });
    }
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw new StudyCallError('malformed', `HTTP ${response.status}：响应不是学习服务信封`, context);
    }
    if (envelope.ok === true) return envelope;
    throw new StudyCallError(
      typeof envelope.code === 'string' ? envelope.code : 'malformed',
      typeof envelope.message === 'string' ? envelope.message : `HTTP ${response.status}`,
      { ...context, details: envelope.details },
    );
  };
  const write = createWriteCall(transport);
  return (namespace, method, payload = {}) => WRITE_METHODS[namespace]?.includes(method)
    ? write(namespace, method, payload) : transport(namespace, method, payload);
}

const WRITE_METHODS = {
  materials: ['saveGoal', 'importText', 'importFile', 'updateMaterial', 'deleteMaterial'],
  plans: ['saveDraft', 'discardDraft', 'confirm', 'revise', 'undo', 'recordProgress'],
  planning: ['start', 'claim', 'close'],
  tasks: ['createTask', 'updateTask', 'deleteTask', 'createBlock', 'updateBlock', 'deleteBlock', 'moveBlock', 'recordProgress'],
  memory: ['remember', 'forget', 'profileSet'],
  learning: ['merge', 'split'],
  review: ['week', 'month', 'save'],
  followup: ['claim', 'answer', 'snooze', 'updateSettings', 'review', 'runReview', 'runDueCheck'],
  timer: ['start', 'pause', 'resume', 'finish', 'confirm', 'updateSettings'],
  tutoring: ['open', 'ask', 'link', 'close', 'flush'],
};

/** Coalesce double clicks and keep the operation identity after uncertain transport failures. */
export function createWriteCall(call) {
  const operations = new Map();
  return function write(namespace, method, payload = {}) {
    const key = JSON.stringify([namespace, method, payload]);
    let operation = operations.get(key);
    if (operation?.promise) return operation.promise;
    operation ??= { requestId: payload.requestId ?? globalThis.crypto.randomUUID() };
    operations.set(key, operation);
    operation.promise = Promise.resolve().then(() => call(namespace, method, { ...payload, requestId: operation.requestId }))
      .then(result => { operations.delete(key); return result; }, error => {
        operation.promise = null;
        if (!['network', 'malformed'].includes(error.code)) operations.delete(key);
        throw error;
      });
    return operation.promise;
  };
}
