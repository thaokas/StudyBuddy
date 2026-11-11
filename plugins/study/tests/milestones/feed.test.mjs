/**
 * T14 client feed: local polling, the baseline rule, de-duplicated toasts and
 * cards, and the switch from a failing route to an explicit retry line.
 *
 * Every browser edge (storage, timer, clock) is injected, so no browser or
 * model is needed to prove that feedback never invents a completion.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';

installReactStub();

const {
  CARD_DURATION_MS, FEEDBACK_INTERVAL_MS, FEEDBACK_SLOT, LEDGER_LIMIT, MAX_TOAST_ITEMS,
  MILESTONES_KEY, RECORDED_KEY, SUMMARY_KEY, TOAST_DURATION_MS,
  createMilestoneFeed, installMilestoneFeedback,
} = await import('../../client/components/feedback.js');

/** In-memory Web Storage area. */
function memoryArea() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

/** Storage area whose reads and writes both throw, like a sandboxed frame. */
const BLOCKED_AREA = Object.freeze({
  getItem() { throw new Error('storage blocked'); },
  setItem() { throw new Error('storage blocked'); },
  removeItem() { throw new Error('storage blocked'); },
});

/** Virtual clock plus a manual timer, same shape the reminder tests use. */
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

/** Scripted route caller: one queued response per method call. */
function scriptedCall() {
  const calls = [];
  const queues = { feedback: [], overview: [] };
  const call = async (ns, method, payload) => {
    calls.push({ ns, method, payload });
    const queue = queues[method];
    if (queue === undefined) throw new Error(`unexpected study call ${ns}.${method}`);
    if (queue.length === 0) throw new Error(`no scripted response for ${ns}.${method}`);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return { ok: true, value: next, revision: 0 };
  };
  return {
    call,
    calls,
    feedback: value => queues.feedback.push(value),
    overview: value => queues.overview.push(value),
  };
}

/** One confirmed completion row. */
function completion(overrides = {}) {
  return {
    token: 'task:7',
    kind: 'task',
    recordId: 7,
    recordDate: '2026-11-10',
    title: '习题 1-10',
    subject: '数学',
    taskId: 'task_1',
    planId: null,
    itemId: null,
    quantityDone: null,
    quantityTotal: null,
    materialId: null,
    materialTitle: null,
    materialRef: null,
    planned: false,
    ...overrides,
  };
}

/** One `milestones.feedback` day document. */
function feedbackDocument(items) {
  return {
    scope: 'day',
    date: '2026-11-10',
    today: '2026-11-10',
    state: items.length === 0 ? 'empty' : 'ready',
    notice: null,
    count: items.length,
    items,
    latest: items.length === 0 ? null : items[items.length - 1],
    generatedAt: '2026-11-10T00:00:00.000Z',
  };
}

/** One earned milestone with evidence, as the host emits it. */
function milestone(overrides = {}) {
  return {
    id: 'week.first',
    period: 'week',
    title: '本周第一条完成记录',
    threshold: 1,
    count: 1,
    remaining: 0,
    achieved: true,
    achievedOn: '2026-11-10',
    text: '本周已确认完成 1 条记录，第 1 条记录于 2026-11-10。',
    evidence: { recordIds: [7] },
    ...overrides,
  };
}

/** One week/month stage document. */
function stage(period, overrides = {}) {
  return {
    period,
    from: period === 'week' ? '2026-11-09' : '2026-11-01',
    to: period === 'week' ? '2026-11-15' : '2026-11-30',
    scope: period,
    state: 'ready',
    notice: null,
    headline: period === 'week' ? '本周：计划 1 项，已确认完成 1 项，主动取消 0 项。' : '本月：计划 1 项，已确认完成 1 项，主动取消 0 项。',
    lines: [{ key: 'planned', values: { planned: 1, completed: 1, cancelled: 0, pending: 0, unrecorded: 0 }, text: 'HOST' }],
    milestones: [],
    earned: [],
    earnedCount: 0,
    next: null,
    counts: {
      totalUnits: 1, planned: 1, completed: 1, cancelled: 0, pending: 0, unrecorded: 0,
      recorded: 1, plannedRecorded: 1, rate: 1, originalPlanned: 1, originalCompleted: 1,
      originalRate: 1, unplanned: 0,
    },
    materials: { advancedItemCount: 0, distinctMaterialCount: 0, titles: [] },
    streak: { tracked: false, penalty: false, consecutive: null, resetOnMiss: false },
    source: { service: 'outcomes', method: period, from: '2026-11-09', to: '2026-11-15', generatedAt: '2026-11-10T00:00:00.000Z' },
    generatedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

/** One `milestones.overview` document. */
function overviewDocument(overrides = {}) {
  return {
    date: '2026-11-10',
    today: '2026-11-10',
    week: stage('week'),
    month: stage('month'),
    streak: { tracked: false, penalty: false, consecutive: null, resetOnMiss: false, text: '不计算连续打卡。' },
    policy: { badges: false, ranking: false, sharing: false, streakPenalty: false },
    generatedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

/** A feed over the virtual clock and one storage area. */
function buildFeed(system, storage, time, overrides = {}) {
  return createMilestoneFeed({
    call: system.call,
    storage,
    timer: time.timer,
    now: time.now,
    toastDurationMs: TOAST_DURATION_MS,
    cardDurationMs: CARD_DURATION_MS,
    ...overrides,
  });
}

describe('milestone feedback feed', () => {
  it('treats the first read as a baseline instead of announcing old completions', async () => {
    const system = scriptedCall();
    const time = clock();
    const storage = memoryArea();
    const feed = buildFeed(system, storage, time);

    system.feedback(feedbackDocument([completion()]));
    await feed.pollFeedback();

    const state = feed.source.getSnapshot();
    assert.equal(state.phase, 'ready');
    assert.deepEqual(state.toasts, []);
    assert.equal(system.calls.length, 1);
    assert.deepEqual(JSON.parse(storage.getItem(RECORDED_KEY)).tokens, ['task:7']);
  });

  it('announces a completion that appears after the baseline, once', async () => {
    const system = scriptedCall();
    const time = clock();
    const feed = buildFeed(system, memoryArea(), time);
    system.feedback(feedbackDocument([completion()]));
    await feed.pollFeedback();

    const second = completion({ token: 'plan:9', kind: 'plan', recordId: 9, title: '练习册 第1章', planId: 'plan_1', itemId: 'item_1' });
    system.feedback(feedbackDocument([completion(), second]));
    await feed.pollFeedback();
    let toasts = feed.source.getSnapshot().toasts;
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].token, 'record:plan:9');
    assert.equal(toasts[0].type, 'record');
    assert.equal(toasts[0].title, '练习册 第1章');

    system.feedback(feedbackDocument([completion(), second]));
    await feed.pollFeedback();
    toasts = feed.source.getSnapshot().toasts;
    assert.equal(toasts.length, 1, '重复轮询不能重复宣布');

    time.advance(TOAST_DURATION_MS);
    assert.deepEqual(feed.source.getSnapshot().toasts, []);
  });

  it('caps a toast group and clears it on dismiss', async () => {
    const system = scriptedCall();
    const time = clock();
    const feed = buildFeed(system, memoryArea(), time);
    system.feedback(feedbackDocument([]));
    await feed.pollFeedback();

    const fresh = Array.from({ length: 4 }, (_, index) => completion({
      token: `task:${100 + index}`,
      recordId: 100 + index,
      title: `任务 ${index + 1}`,
    }));
    system.feedback(feedbackDocument(fresh));
    await feed.pollFeedback();
    assert.equal(feed.source.getSnapshot().toasts.length, MAX_TOAST_ITEMS);

    feed.dismissToast();
    assert.deepEqual(feed.source.getSnapshot().toasts, []);
    assert.equal(time.pending(), 0, 'dismiss 取消自动消失计时器');
  });

  it('remembers announced rows across a reload through storage', async () => {
    const system = scriptedCall();
    const time = clock();
    const storage = memoryArea();
    const first = buildFeed(system, storage, time);
    system.feedback(feedbackDocument([]));
    await first.pollFeedback();
    system.feedback(feedbackDocument([completion()]));
    await first.pollFeedback();
    assert.equal(first.source.getSnapshot().toasts.length, 1);
    first.stop();

    const second = buildFeed(system, storage, time);
    system.feedback(feedbackDocument([completion()]));
    await second.pollFeedback();
    assert.deepEqual(second.source.getSnapshot().toasts, [], '刷新后既有的完成记录不再宣布');
  });

  it('shows a quiet error and recovers through retry', async () => {
    const system = scriptedCall();
    const time = clock();
    const feed = buildFeed(system, memoryArea(), time);
    system.feedback({ broken: true });
    await feed.pollFeedback();
    assert.equal(feed.source.getSnapshot().phase, 'error');
    assert.deepEqual(feed.source.getSnapshot().error, { scope: 'feedback', message: 'milestones.feedback returned no item list' });
    assert.deepEqual(feed.source.getSnapshot().toasts, []);

    system.feedback(feedbackDocument([]));
    system.overview(overviewDocument({
      week: stage('week', { counts: { recorded: 0, earnedCount: 0 } }),
      month: stage('month', { counts: { recorded: 0, earnedCount: 0 } }),
    }));
    await feed.retry();
    assert.equal(feed.source.getSnapshot().phase, 'ready');
    assert.equal(feed.source.getSnapshot().error, null);
  });

  it('shows the stage card once per period, after there is evidence', async () => {
    const system = scriptedCall();
    const time = clock();
    const feed = buildFeed(system, memoryArea(), time);

    system.overview(overviewDocument({
      week: stage('week', { counts: { ...stage('week').counts, recorded: 0 } }),
      month: stage('month', { counts: { ...stage('month').counts, recorded: 0 } }),
    }));
    await feed.pollSummary();
    assert.equal(feed.source.getSnapshot().card, null, '没有记录时不弹阶段小结');

    system.overview(overviewDocument());
    await feed.pollSummary();
    const card = feed.source.getSnapshot().card;
    assert.ok(card);
    assert.equal(card.period, 'week');
    assert.equal(card.from, '2026-11-09');

    system.overview(overviewDocument());
    await feed.pollSummary();
    assert.equal(feed.source.getSnapshot().card.key, card.key, '同一周期只显示一次');

    feed.dismissCard();
    system.overview(overviewDocument());
    await feed.pollSummary();
    assert.equal(feed.source.getSnapshot().card.period, 'month', '周卡片看过之后才轮到本月小结');
  });

  it('hides the card after its display window', async () => {
    const system = scriptedCall();
    const time = clock();
    const feed = buildFeed(system, memoryArea(), time);
    system.overview(overviewDocument());
    await feed.pollSummary();
    assert.ok(feed.source.getSnapshot().card);
    time.advance(CARD_DURATION_MS);
    assert.equal(feed.source.getSnapshot().card, null);
  });

  it('announces a newly earned milestone once and records it', async () => {
    const system = scriptedCall();
    const time = clock();
    const storage = memoryArea();
    const feed = buildFeed(system, storage, time);

    system.overview(overviewDocument({
      week: stage('week', { counts: { ...stage('week').counts, recorded: 0 } }),
      month: stage('month', { counts: { ...stage('month').counts, recorded: 0 } }),
    }));
    await feed.pollSummary();
    assert.deepEqual(feed.source.getSnapshot().toasts, []);

    const earned = milestone();
    system.overview(overviewDocument({
      week: stage('week', { earned: [earned], earnedCount: 1, milestones: [earned] }),
      month: stage('month', { earned: [earned], earnedCount: 1, milestones: [earned] }),
    }));
    await feed.pollSummary();
    const toasts = feed.source.getSnapshot().toasts;
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, 'milestone');
    assert.equal(toasts[0].id, 'week.first');
    assert.deepEqual(JSON.parse(storage.getItem(MILESTONES_KEY)).keys, ['week.first@2026-11-10']);

    system.overview(overviewDocument({
      week: stage('week', { earned: [earned], earnedCount: 1, milestones: [earned] }),
      month: stage('month', { earned: [earned], earnedCount: 1, milestones: [earned] }),
    }));
    await feed.pollSummary();
    assert.equal(feed.source.getSnapshot().toasts.length, 1, '同一里程碑不重复宣布');
  });

  it('keeps working without Web Storage', async () => {
    const system = scriptedCall();
    const time = clock();
    const feed = buildFeed(system, BLOCKED_AREA, time);
    system.feedback(feedbackDocument([]));
    await feed.pollFeedback();
    system.feedback(feedbackDocument([completion()]));
    await feed.pollFeedback();
    assert.equal(feed.source.getSnapshot().toasts.length, 1);
  });

  it('starts polling on the first subscriber and stops on the last', async () => {
    const system = scriptedCall();
    const time = clock();
    const feed = buildFeed(system, memoryArea(), time, {
      feedbackIntervalMs: 100,
      summaryIntervalMs: 200,
    });
    system.feedback(feedbackDocument([]));
    system.overview(overviewDocument({
      week: stage('week', { counts: { ...stage('week').counts, recorded: 0 } }),
      month: stage('month', { counts: { ...stage('month').counts, recorded: 0 } }),
    }));
    assert.equal(time.pending(), 0, '没有订阅者时不轮询');

    const unsubscribe = feed.source.subscribe(() => {});
    assert.equal(time.pending(), 2);
    time.advance(0);
    await Promise.resolve();
    assert.equal(system.calls.filter(call => call.method === 'feedback').length >= 1, true);

    unsubscribe();
    assert.equal(time.pending(), 0);
    const callsAfterStop = system.calls.length;
    time.advance(FEEDBACK_INTERVAL_MS);
    assert.equal(system.calls.length, callsAfterStop);
  });

  it('can restart polling after a remount', async () => {
    const system = scriptedCall();
    const time = clock();
    const feed = buildFeed(system, memoryArea(), time);
    system.feedback(feedbackDocument([]));
    system.overview(overviewDocument({
      week: stage('week', { counts: { ...stage('week').counts, recorded: 0 } }),
      month: stage('month', { counts: { ...stage('month').counts, recorded: 0 } }),
    }));
    const first = feed.source.subscribe(() => {});
    time.advance(0);
    await Promise.resolve();
    first();
    assert.equal(time.pending(), 0);

    system.feedback(feedbackDocument([]));
    system.overview(overviewDocument({
      week: stage('week', { counts: { ...stage('week').counts, recorded: 0 } }),
      month: stage('month', { counts: { ...stage('month').counts, recorded: 0 } }),
    }));
    const second = feed.source.subscribe(() => {});
    assert.equal(time.pending(), 2, '重新挂载后可以再次轮询');
    second();
    assert.equal(time.pending(), 0);
  });

  it('limits one ledger to the configured size', async () => {
    const system = scriptedCall();
    const time = clock();
    const storage = memoryArea();
    const feed = buildFeed(system, storage, time);
    system.feedback(feedbackDocument([]));
    await feed.pollFeedback();
    const many = Array.from({ length: LEDGER_LIMIT + 5 }, (_, index) => completion({ token: `task:${index + 1}`, recordId: index + 1 }));
    system.feedback(feedbackDocument(many));
    await feed.pollFeedback();
    assert.equal(JSON.parse(storage.getItem(RECORDED_KEY)).tokens.length, LEDGER_LIMIT);
  });

  it('notifies subscribers and disposes them on stop', async () => {
    const system = scriptedCall();
    const time = clock();
    const feed = buildFeed(system, memoryArea(), time);
    let seen = 0;
    const unsubscribe = feed.source.subscribe(() => { seen += 1; });
    system.feedback(feedbackDocument([]));
    await feed.pollFeedback();
    assert.ok(seen > 0);
    unsubscribe();
    feed.stop();
  });
});

describe('installMilestoneFeedback', () => {
  /**
   * Client context stand-in with the slot and effect faces the installer reads.
   * @returns {{ ctx: object, state: object }} Fake context and its ledger.
   */
  function createCtx() {
    const state = { entries: [], slotNames: [], effects: [] };
    const ctx = {
      effect(run) {
        const dispose = run();
        state.effects.push(dispose);
        return () => { if (typeof dispose === 'function') dispose(); };
      },
      slots: {
        inject(name, callback) {
          state.slotNames.push(name);
          const dispose = callback();
          return () => { if (typeof dispose === 'function') dispose(); };
        },
        register(options, component) {
          const entry = { options, component };
          state.entries.push(entry);
          return () => {
            const index = state.entries.indexOf(entry);
            if (index >= 0) state.entries.splice(index, 1);
          };
        },
      },
    };
    return { ctx, state };
  }

  /** A feed stub that records lifecycle calls instead of polling. */
  function feedStub() {
    const calls = [];
    const snapshot = { phase: 'ready', error: null, toasts: [], card: null };
    const feed = {
      source: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      start: () => calls.push('start'),
      stop: () => calls.push('stop'),
      dismissToast: () => calls.push('dismissToast'),
      dismissCard: () => calls.push('dismissCard'),
      retry: () => calls.push('retry'),
    };
    return { feed, calls };
  }

  it('registers one overlay entry and stops with the fiber', () => {
    const { ctx, state } = createCtx();
    const { feed, calls } = feedStub();
    const returned = installMilestoneFeedback(ctx, { namespace: 'study', call: async () => {}, feed });

    assert.equal(returned, feed);
    assert.deepEqual(state.slotNames, [FEEDBACK_SLOT]);
    const entry = state.entries[0];
    assert.equal(entry.options.name, FEEDBACK_SLOT);
    assert.equal(entry.options.locale, 'study');
    assert.equal(entry.options.id, 'study.milestones.feedback');
    const face = entry.options.inject();
    assert.equal(face.hooks.milestones, feed.source);
    assert.equal(typeof face.dismissToast, 'function');
    assert.equal(typeof face.dismissCard, 'function');
    assert.equal(typeof face.retry, 'function');
    assert.deepEqual(calls, [], '安装本身不启动轮询；叠加层挂载/订阅时才启动');

    for (const dispose of state.effects) if (typeof dispose === 'function') dispose();
    assert.deepEqual(calls, ['stop']);
  });

  it('rejects a missing dictionary namespace or route caller', () => {
    const { ctx } = createCtx();
    assert.throws(() => installMilestoneFeedback(ctx, { call: async () => {} }), /dictionary namespace/);
    assert.throws(() => installMilestoneFeedback(ctx, { namespace: 'study' }), /route caller/);
  });

  it('stays inert on a context without overlay slots', () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const { feed, calls } = feedStub();
      const returned = installMilestoneFeedback({ effect() {} }, { namespace: 'study', call: async () => {}, feed });
      assert.equal(returned, undefined);
      assert.deepEqual(calls, []);
    } finally {
      console.warn = warn;
    }
  });
});
