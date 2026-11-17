import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, createGoal, createMaterial, dateAfter, item, planPayload } from './helpers.mjs';
import { bootTimer, MINUTE } from '../timer/helpers.mjs';
import * as materialsModule from '../../host/modules/materials.mjs';
import * as plansModule from '../../host/modules/plans.mjs';

test('deadline and fixed blocks are visible capacity risks, including classified work', async t => {
  const h = await boot(t);
  const goal = await createGoal(h, { deadline: dateAfter(1), dailyMinutes: 120 });
  const fixed = await h.ctx.study.call('tasks', 'createBlock', { goalId: goal.id, date: dateAfter(2), start: '09:00', end: '10:00', fixed: true, title: '课程' }, { requestId: 'fixed-class' });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  const draft = await h.ok('saveDraft', planPayload({ goalId: goal.id, availability: [{ date: dateAfter(2), minutes: 120 }], items: [item({ date: dateAfter(2), start: '09:30', end: '10:30', workload: { study: 30, practice: 30, correction: 15, rest: 15 } })] }));
  assert.equal(draft.capacity.totals.plannedMinutes, 90);
  assert.equal(draft.capacity.days[0].fixedMinutes, 60);
  assert.equal(draft.capacity.days[0].availableMinutes, 60);
  for (const code of ['deadline_exceeded', 'fixed_overlap', 'over_capacity']) assert.ok(draft.capacity.conflicts.some(c => c.code === code), code);
  assert.equal(draft.capacity.requiresTrial, true);
  assert.equal((await h.fail('confirm', { planId: draft.plan.id, baseRevision: 0 })).details.reason, 'trial_required');
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0, trial: true });
  assert.equal((await h.ok('get', { planId: draft.plan.id })).capacity.totals.scheduledMinutes, 90);
});

test('each locator field needs evidence and material edition changes invalidate it on reads', async t => {
  const h = await boot(t);
  const material = await createMaterial(h, { text: '第 42 页\n第二章 导数\n例题 1：求导。', edition: '一版' });
  const draft = await h.ok('saveDraft', planPayload({ items: [item({ materialId: material.id, locator: { page: 42, chapter: '第二章', exercise: '99', verification: { exercise: { status: 'verified' } } } })] }));
  const locator = draft.draft.data.items[0].locator;
  assert.equal(locator.verification.page.status, 'verified');
  assert.equal(locator.verification.chapter.status, 'verified');
  assert.equal(locator.verification.exercise.status, 'unverified');
  assert.ok(locator.verification.page.evidence.chunkId);
  assert.ok(locator.unverified.includes('exercise'));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  assert.equal((await h.materials('updateMaterial', { materialId: material.id, edition: '二版' })).ok, true);
  const read = await h.ok('get', { planId: draft.plan.id });
  assert.equal(read.applied.data.items[0].locator.verification.page.status, 'unverified');
  assert.match(read.applied.data.items[0].locator.verification.page.assumption, /变更|失效/);
});

test('deleted material evidence is downgraded in both full plan and today views', async t => {
  const h = await boot(t);
  const material = await createMaterial(h, { text: '第 42 页\n第二章 导数\n求导定义和练习。' });
  const draft = await h.ok('saveDraft', planPayload({ items: [item({ materialId: material.id, locator: { page: 42 } })] }));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  await h.materials('deleteMaterial', { materialId: material.id });
  for (const method of ['get', 'today']) {
    const read = await h.ok(method, { planId: draft.plan.id });
    const locator = (method === 'get' ? read.applied.data.items[0] : read.items[0]).locator;
    assert.equal(locator.verification.page.status, 'unverified');
  }
});

test('rolling window exposes distant workload, and refine changes only its selected date with CAS and replay', async t => {
  const h = await boot(t);
  const a = item({ id: 'today', start: null, end: null });
  const b = item({ id: 'tomorrow', date: dateAfter(1), start: null, end: null });
  const far = item({ id: 'far', date: dateAfter(20), start: null, end: null, locator: { page: 99 } });
  const draft = await h.ok('saveDraft', planPayload({ horizonDays: 3, items: [a, b, far] }));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  const before = await h.ok('get', { planId: draft.plan.id });
  assert.equal(before.rolling.horizonDays, 3);
  assert.equal(before.rolling.distantWork[0].estimateMinutes, 60);
  assert.equal(before.rolling.distantWork[0].locator, undefined);
  assert.equal((await h.ok('today', { planId: draft.plan.id })).refinement.needed, true);
  const payload = { planId: draft.plan.id, baseRevision: 1, date: dateAfter(), items: [{ ...a, title: '读导数定义并做三题' }], reason: '细化今天' };
  const first = await h.ok('refine', payload, { requestId: 'refine-once' });
  const second = await h.ok('refine', payload, { requestId: 'refine-once' });
  assert.deepEqual(second, first);
  const after = await h.ok('get', { planId: draft.plan.id });
  assert.equal(after.plan.revision, 2);
  assert.deepEqual(after.applied.data.items.find(i => i.id === b.id), before.applied.data.items.find(i => i.id === b.id));
  assert.equal(after.applied.data.stageGoals.length, 1);
  assert.equal((await h.ok('today', { planId: draft.plan.id })).refinement.needed, false);
  assert.equal((await h.fail('refine', payload)).code, 'conflict');
  assert.equal((await h.fail('refine', { ...payload, baseRevision: 2, items: [{ ...b }] })).code, 'invalid');
});

test('refine refuses an unacknowledged manual draft instead of overwriting it', async t => {
  const h = await boot(t);
  const a = item();
  const draft = await h.ok('saveDraft', planPayload({ items: [a] }));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  await h.ok('saveDraft', planPayload({ planId: draft.plan.id, baseRevision: 1, items: [{ ...a, title: '手工修改' }] }));
  assert.equal((await h.fail('refine', { planId: draft.plan.id, baseRevision: 1, date: dateAfter(), items: [a], reason: '细化' })).code, 'conflict');
});

test('timer-backed estimation is a suggestion and needs confirmed completion', async t => {
  const h = await bootTimer(t);
  await h.database.applyModuleSchemas([materialsModule, plansModule]);
  h.database.exec('ALTER TABLE study_plan ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0');
  h.database.exec('ALTER TABLE study_plan_draft ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  for (const module of [materialsModule, plansModule]) module.apply(h.ctx, h.kernel);
  const date = '2026-11-10';
  const draft = (await h.ok('plans', 'saveDraft', { title: '估算校准', baseRevision: 0, items: [item({ id: 'estimate', date, start: null, end: null })], availability: [{ date, minutes: 120 }] })).value;
  await h.ok('plans', 'confirm', { planId: draft.plan.id, baseRevision: 0 });
  const read = (await h.ok('plans', 'get', { planId: draft.plan.id })).value;
  const taskId = read.applied.data.items[0].taskId;
  const started = await h.ok('timer', 'start', { kind: 'study', taskId });
  h.tick(20 * MINUTE);
  await h.ok('timer', 'finish', { id: started.value.session.id });
  assert.deepEqual((await h.ok('plans', 'get', { planId: draft.plan.id })).value.estimationSuggestions, []);
  await h.ok('plans', 'recordProgress', { planId: draft.plan.id, itemId: 'estimate', status: 'done', confirmed: true, date });
  const calibrated = (await h.ok('plans', 'get', { planId: draft.plan.id })).value;
  assert.equal(calibrated.estimationSuggestions[0].suggestedEstimateMinutes, 20);
  assert.equal(calibrated.estimationSuggestions[0].originalEstimateMinutes, 60);
  assert.equal(calibrated.estimationSuggestions[0].deviationMinutes, -40);
  assert.equal(calibrated.estimationSuggestions[0].applied, false);
  assert.equal(calibrated.applied.data.items[0].estimateMinutes, 60);
  assert.equal(calibrated.plan.revision, 1);
});

test('changing the material of a confirmed task requires an explicit replacement', async t => {
  const h = await boot(t);
  const first = await createMaterial(h);
  const second = await createMaterial(h, { title: '另一本练习册' });
  const a = item({ materialId: first.id });
  const draft = await h.ok('saveDraft', planPayload({ items: [a] }));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  const result = await h.fail('revise', { planId: draft.plan.id, baseRevision: 1, items: [{ ...a, materialId: second.id }], reason: '换教材' });
  assert.equal(result.details.reason, 'replacement_required');
});

test('a plan-owned fixed learning block is not counted as its own competing fixed course', async t => {
  const h = await boot(t);
  const draft = await h.ok('saveDraft', planPayload({ items: [item({ flexible: false })], availability: [{ date: dateAfter(), minutes: 60 }] }));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  const read = await h.ok('get', { planId: draft.plan.id });
  assert.equal(read.capacity.verdict, 'fits');
  assert.equal(read.capacity.days[0].fixedMinutes, 0);
});

test('declared table of contents provides field-specific evidence without inventing exercise numbers', async t => {
  const h = await boot(t);
  const material = await createMaterial(h, { text: '本资料先复习定义，再做练习。', toc: [{ title: '第三章 积分', page: 80 }] });
  const draft = await h.ok('saveDraft', planPayload({ items: [item({ materialId: material.id, locator: { chapter: '第三章 积分', page: 80, exercise: '20' } })] }));
  const locator = draft.draft.data.items[0].locator;
  assert.equal(locator.verification.chapter.status, 'verified');
  assert.equal(locator.verification.page.status, 'verified');
  assert.equal(locator.verification.exercise.status, 'unverified');
  assert.equal(locator.verification.chapter.evidence.tocIndex, 1);
});

test('undo cannot replay an old task snapshot through a replacement task identity', async t => {
  const h = await boot(t);
  const draft = await h.ok('saveDraft', planPayload({ items: [item()] }));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  const before = await h.ok('get', { planId: draft.plan.id });
  const replaced = await h.ctx.study.call('tasks', 'replaceTask', { id: before.applied.data.items[0].taskId, title: '换另一套题', materialRef: '另一本练习册，第10页' }, { requestId: 'replace-then-undo' });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  const after = await h.ok('get', { planId: draft.plan.id });
  const result = await h.fail('undo', { planId: draft.plan.id, baseRevision: after.plan.revision });
  assert.equal(result.code, 'conflict');
  assert.equal(result.details.reason, 'replacement_requires_explicit_action');
});

test('a deleted material reference does not block refine or revise of the whole plan', async t => {
  const h = await boot(t);
  const material = await createMaterial(h, { text: '第 42 页\n第二章 导数\n求导定义和练习。' });
  const a = item({ id: 'keep-material', materialId: material.id, locator: { page: 42 } });
  const draft = await h.ok('saveDraft', planPayload({ items: [a] }));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  await h.materials('deleteMaterial', { materialId: material.id });
  const refined = await h.ok('refine', { planId: draft.plan.id, baseRevision: 1, date: dateAfter(), items: [{ ...a, title: '细化：读定义' }] });
  const kept = refined.revision.data.items.find(entry => entry.id === a.id);
  assert.equal(kept.materialId, material.id, 'historical reference is kept, not silently cleared');
  assert.equal(kept.locator.verification.page.status, 'unverified');
  assert.match(kept.locator.verification.page.assumption, /失效|删除/);
  const applied = (await h.ok('get', { planId: draft.plan.id })).applied.data;
  const revised = await h.ok('revise', { planId: draft.plan.id, baseRevision: 2, items: applied.items, reason: '其余调整' });
  assert.equal(revised.revision.data.items.find(entry => entry.id === a.id).materialId, material.id);
  const other = await createMaterial(h, { title: '另一本练习册' });
  const denied = await h.fail('revise', { planId: draft.plan.id, baseRevision: 3, items: [{ ...applied.items[0], materialId: other.id }], reason: '换书' });
  assert.equal(denied.details.reason, 'replacement_required');
});

test('a replaced task can bind its new material once and verify the new locator', async t => {
  const h = await boot(t);
  const oldBook = await createMaterial(h, { text: '第 20 页\n第一章 旧书。' });
  const newBook = await createMaterial(h, { title: '新练习册', text: '第 12 页\n第三章 新书\n例题 2：积分。' });
  const a = item({ id: 'bind-item', materialId: oldBook.id, locator: { page: 20 } });
  const draft = await h.ok('saveDraft', planPayload({ items: [a] }));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  const before = await h.ok('get', { planId: draft.plan.id });
  const replaced = await h.ctx.study.call('tasks', 'replaceTask', { id: before.applied.data.items[0].taskId, title: '新书题', materialRef: '新练习册 p12' }, { requestId: 'replace-then-bind' });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  const afterReplace = await h.ok('get', { planId: draft.plan.id });
  const persisted = afterReplace.applied.data.items[0];
  assert.equal(persisted.materialId, null, 'a replacement starts without the old material binding');
  const bound = await h.ok('revise', {
    planId: draft.plan.id, baseRevision: afterReplace.plan.revision, reason: '绑定新书资料',
    items: [{ ...persisted, materialId: newBook.id, locator: { page: 12 } }],
  });
  const rebound = bound.revision.data.items[0];
  assert.equal(rebound.materialId, newBook.id);
  assert.equal(rebound.locator.verification.page.status, 'verified');
  const third = await createMaterial(h, { title: '又一本' });
  const denied = await h.fail('revise', { planId: draft.plan.id, baseRevision: bound.plan.revision, items: [{ ...rebound, materialId: third.id }], reason: '再换一本' });
  assert.equal(denied.details.reason, 'replacement_required');
});

test('refining either day of a split task preserves every other execution block', async t => {
  const h = await boot(t);
  const today = dateAfter(), tomorrow = dateAfter(1);
  const draft = await h.ok('saveDraft', planPayload({ availability: [{ date: today, minutes: 120 }, { date: tomorrow, minutes: 120 }],
    items: [item({ id: 'split-refine', estimateMinutes: 120, blocks: [
      { date: today, start: '09:00', end: '10:00' }, { date: tomorrow, start: '09:00', end: '10:00' },
    ] })] }));
  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  const before = await h.ok('get', { planId: draft.plan.id });
  const a = before.applied.data.items[0];
  await h.ok('refine', { planId: draft.plan.id, baseRevision: 1, date: today, items: [{ ...a, title: '细化今天的任务' }] });
  const first = await h.ok('get', { planId: draft.plan.id });
  assert.deepEqual(first.applied.data.items[0].blocks.find(b => b.date === tomorrow), a.blocks.find(b => b.date === tomorrow));
  const next = first.applied.data.items[0];
  await h.ok('refine', { planId: draft.plan.id, baseRevision: 2, date: tomorrow,
    items: [{ ...next, date: tomorrow, blocks: next.blocks.filter(b => b.date === tomorrow) }] });
  const second = await h.ok('get', { planId: draft.plan.id });
  assert.deepEqual(second.applied.data.items[0].blocks.find(b => b.date === today), a.blocks.find(b => b.date === today));
  await h.ok('refine', { planId: draft.plan.id, baseRevision: 3, date: today, items: [], trial: true });
  const third = await h.ok('get', { planId: draft.plan.id });
  assert.equal(third.applied.data.items.length, 1);
  assert.deepEqual(third.applied.data.items[0].blocks, [a.blocks.find(b => b.date === tomorrow)]);
});
