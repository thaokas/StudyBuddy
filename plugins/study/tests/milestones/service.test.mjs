/**
 * T14 milestones: the catalog, the evidence behind every earned milestone, and
 * the lightweight feedback feed. The invariants under test are that only
 * confirmed `done` records can earn a milestone, that cancelled/pending/
 * unrecorded work never does, and that the wording cites only counted records.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { item, items } from '../outcomes/helpers.mjs';
import { allMilestones, bootMilestones, bootMilestonesOnly, createClock, localInstant, storedDoneIds } from './helpers.mjs';

/** Words that would claim something the records do not show. */
const INFERENCE_WORDS = ['连续', '坚持', '每天', '一定', '肯定', '看来', '说明你', '你应该', '偷懒', '落后', '进步', '效率', '自律', '棒'];

/** All counters used by the service, for a read-only check. */
async function readCounters(harness) {
  return {
    revision: harness.kernel.revision(),
    changes: Number(harness.database.get('SELECT COUNT(*) AS count FROM change_log').count),
    requests: Number(harness.database.get('SELECT COUNT(*) AS count FROM request_log').count),
    snapshots: Number(harness.database.get('SELECT COUNT(*) AS count FROM day_snapshot').count),
  };
}

describe('milestones service contract', () => {
  it('registers one read-only namespace and no model tool', async t => {
    const harness = await bootMilestones(t);
    const entry = harness.registry.list().find(candidate => candidate.ns === 'milestones');
    assert.ok(entry);
    assert.deepEqual(entry.methods, ['feedback', 'overview']);
    assert.deepEqual(entry.writes, []);
    assert.deepEqual(harness.toolsRegistered, [], 'milestones 不注册任何模型工具');
  });

  it('reports an empty period without fabricating a rate or an achievement', async t => {
    const harness = await bootMilestones(t);
    const value = await harness.overview();

    assert.equal(value.date, '2026-11-10');
    assert.equal(value.today, '2026-11-10');
    assert.deepEqual([value.week.from, value.week.to], ['2026-11-09', '2026-11-15']);
    assert.deepEqual([value.month.from, value.month.to], ['2026-11-01', '2026-11-30']);
    for (const stage of [value.week, value.month]) {
      assert.equal(stage.state, 'empty');
      assert.equal(stage.earnedCount, 0);
      assert.equal(stage.milestones.length, 5);
      assert.equal(stage.counts.planned, 0);
      assert.equal(stage.counts.rate, null);
      assert.deepEqual(stage.earned, []);
    }
    assert.equal(value.week.next.id, 'week.first');
    assert.equal(value.week.next.count, 0);
    assert.equal(value.week.next.remaining, 1);

    const feedback = await harness.feedback();
    assert.equal(feedback.count, 0);
    assert.deepEqual(feedback.items, []);
    assert.equal(feedback.latest, null);
    assert.equal(feedback.state, 'empty');
  });

  it('earns the first completion milestone from the stored record it cites', async t => {
    const harness = await bootMilestones(t);
    const { record } = await harness.doneTask('习题 1-10', '2026-11-10', { task: { subject: '数学' } });
    const value = await harness.overview();

    const first = value.week.milestones.find(milestone => milestone.id === 'week.first');
    assert.equal(first.achieved, true);
    assert.equal(first.achievedOn, '2026-11-10');
    assert.equal(first.count, 1);
    assert.equal(first.remaining, 0);
    assert.deepEqual(first.evidence.recordIds, [record.recordId]);
    assert.deepEqual(first.evidence.recordDates, ['2026-11-10']);
    assert.deepEqual(first.evidence.titles, ['习题 1-10']);
    assert.deepEqual(first.evidence.period, { from: '2026-11-09', to: '2026-11-15' });
    assert.ok(first.text.includes('1'), '文案要引用真实条数');

    const three = value.week.milestones.find(milestone => milestone.id === 'week.three');
    assert.equal(three.achieved, false);
    assert.equal(three.count, 1);
    assert.equal(three.remaining, 2);
    assert.equal(three.achievedOn, null);
    assert.ok(three.text.includes('2'), '未达成的文案引用还差多少条');
    assert.equal(value.week.next.id, 'week.three');

    assert.equal(value.month.milestones.find(milestone => milestone.id === 'month.first').achieved, true);
    assert.equal(value.month.milestones.find(milestone => milestone.id === 'month.ten').achieved, false);

    const feedback = await harness.feedback();
    assert.equal(feedback.count, 1);
    assert.equal(feedback.items[0].token, `task:${record.recordId}`);
    assert.equal(feedback.items[0].kind, 'task');
    assert.equal(feedback.items[0].recordId, record.recordId);
    assert.equal(feedback.items[0].title, '习题 1-10');
    assert.equal(feedback.items[0].recordDate, '2026-11-10');
    assert.equal(feedback.items[0].planned, false, '没有时间块/计划条目的完成记录要如实标注未排计划');
    assert.deepEqual(feedback.latest, feedback.items[0]);
  });

  it('never counts a cancellation, a pending record, or a partial record as an achievement', async t => {
    const harness = await bootMilestones(t);
    const plan = await harness.plan(items(3, { date: '2026-11-10' }));
    await harness.planProgress(plan.planId, 'item_1', 'cancelled', '2026-11-10');
    await harness.planProgress(plan.planId, 'item_2', 'done', '2026-11-10', { confirmed: false });
    await harness.planProgress(plan.planId, 'item_3', 'partial', '2026-11-10', { quantityDone: 3, quantityTotal: 10 });
    await harness.taskProgress((await harness.task('未开始的作业')).id, 'not_started', '2026-11-10');

    const value = await harness.overview();
    assert.equal(allMilestones(value).filter(milestone => milestone.achieved).length, 0);
    assert.equal(value.week.counts.completed, 0);
    assert.equal(value.week.counts.cancelled, 1);
    assert.equal(value.week.counts.pending, 1);
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.first').count, 0);
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.plan').count, 0);
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.material').count, 0);
    assert.equal((await harness.feedback()).count, 0);
  });

  it('drops an achievement when the latest record is a cancellation', async t => {
    const harness = await bootMilestones(t);
    const { task } = await harness.doneTask('第二章习题', '2026-11-10');
    let value = await harness.overview();
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.first').achieved, true);

    await harness.taskProgress(task.id, 'cancelled', '2026-11-10', { note: '今天不做了' });
    value = await harness.overview();
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.first').achieved, false);
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.first').count, 0);
    assert.equal((await harness.feedback()).count, 0, '取消之后不再作为完成反馈');
  });

  it('uses the record date of the crossing entry for achievedOn, not the query time', async t => {
    const harness = await bootMilestones(t);
    const late = await harness.doneTask('A 晚记录', '2026-11-11');
    const early = await harness.doneTask('B 早记录', '2026-11-10');
    const last = await harness.doneTask('C 更晚记录', '2026-11-12');
    const value = await harness.overview();
    const three = value.week.milestones.find(milestone => milestone.id === 'week.three');

    assert.equal(three.achieved, true);
    assert.equal(three.count, 3);
    assert.equal(three.achievedOn, '2026-11-12');
    assert.deepEqual(three.evidence.recordIds, [early.record.recordId, late.record.recordId, last.record.recordId]);
    assert.deepEqual(three.evidence.recordDates, ['2026-11-10', '2026-11-11', '2026-11-12']);
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.five').achieved, false);
  });

  it('counts plan items separately and leaves the task-only milestone independent', async t => {
    const harness = await bootMilestones(t);
    const plan = await harness.plan(items(2, { date: '2026-11-10' }));
    const record = await harness.donePlanItem(plan, 'item_1', '2026-11-10');

    const value = await harness.overview();
    const planMilestone = value.week.milestones.find(milestone => milestone.id === 'week.plan');
    assert.equal(planMilestone.achieved, true);
    assert.equal(planMilestone.count, 1);
    assert.deepEqual(planMilestone.evidence.recordIds, [record.id]);
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.first').count, 1);
    assert.equal(value.month.milestones.find(milestone => milestone.id === 'month.plan').count, 1);
    assert.equal(value.month.milestones.find(milestone => milestone.id === 'month.plan').remaining, 2);

    const feedback = await harness.feedback();
    assert.equal(feedback.items[0].kind, 'task');
    assert.equal(feedback.items[0].planId, plan.planId);
    assert.equal(feedback.items[0].itemId, 'item_1');
  });

  it('counts library materials by id and does not map a task materialRef to one', async t => {
    const harness = await bootMilestones(t);
    const material = await harness.material('数学练习册');
    const plan = await harness.plan([item({ id: 'item_1', materialId: material.id, date: '2026-11-10' })]);
    await harness.donePlanItem(plan, 'item_1', '2026-11-10');
    await harness.doneTask('只写了材料位置的任务', '2026-11-10', { task: { materialRef: '练习册 P30' } });

    const value = await harness.overview();
    const materialMilestone = value.week.milestones.find(milestone => milestone.id === 'week.material');
    assert.equal(materialMilestone.achieved, true);
    assert.equal(materialMilestone.count, 1);
    assert.deepEqual(materialMilestone.evidence.titles, ['数学练习册']);
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.three').count, 2);
    assert.equal(value.month.milestones.find(milestone => milestone.id === 'month.material').count, 1);
  });

  it('accumulates the month across weeks while the week stays inside its own bounds', async t => {
    const harness = await bootMilestones(t);
    for (const date of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']) {
      await harness.doneTask(`上周记录 ${date}`, date);
    }
    for (const date of ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']) {
      await harness.doneTask(`本周记录 ${date}`, date);
    }

    const value = await harness.overview();
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.first').count, 5);
    assert.equal(value.week.milestones.find(milestone => milestone.id === 'week.five').achieved, true);
    assert.equal(value.month.milestones.find(milestone => milestone.id === 'month.ten').achieved, true);
    assert.equal(value.month.milestones.find(milestone => milestone.id === 'month.ten').achievedOn, '2026-11-13');
    assert.equal(value.month.milestones.find(milestone => milestone.id === 'month.twenty').achieved, false);
    assert.equal(value.month.milestones.find(milestone => milestone.id === 'month.twenty').count, 10);
  });

  it('carries no streak counters and no punitive or social features', async t => {
    const harness = await bootMilestones(t);
    await harness.doneTask('有记录的任务', '2026-11-10');
    const value = await harness.overview();

    assert.deepEqual(
      { tracked: value.streak.tracked, penalty: value.streak.penalty, consecutive: value.streak.consecutive, resetOnMiss: value.streak.resetOnMiss },
      { tracked: false, penalty: false, consecutive: null, resetOnMiss: false },
    );
    assert.match(value.streak.text, /不计算连续打卡/);
    assert.deepEqual(
      { badges: value.policy.badges, ranking: value.policy.ranking, sharing: value.policy.sharing, streakPenalty: value.policy.streakPenalty },
      { badges: false, ranking: false, sharing: false, streakPenalty: false },
    );
    const text = JSON.stringify(value);
    assert.equal(text.includes('"currentStreak"'), false);
    assert.equal(text.includes('"bestStreak"'), false);
    assert.equal(value.week.milestones.every(milestone => !milestone.id.includes('streak')), true);
  });

  it('writes milestone copy that cites only counted records', async t => {
    const harness = await bootMilestones(t);
    const plan = await harness.plan([item({ id: 'item_1', date: '2026-11-10' })]);
    await harness.donePlanItem(plan, 'item_1', '2026-11-10');
    await harness.doneTask('任务 A', '2026-11-10');
    await harness.doneTask('任务 B', '2026-11-11');
    await harness.doneTask('任务 C', '2026-11-12');
    const value = await harness.overview();
    const stored = storedDoneIds(harness);
    const knownIds = new Set([...stored.tasks, ...stored.plans]);

    for (const milestone of allMilestones(value)) {
      assert.equal(typeof milestone.title, 'string');
      assert.ok(milestone.title.length > 0);
      assert.equal(typeof milestone.text, 'string');
      assert.ok(milestone.text.length > 0);
      for (const word of INFERENCE_WORDS) {
        assert.equal(milestone.title.includes(word), false, `标题不能出现推断词 ${word}：${milestone.title}`);
        assert.equal(milestone.text.includes(word), false, `文案不能出现推断词 ${word}：${milestone.text}`);
      }
      if (milestone.achieved) {
        assert.ok(milestone.text.includes(String(milestone.count)), '已达成文案必须引用真实条数');
        assert.ok(milestone.text.includes(milestone.achievedOn), '已达成文案必须引用达成日期');
        assert.ok(milestone.evidence.recordIds.length > 0);
        for (const recordId of milestone.evidence.recordIds) assert.equal(knownIds.has(recordId), true, `证据引用不存在的记录 ${recordId}`);
        assert.ok(milestone.evidence.titles.length > 0);
        assert.equal(milestone.remaining, 0);
      } else {
        assert.equal(milestone.achievedOn, null);
        assert.ok(milestone.text.includes(String(milestone.remaining)));
      }
    }
  });

  it('reads without writing and returns the same milestones after a restart', async t => {
    const clock = createClock(localInstant(2026, 11, 10, 8));
    const harness = await bootMilestones(t, { clock, cleanup: false });
    const { record } = await harness.doneTask('重启前完成', '2026-11-10');
    const before = await readCounters(harness);
    const firstValue = await harness.overview();
    await harness.feedback();
    await harness.overview({ date: '2026-11-10' });
    const after = await readCounters(harness);
    assert.deepEqual(after, before, '里程碑与反馈只读，不写 revision/change_log/request_log/快照');

    await harness.close();
    const reopened = await bootMilestones(t, { directory: harness.directory, clock: clock });
    try {
      const value = await reopened.overview();
      const first = value.week.milestones.find(milestone => milestone.id === 'week.first');
      assert.equal(first.achieved, true);
      assert.equal(first.achievedOn, '2026-11-10');
      assert.deepEqual(first.evidence.recordIds, [record.recordId]);
      assert.deepEqual(
        value.week.lines.map(line => line.key),
        firstValue.week.lines.map(line => line.key),
        '重启前后的阶段小结结构一致',
      );
    } finally {
      await reopened.close();
      await rm(harness.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects a malformed date instead of guessing a period', async t => {
    const harness = await bootMilestones(t);
    const overview = await harness.fail('milestones', 'overview', { date: '2026-13-01' });
    assert.equal(overview.code, 'invalid');
    const feedback = await harness.fail('milestones', 'feedback', { date: 'not-a-date' });
    assert.equal(feedback.code, 'invalid');
  });

  it('reports an unavailable dependency instead of an empty period', async t => {
    const harness = await bootMilestonesOnly(t);
    for (const method of ['overview', 'feedback']) {
      const envelope = await harness.call('milestones', method, {});
      assert.equal(envelope.ok, false);
      assert.equal(envelope.code, 'unavailable');
      assert.equal(envelope.details.service, 'outcomes');
    }
  });
});
