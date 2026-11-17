/**
 * T14 end-to-end path without a model: real `materials` / `tasks` / `plans` /
 * `outcomes` / `milestones` modules over SQLite, the client feed calling the
 * same service, and the overlay state that results. This is the evidence for
 * "existing milestones stay visible with no model available".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';
import { bootMilestones } from './helpers.mjs';

installReactStub();

const { RECORDED_KEY, SUMMARY_KEY, createMilestoneFeed } = await import('../../client/components/feedback.js');

/** In-memory Web Storage area. */
function memoryArea() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

/** Virtual clock plus a manual timer. */
function clock() {
  let current = 0;
  let sequence = 0;
  let queue = [];
  const timer = {
    setTimeout(callback, delay = 0) {
      sequence += 1;
      const handle = { id: sequence, at: current + delay, callback };
      queue.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      queue = queue.filter(candidate => candidate.id !== handle?.id);
    },
  };
  return {
    now: () => current,
    timer,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = queue.filter(handle => handle.at <= target).sort((left, right) => left.at - right.at)[0];
        if (due === undefined) break;
        queue = queue.filter(handle => handle !== due);
        current = due.at;
        due.callback();
      }
      current = target;
    },
    pending: () => queue.length,
  };
}

describe('milestones without a model', () => {
  it('shows a completion toast and the stage card from real stored records', async t => {
    const harness = await bootMilestones(t);
    const storage = memoryArea();
    const time = clock();
    const call = async (ns, method, payload) => {
      const envelope = await harness.call(ns, method, payload);
      if (envelope.ok !== true) throw new Error(envelope.message);
      return envelope;
    };
    const feed = createMilestoneFeed({
      call,
      storage,
      timer: time.timer,
      now: time.now,
      toastDurationMs: 1000,
      cardDurationMs: 5000,
    });

    await feed.pollFeedback();
    await feed.pollSummary();
    assert.deepEqual(feed.source.getSnapshot().toasts, []);
    assert.equal(feed.source.getSnapshot().card, null, '没有记录时不弹阶段小结');

    const { record } = await harness.doneTask('真实记录任务', '2026-11-10');
    await feed.pollFeedback();
    await feed.pollSummary();

    const state = feed.source.getSnapshot();
    const recordToast = state.toasts.find(entry => entry.type === 'record');
    assert.ok(recordToast, `缺少完成反馈：${JSON.stringify(state.toasts)}`);
    assert.equal(recordToast.title, '真实记录任务');
    const milestoneToast = state.toasts.find(entry => entry.type === 'milestone');
    assert.ok(milestoneToast);
    assert.equal(milestoneToast.id, 'week.first');

    assert.ok(state.card, '有记录后应显示本周小结');
    assert.equal(state.card.period, 'week');
    assert.equal(state.card.from, '2026-11-09');
    assert.ok(state.card.lines.some(line => line.key === 'noPlanned'), '未排计划要如实说明');
    const earned = state.card.earned.find(entry => entry.id === 'week.first');
    assert.ok(earned);
    assert.equal(earned.achievedOn, '2026-11-10');

    assert.equal(JSON.parse(storage.getItem(RECORDED_KEY)).tokens.includes(`task:${record.recordId}`), true);
    assert.equal(JSON.parse(storage.getItem(SUMMARY_KEY)).week, '2026-11-09');
    assert.deepEqual(harness.toolsRegistered, [], '这条路径不注册任何模型工具');

    time.advance(1000);
    assert.deepEqual(feed.source.getSnapshot().toasts, [], '提示条自动消失，不打断操作');
    feed.stop();
  });
});
