import { randomUUID } from 'node:crypto';

/** Legacy test clients now send explicit operation IDs and draft CAS versions. */
export function fixtureCaller(raw) {
  const prepared = new Map();
  return async (ns, method, input = {}, options = {}) => {
    const original = JSON.stringify([ns, method, input]);
    const requestId = options.requestId ?? randomUUID();
    const cached = prepared.get(requestId);
    if (cached?.original === original) return raw(ns, method, cached.payload, { ...options, requestId });
    let payload = { ...input };
    if (['tasks', 'plans', 'outcomes', 'materials', 'memory', 'followup', 'milestones'].includes(ns)
      && !['getGoal', 'listGoals', 'saveGoal'].includes(method) && payload.goalId === undefined) {
      const goal = await raw('materials', 'getGoal', {});
      if ((goal.ok && !goal.value.goal) || (!goal.ok && ns === 'tasks')) payload.goalId = 'unassigned';
    }
    if (ns === 'plans' && ['saveDraft', 'confirm', 'discardDraft', 'revise', 'undo'].includes(method)
      && payload.expectedDraftRevision === undefined) {
      const current = payload.planId || method !== 'saveDraft'
        ? await raw('plans', 'get', { planId: payload.planId, goalId: payload.goalId }) : null;
      payload.expectedDraftRevision = current?.value?.draft?.draftRevision ?? 0;
    }
    prepared.set(requestId, { original, payload });
    return raw(ns, method, payload, { ...options, requestId });
  };
}
