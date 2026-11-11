import { bootFollowup, item } from '../../../../../../plugins/study/tests/followup/helpers.mjs';
import * as memory from '../../../../../../plugins/study/host/modules/memory.mjs';
const results = [];
async function probe(name, run) {
  const cleanups = [];
  const h = await bootFollowup({ after: fn => cleanups.push(fn) });
  try { results.push({ name, ...await run(h) }); }
  finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
}
const availability = h => Array.from({ length: 8 }, (_, i) => ({ date: h.date(i), minutes: 120 }));
await probe('confirmed plan has no workbench tasks/blocks', async h => {
  const saved = await h.createPlan({ availability: availability(h), items: [item({ id: 'task-a', date: h.today() })] });
  const day = await h.ok('tasks', 'day', {});
  const plan = await h.plan(saved.plan.id);
  return { planItems: plan.applied.data.items.length, workbenchTasks: day.tasks.length, workbenchBlocks: day.blocks.length };
});
await probe('reminder becomes due at start, before estimated finish', async h => {
  const task = await h.createTask('One hour task');
  await h.createBlock({ taskId: task.id, date: h.today(), start: '09:00', end: '10:00' });
  h.advance(60 * 60 * 1000);
  const due = await h.followup('due', {});
  return { localTime: due.time, newReminders: due.newItems.length, start: due.newItems[0]?.start, end: due.newItems[0]?.end };
});
await probe('partial remainder shrinks again without new progress', async h => {
  const saved = await h.createPlan({ availability: availability(h), items: [item({ id: 'partial-a', date: h.today() })] });
  await h.recordPlanProgress({ planId: saved.plan.id, itemId: 'partial-a', status: 'partial', quantityDone: 5, quantityTotal: 10 });
  const r1 = await h.followup('review', {});
  const first = (await h.plan(saved.plan.id)).applied.data.items[0];
  h.advance(24 * 60 * 60 * 1000);
  const r2 = await h.followup('review', {});
  const second = (await h.plan(saved.plan.id)).applied.data.items[0];
  return { firstCommitted: r1.committed, secondCommitted: r2.committed, originalMinutes: 60, firstRemaining: first.estimateMinutes, secondRemaining: second.estimateMinutes };
});
await probe('60 minute task does not split across two 30 minute days', async h => {
  await h.createPlan({ availability: Array.from({ length: 8 }, (_, i) => ({ date: h.date(i), minutes: i === 0 ? 60 : i < 3 ? 30 : 0 })), items: [item({ id: 'split-a', date: h.today() })] });
  await h.recordPlanProgress({ itemId: 'split-a', status: 'not_started' });
  const r = await h.followup('reviewPreview', {});
  return { remaining: r.summary.remainingMinutes, moved: r.summary.movedMinutes, unscheduled: r.summary.unscheduledMinutes };
});
await probe('active goal does not select matching plan', async h => {
  const ga = (await h.ok('materials', 'saveGoal', { exam: 'Goal A', dailyMinutes: 120 })).goal;
  const a = await h.createPlan({ title: 'Plan A', goalId: ga.id, availability: availability(h), items: [] });
  const gb = (await h.ok('materials', 'saveGoal', { exam: 'Goal B', dailyMinutes: 120 })).goal;
  await h.createPlan({ title: 'Plan B', goalId: gb.id, availability: availability(h), items: [] });
  await h.ok('materials', 'saveGoal', { id: ga.id, exam: 'Goal A', dailyMinutes: 120, active: true });
  const current = await h.plan();
  return { activeGoal: ga.id, expectedPlan: a.plan.id, selectedTitle: current.plan.title, selectedGoal: current.plan.goalId };
});
await probe('stale draft replaces newer draft at same formal revision', async h => {
  const saved = await h.createPlan({ availability: availability(h), items: [item({ id: 'draft-a', date: h.today() })] });
  const data = (await h.plan(saved.plan.id)).applied.data;
  await h.ok('plans', 'saveDraft', { ...data, planId: saved.plan.id, baseRevision: 1, title: 'New manual draft' });
  const stale = await h.call('plans', 'saveDraft', { ...data, planId: saved.plan.id, baseRevision: 1, title: 'Stale agent draft' }, { actor: 'agent' });
  return { staleAccepted: stale.ok, finalDraftTitle: (await h.plan(saved.plan.id)).draft.data.title };
});
await probe('corrected memory can be recreated from old text', async h => {
  memory.apply({ ...h.ctx, inject: () => {} }, h.kernel);
  const old = 'I prefer studying math in the morning';
  const m = await h.ok('memory', 'remember', { text: old });
  await h.ok('memory', 'remember', { id: m.item.id, text: 'I prefer studying math in the evening' });
  const recreated = await h.ok('memory', 'remember', { text: old }, { actor: 'agent' });
  return { recreatedStatus: recreated.status, memories: (await h.ok('memory', 'recall', {})).items.map(m => m.text) };
});
await probe('reschedule without optional id loses task progress', async h => {
  const saved = await h.createPlan({ availability: availability(h), items: [item({ date: h.today() })] });
  const before = (await h.plan(saved.plan.id)).applied.data;
  const oldId = before.items[0].id;
  await h.recordPlanProgress({ planId: saved.plan.id, itemId: oldId, status: 'done' });
  const { id, ...withoutId } = before.items[0];
  await h.ok('plans', 'revise', { ...before, planId: saved.plan.id, baseRevision: 1, reason: 'Reschedule', items: [{ ...withoutId, date: h.date(1) }] });
  const after = (await h.plan(saved.plan.id)).applied.data.items[0];
  const progress = await h.planProgress(saved.plan.id);
  return { oldId, newId: after.id, progress: progress.items[0]?.progress };
});
await probe('repeated agent memory write without requestId creates duplicates', async h => {
  memory.apply({ ...h.ctx, inject: () => {} }, h.kernel);
  const payload = { text: 'I prefer math' };
  await h.ok('memory', 'remember', payload, { actor: 'agent' });
  await h.ok('memory', 'remember', payload, { actor: 'agent' });
  return { numberOfIdenticalMemories: (await h.ok('memory', 'recall', {})).items.length };
});
await probe('cancelling a task raises workbench completion to 100 percent', async h => {
  const a = await h.createTask('A');
  const b = await h.createTask('B');
  await h.recordTaskProgress({ taskId: a.id, status: 'done' });
  await h.recordTaskProgress({ taskId: b.id, status: 'cancelled' });
  return { completion: (await h.ok('tasks', 'day', {})).completion };
});
await probe('plan after deadline accepted without risk', async h => {
  const goal = (await h.ok('materials', 'saveGoal', { exam: 'Exam', deadline: h.today(), dailyMinutes: 120 })).goal;
  const draft = await h.ok('plans', 'saveDraft', { title: 'Late plan', goalId: goal.id, baseRevision: 0, items: [item({ date: h.date(2) })] });
  const confirm = await h.call('plans', 'confirm', { planId: draft.plan.id, baseRevision: 0 });
  return { confirmed: confirm.ok, verdict: draft.capacity.verdict, conflicts: draft.capacity.conflicts, deadline: goal.deadline };
});
console.log(JSON.stringify(results, null, 2));
