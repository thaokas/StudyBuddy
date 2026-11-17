import assert from 'node:assert/strict';
import { it } from 'node:test';
import { bootMilestones, bootMilestonesOnly } from './helpers.mjs';

it('registers personal milestone writes with explicit validation', async t => {
  const h = await bootMilestonesOnly(t);
  const result = await h.call('milestones', 'savePersonal', { title: '', taskIds: [] });
  assert.equal(result.code, 'invalid');
});

it('earns a personal milestone only when every linked task has confirmed done evidence', async t => {
  const h = await bootMilestones(t);
  const a = await h.task('第三章例题');
  const b = await h.task('第三章习题');
  const saved = await h.ok('milestones', 'savePersonal', { title: '完成高数第三章', taskIds: [a.id, b.id] }, { requestId: 'personal-create' });
  const again = await h.ok('milestones', 'savePersonal', { title: '完成高数第三章', taskIds: [a.id, b.id] }, { requestId: 'personal-create' });
  assert.equal(again.value.item.id, saved.value.item.id);
  await h.taskProgress(a.id, 'done', '2026-11-10');
  await h.taskProgress(b.id, 'cancelled', '2026-11-10');
  let item = (await h.ok('milestones', 'listPersonal', {})).value.items[0];
  assert.equal(item.earned, false); assert.equal(item.completed, 1);
  await h.taskProgress(b.id, 'done', '2026-11-10', { confirmed: false });
  assert.equal((await h.ok('milestones', 'listPersonal', {})).value.items[0].earned, false);
  await h.taskProgress(b.id, 'done', '2026-11-10');
  item = (await h.ok('milestones', 'listPersonal', {})).value.items[0];
  assert.equal(item.earned, true); assert.equal(item.evidence.length, 2);
  assert.ok(item.evidence.every(ref => ref.recordId));
  const failed = await h.fail('milestones', 'savePersonal', { title: '无证据', taskIds: ['missing'] });
  assert.equal(failed.code, 'invalid');
  await h.ok('milestones', 'deletePersonal', { id: item.id });
  assert.equal((await h.ok('milestones', 'listPersonal', {})).value.items.length, 0);
});
