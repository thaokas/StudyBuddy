/**
 * T13 material advancement: only confirmed `partial`/`done` records count, a
 * cancelled or pending item is not "progress", and task material references
 * are reported separately from library materials instead of being invented as
 * material ids.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootOutcomes, createClock, item, localInstant } from './helpers.mjs';

const DAY = '2026-11-11';

describe('materials advanced', () => {
  it('counts confirmed plan-item advances per material and drops cancelled or pending items', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 8)) });
    const workbook = await harness.material('数学练习册', { subject: '数学' });
    const vocabulary = await harness.material('英语词汇', { subject: '英语' });
    const confirmed = await harness.plan([
      item({ id: 'm1', title: '练习册 第1章', date: DAY, materialId: workbook.id }),
      item({ id: 'm2', title: '练习册 第2章', date: DAY, materialId: workbook.id }),
      item({ id: 'm3', title: '词汇 第1单元', date: DAY, materialId: vocabulary.id }),
      item({ id: 'm4', title: '词汇 第2单元', date: DAY, materialId: vocabulary.id }),
    ]);
    harness.clock.setLocal(2026, 11, 11, 8);
    await harness.planProgress(confirmed.planId, 'm1', 'done', DAY);
    await harness.planProgress(confirmed.planId, 'm2', 'partial', DAY, { quantityDone: 3, quantityTotal: 10 });
    await harness.planProgress(confirmed.planId, 'm3', 'cancelled', DAY);
    await harness.planProgress(confirmed.planId, 'm4', 'done', DAY, { confirmed: false });

    const result = await harness.outcomes('day', { date: DAY });
    assert.equal(result.materials.advancedItemCount, 2);
    assert.equal(result.materials.distinctMaterialCount, 1);
    assert.equal(result.materials.items.length, 1);
    const advanced = result.materials.items[0];
    assert.equal(advanced.materialId, workbook.id);
    assert.equal(advanced.title, '数学练习册');
    assert.deepEqual(advanced.itemIds, ['m1', 'm2']);
    assert.deepEqual(advanced.planIds, [confirmed.planId]);
    assert.deepEqual(advanced.recordDates, [DAY]);
    assert.equal(result.materials.taskReferenceCount, 0);
  });

  it('reports task material references separately and excludes cancelled tasks', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 22)) });
    const workbook = await harness.material('练习册');
    const done = await harness.task('练习册 第3章 1-10 题', { materialRef: '练习册 P30' });
    const cancelled = await harness.task('练习册 第4章', { materialRef: '练习册 P40' });
    const plain = await harness.task('没有材料位置的任务');
    await harness.block(done.id, DAY, '09:00', '10:00');
    await harness.block(cancelled.id, DAY, '10:00', '11:00');
    await harness.block(plain.id, DAY, '11:00', '12:00');

    harness.clock.setLocal(2026, 11, 11, 8);
    await harness.taskProgress(done.id, 'done', DAY);
    await harness.taskProgress(cancelled.id, 'cancelled', DAY);
    await harness.taskProgress(plain.id, 'done', DAY);

    const result = await harness.outcomes('day', { date: DAY });
    assert.equal(result.materials.taskReferenceCount, 1);
    assert.equal(result.materials.taskReferences[0].taskId, done.id);
    assert.equal(result.materials.taskReferences[0].materialRef, '练习册 P30');
    assert.equal(result.materials.taskReferences[0].status, 'done');
    assert.equal(result.materials.advancedItemCount, 1);
    assert.equal(result.materials.distinctMaterialCount, 0, 'a task text reference is not a library material id');
    assert.equal(result.materials.items.length, 0);
    assert.ok(workbook.id);
    assert.equal(result.items.find(item => item.taskId === cancelled.id).status, 'cancelled');
  });

  it('reports no material progress when nothing advanced', async t => {
    const harness = await bootOutcomes(t, { clock: createClock(localInstant(2026, 11, 10, 8)) });
    const material = await harness.material('暂时没学的资料');
    const confirmed = await harness.plan([item({ id: 'm1', date: DAY, materialId: material.id })]);
    harness.clock.setLocal(2026, 11, 11, 8);
    await harness.planProgress(confirmed.planId, 'm1', 'not_started', DAY);

    const result = await harness.outcomes('day', { date: DAY });
    assert.equal(result.materials.advancedItemCount, 0);
    assert.equal(result.materials.distinctMaterialCount, 0);
    assert.deepEqual(result.materials.items, []);
    assert.equal(result.materials.taskReferenceCount, 0);
    assert.equal(result.completion.original.planned, 1);
    assert.equal(result.completion.original.completed, 0);
  });
});
