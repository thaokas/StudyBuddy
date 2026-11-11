/**
 * T12 client evidence: the merged reminder card, its four quick replies,
 * quiet/focus/disabled states, the evening review's preview/committed/pending
 * states, the settings form, the shell banner, and the feed's claim/answer
 * lifecycle. React is replaced with the shared element stub, so these tests
 * inspect the rendered tree without a DOM.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';

installReactStub();

const {
  RemindersView,
  ReminderCardView,
  ReviewCardView,
  SettingsView,
  RemindersBannerView,
  createReminderFeed,
  installFollowupReminders,
  settingsDraftOf,
  validateSettingsDraft,
} = await import('../../client/pages/reminders.js');
const { mergeMessages } = await import('../../client/lib/definitions.js');
const common = (await import('../../client/messages/common.js')).default;
const reminders = (await import('../../client/messages/reminders.js')).default;
const dictionary = mergeMessages([{ file: 'common', dictionary: common }, { file: 'reminders', dictionary: reminders }]);

/**
 * Translate one key with the real dictionary.
 * @param {string} key - Key.
 * @param {object} [params] - Placeholders.
 * @returns {string} Copy.
 */
function t(key, params) {
  const template = dictionary.zh[key] ?? dictionary.en[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/**
 * Walk one rendered element tree.
 * @param {unknown} node - Element, array, text, or null.
 * @param {(node: object) => void} visit - Visitor for element nodes.
 */
function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** Find one element by `data-testid`. */
function byTestId(tree, id) {
  let found = null;
  walk(tree, (node) => {
    if (found === null && node.props?.['data-testid'] === id) found = node;
  });
  return found;
}

/** Every element carrying one `data-testid`. */
function allByTestId(tree, id) {
  const found = [];
  walk(tree, (node) => {
    if (node.props?.['data-testid'] === id) found.push(node);
  });
  return found;
}

/** Flatten an element tree to display text. */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children ?? []).map(textOf).join('');
}

const ITEM_A = {
  key: 'task:a:2026-11-10:morning',
  taskId: 'task-a',
  title: '数学练习',
  date: '2026-11-10',
  period: 'morning',
  start: '09:00',
  end: '09:30',
  minutes: 30,
  blocks: [],
  overdueMinutes: 20,
  state: 'new',
  askedAt: null,
  snoozeUntil: null,
};
const ITEM_B = {
  ...ITEM_A,
  key: 'task:b:2026-11-10:morning',
  taskId: 'task-b',
  title: '英语单词',
  start: '09:10',
  end: '09:40',
  overdueMinutes: 10,
};
const READY_FEED = {
  phase: 'ready',
  items: [ITEM_A, ITEM_B],
  deferred: [],
  pausedReason: null,
  error: null,
  actionError: null,
  busy: false,
  due: {
    period: 'morning',
    quiet: { active: false, start: '22:00', end: '07:00', until: null },
    focus: { active: false, sessionId: null, until: null },
    pausedPendingCount: 0,
    review: { due: false, at: '21:30', enabled: true, status: 'pending', last: null },
  },
};
const READY_SETTINGS = {
  phase: 'ready',
  value: {
    enabled: true,
    quietStart: '22:00',
    quietEnd: '07:00',
    reviewAt: '21:30',
    reviewEnabled: true,
    snoozeMinutes: 10,
  },
  error: null,
};
const PREVIEW = {
  phase: 'preview',
  value: {
    status: 'ready',
    planId: 'plan-1',
    baseRevision: 1,
    date: '2026-11-10',
    proposal: {
      moves: [{
        itemId: 'item-a', title: '部分完成', fromDate: '2026-11-10', toDate: '2026-11-11', minutes: 30, start: '19:00', end: '19:30',
      }],
      unscheduled: [{
        itemId: 'item-b', title: '大任务', fromDate: '2026-11-10', minutes: 60, reason: 'capacity',
      }],
      kept: [{ itemId: 'item-c', title: '未记录', reason: 'unrecorded' }],
      explanations: ['后续 7 天装不下这 1 项共 60 分钟，已保留为未安排。'],
      days: [],
    },
    summary: {
      remainingItems: 2,
      remainingMinutes: 90,
      movedItems: 1,
      movedMinutes: 30,
      unscheduledItems: 1,
      unscheduledMinutes: 60,
      keptItems: 1,
    },
  },
  message: null,
  due: true,
  at: '21:30',
};

/** Render the whole page from one state. */
function page(overrides = {}) {
  return RemindersView({
    create: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    t,
    feed: READY_FEED,
    settings: READY_SETTINGS,
    draft: settingsDraftOf(READY_SETTINGS.value),
    review: { phase: 'idle', value: null, message: null, due: false, at: '21:30' },
    notice: null,
    busy: false,
    onRefresh: () => {},
    onAnswer: () => {},
    onSnooze: () => {},
    onDraft: () => {},
    onSaveSettings: () => {},
    onToggleDraft: () => {},
    onReview: () => {},
    onSaveReview: () => {},
    ...overrides,
  });
}

/** Render the review card directly. */
function reviewCard(review, props = {}) {
  return ReviewCardView({
    create: (type, properties, ...children) => ({ type, props: properties ?? {}, children }),
    t,
    review,
    busy: false,
    onReview: () => {},
    onSaveReview: () => {},
    ...props,
  });
}

/** Fake interval owner for the feed tests. */
function fakeTimer() {
  const handles = new Map();
  let next = 1;
  return {
    setInterval(callback, ms) {
      const id = next;
      next += 1;
      handles.set(id, { callback, ms });
      return id;
    },
    clearInterval(id) {
      handles.delete(id);
    },
    get size() {
      return handles.size;
    },
    fire() {
      for (const { callback } of handles.values()) callback();
    },
  };
}

/** One success envelope. */
function ok(value) {
  return { ok: true, value, revision: 1 };
}

describe('reminder card view', () => {
  it('merges two due tasks into one card with all four quick replies', () => {
    const answers = [];
    const snoozes = [];
    const tree = ReminderCardView({
      create: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      t,
      items: [ITEM_A, ITEM_B],
      busy: false,
      onAnswer: (key, reply) => { answers.push([key, reply]); },
      onSnooze: key => { snoozes.push(key); },
    });
    assert.match(textOf(tree), /2 项任务到点了/);
    assert.match(textOf(tree), /数学练习/);
    assert.match(textOf(tree), /英语单词/);
    assert.ok(byTestId(tree, 'followup-reminder-card'));
    assert.equal(allByTestId(tree, `followup-answer-${ITEM_A.key}-done`).length, 1);
    assert.equal(allByTestId(tree, `followup-answer-${ITEM_A.key}-partial`).length, 1);
    assert.equal(allByTestId(tree, `followup-answer-${ITEM_A.key}-not_done`).length, 1);
    assert.equal(allByTestId(tree, `followup-later-${ITEM_A.key}`).length, 1);

    byTestId(tree, `followup-answer-${ITEM_A.key}-done`).props.onClick();
    byTestId(tree, `followup-answer-${ITEM_A.key}-partial`).props.onClick();
    byTestId(tree, `followup-answer-${ITEM_A.key}-not_done`).props.onClick();
    byTestId(tree, `followup-later-${ITEM_A.key}`).props.onClick();
    assert.deepEqual(answers, [
      [ITEM_A.key, 'done'],
      [ITEM_A.key, 'partial'],
      [ITEM_A.key, 'not_done'],
    ]);
    assert.deepEqual(snoozes, [ITEM_A.key]);
  });
});

describe('reminders page view', () => {
  it('renders the merged card and the settings form in the ready state', () => {
    const tree = page();
    assert.ok(byTestId(tree, 'followup-reminder-card'));
    assert.equal(allByTestId(tree, 'followup-reminder-card').length, 1, 'two items share one card');
    assert.ok(byTestId(tree, 'followup-settings'));
    assert.ok(byTestId(tree, 'followup-toggle-enabled'));
    assert.ok(byTestId(tree, 'followup-toggle-reviewEnabled'));
    assert.ok(byTestId(tree, 'followup-field-quietStart'));
    assert.ok(byTestId(tree, 'followup-field-quietEnd'));
    assert.ok(byTestId(tree, 'followup-field-reviewAt'));
    assert.ok(byTestId(tree, 'followup-settings-save'));
    assert.ok(byTestId(tree, 'followup-review'));
  });

  it('states quiet, focus, and disabled postponement without a due card', () => {
    const quiet = page({
      feed: {
        ...READY_FEED,
        items: [],
        pausedReason: 'quiet',
        deferred: [ITEM_A],
        due: { ...READY_FEED.due, quiet: { active: true, start: '12:00', end: '13:00', until: '2026-11-10T05:00:00.000Z' }, pausedPendingCount: 1 },
      },
    });
    assert.ok(byTestId(quiet, 'followup-paused-quiet'));
    assert.match(textOf(quiet), /静默时段/);
    assert.match(textOf(quiet), /1 项已到点/);
    assert.equal(byTestId(quiet, 'followup-reminder-card'), null);

    const focus = page({
      feed: {
        ...READY_FEED,
        items: [],
        pausedReason: 'focus',
        deferred: [ITEM_A],
        due: { ...READY_FEED.due, focus: { active: true, sessionId: 'timer-1', until: '2026-11-10T01:00:00.000Z' } },
      },
    });
    assert.ok(byTestId(focus, 'followup-paused-focus'));
    assert.match(textOf(focus), /专注计时中/);

    const disabled = page({
      feed: { ...READY_FEED, items: [], pausedReason: 'disabled' },
      settings: { ...READY_SETTINGS, value: { ...READY_SETTINGS.value, enabled: false } },
    });
    assert.ok(byTestId(disabled, 'followup-paused-disabled'));
  });

  it('shows an empty state, a read error, and a failed quick-reply notice', () => {
    const empty = page({ feed: { ...READY_FEED, items: [] } });
    assert.ok(byTestId(empty, 'followup-empty'));

    const failed = page({ feed: { ...READY_FEED, phase: 'error', error: '离线' } });
    assert.ok(byTestId(failed, 'followup-error'));
    assert.match(textOf(failed), /离线/);

    const actionFailed = page({ feed: { ...READY_FEED, actionError: '进度写入失败' } });
    assert.ok(byTestId(actionFailed, 'followup-action-error'));
    assert.match(textOf(actionFailed), /进度写入失败/);
  });

  it('asks for a manual save when the review is due', () => {
    const tree = page({
      review: { phase: 'idle', value: null, message: null, due: true, at: '21:30' },
    });
    assert.match(textOf(tree), /晚间复盘时间到了/);
    assert.ok(byTestId(tree, 'followup-review-start'));
  });
});

describe('evening review view', () => {
  it('renders the proposal with moves, unscheduled leftovers, and explanations', () => {
    const tree = reviewCard(PREVIEW);
    assert.ok(byTestId(tree, 'followup-review-preview'));
    assert.match(textOf(tree), /剩余 2 项/);
    assert.match(textOf(tree), /部分完成：2026-11-10 → 2026-11-11/);
    assert.match(textOf(tree), /大任务：60 分钟（后续日期没有容量）/);
    assert.match(textOf(tree), /装不下/);
    assert.ok(byTestId(tree, 'followup-review-save'));
  });

  it('calls the save callback and never shows success before the commit', () => {
    let saves = 0;
    const tree = reviewCard(PREVIEW, { onSaveReview: () => { saves += 1; } });
    byTestId(tree, 'followup-review-save').props.onClick();
    assert.equal(saves, 1);
    assert.equal(byTestId(tree, 'followup-review-committed'), null);
  });

  it('shows the committed summary only for a committed result', () => {
    const tree = reviewCard({
      phase: 'committed',
      value: { planRevision: 4, summary: { movedItems: 1, movedMinutes: 30, unscheduledItems: 1, unscheduledMinutes: 60 } },
      message: null,
      due: true,
      at: '21:30',
    });
    assert.ok(byTestId(tree, 'followup-review-committed'));
    assert.match(textOf(tree), /已保存计划修订 4/);
    assert.match(textOf(tree), /移动 1 项共 30 分钟/);
  });

  it('shows needs-adjustment instead of success when the save was rejected', () => {
    const tree = reviewCard({
      phase: 'needs_adjustment',
      value: { message: '任务顺序不允许这次调整：……' },
      message: '任务顺序不允许这次调整：……',
      due: true,
      at: '21:30',
    });
    assert.ok(byTestId(tree, 'followup-review-adjust'));
    assert.match(textOf(tree), /待调整/);
    assert.equal(byTestId(tree, 'followup-review-committed'), null);
  });

  it('explains a manual draft, an unconfirmed plan, and a missing plan', () => {
    const draft = reviewCard({ phase: 'blocked', value: { reason: 'draft_pending' }, message: 'draft_pending', due: true, at: '21:30' });
    assert.ok(byTestId(draft, 'followup-review-blocked'));
    assert.match(textOf(draft), /手动草案/);

    const unconfirmed = reviewCard({ phase: 'blocked', value: { reason: 'plan_not_confirmed' }, message: 'plan_not_confirmed', due: true, at: '21:30' });
    assert.match(textOf(unconfirmed), /计划尚未确认/);

    const none = reviewCard({ phase: 'no_plan', value: { status: 'no_plan' }, message: 'no_plan', due: true, at: '21:30' });
    assert.ok(byTestId(none, 'followup-review-no-plan'));

    const nothing = reviewCard({ phase: 'nothing_to_do', value: { status: 'nothing_to_do' }, message: 'nothing_to_do', due: true, at: '21:30' });
    assert.ok(byTestId(nothing, 'followup-review-nothing'));
  });
});

describe('settings view', () => {
  it('edits and saves the reminder settings', () => {
    const changes = [];
    let saves = 0;
    const draft = settingsDraftOf(READY_SETTINGS.value);
    const tree = SettingsView({
      create: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      t,
      settings: READY_SETTINGS,
      draft,
      busy: false,
      onDraft: (field, value) => { changes.push([field, value]); },
      onToggle: field => { changes.push([field, 'toggle']); },
      onSave: () => { saves += 1; },
    });
    byTestId(tree, 'followup-toggle-enabled').props.onClick();
    byTestId(tree, 'followup-toggle-reviewEnabled').props.onClick();
    byTestId(tree, 'followup-field-quietStart').props.onChange({ target: { value: '23:00' } });
    byTestId(tree, 'followup-settings-save').props.onClick();
    assert.deepEqual(changes, [
      ['enabled', 'toggle'],
      ['reviewEnabled', 'toggle'],
      ['quietStart', '23:00'],
    ]);
    assert.equal(saves, 1);
  });

  it('offers the learning-notification permission until it is granted', () => {
    let requested = 0;
    const tree = SettingsView({
      create: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      t,
      settings: READY_SETTINGS,
      draft: settingsDraftOf(READY_SETTINGS.value),
      busy: false,
      notificationPermission: 'default',
      onDraft: () => {},
      onToggle: () => {},
      onSave: () => {},
      onEnableNotifications: () => { requested += 1; },
    });
    byTestId(tree, 'followup-enable-notifications').props.onClick();
    assert.equal(requested, 1);
    const granted = SettingsView({
      create: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      t,
      settings: READY_SETTINGS,
      draft: settingsDraftOf(READY_SETTINGS.value),
      busy: false,
      notificationPermission: 'granted',
      onDraft: () => {},
      onToggle: () => {},
      onSave: () => {},
      onEnableNotifications: () => {},
    });
    assert.equal(byTestId(granted, 'followup-enable-notifications'), null);
  });

  it('validates times and the snooze length', () => {
    const valid = validateSettingsDraft({
      enabled: true, reviewEnabled: false, quietStart: '22:00', quietEnd: '07:00', reviewAt: '21:30', snoozeMinutes: '10',
    });
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.value, {
      enabled: true, reviewEnabled: false, quietStart: '22:00', quietEnd: '07:00', reviewAt: '21:30', snoozeMinutes: 10,
    });
    assert.equal(validateSettingsDraft({ ...valid.value, quietStart: '25:00' }).ok, false);
    assert.equal(validateSettingsDraft({ ...valid.value, snoozeMinutes: '0' }).ok, false);
    assert.equal(validateSettingsDraft({ ...valid.value, snoozeMinutes: '121' }).ok, false);
    assert.equal(validateSettingsDraft({ ...valid.value, snoozeMinutes: '1.5' }).ok, false);
  });
});

describe('shell banner view', () => {
  it('renders the merged card and the open/dismiss actions', () => {
    let opened = 0;
    let dismissed = 0;
    const tree = RemindersBannerView({
      create: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      t,
      state: READY_FEED,
      openPage: () => { opened += 1; },
      onAnswer: () => {},
      onSnooze: () => {},
      onDismiss: () => { dismissed += 1; },
    });
    assert.ok(byTestId(tree, 'study-followup-banner'));
    assert.ok(byTestId(tree, 'followup-banner-card'));
    byTestId(tree, 'followup-banner-open').props.onClick();
    byTestId(tree, 'followup-banner-dismiss').props.onClick();
    assert.equal(opened, 1);
    assert.equal(dismissed, 1);
  });

  it('nudges the evening review when no reminder is due', () => {
    const tree = RemindersBannerView({
      create: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      t,
      state: {
        ...READY_FEED,
        items: [],
        due: { ...READY_FEED.due, review: { due: true, at: '21:30', status: 'pending' } },
      },
      openPage: () => {},
      onAnswer: () => {},
      onSnooze: () => {},
      onDismiss: () => {},
    });
    assert.match(textOf(tree), /晚间复盘时间到了/);
  });

  it('shows the startup recovery summary and lets the student dismiss it', () => {
    let dismissed = 0;
    const tree = RemindersBannerView({
      create: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      t,
      state: {
        ...READY_FEED,
        items: [],
        due: { ...READY_FEED.due, review: { due: false, at: '21:30', status: 'pending' } },
        recovery: {
          scheduling: { status: 'degraded' },
          lastReview: { status: 'needs_adjustment' },
          pending: [{ key: 'block:b1' }],
          pendingConfirmation: [{ taskId: 'task-a' }],
          reviewDecision: 'manual_confirmation',
        },
      },
      openPage: () => {},
      onAnswer: () => {},
      onSnooze: () => {},
      onDismiss: () => { dismissed += 1; },
    });
    assert.ok(byTestId(tree, 'followup-recovery'));
    byTestId(tree, 'followup-recovery-dismiss').props.onClick();
    assert.equal(dismissed, 1);
  });

  it('stays quiet while paused, loading, or empty', () => {
    const base = {
      create: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      t,
      openPage: () => {},
      onAnswer: () => {},
      onSnooze: () => {},
      onDismiss: () => {},
    };
    assert.equal(RemindersBannerView({ ...base, state: { ...READY_FEED, pausedReason: 'focus' } }), null);
    assert.equal(RemindersBannerView({ ...base, state: { ...READY_FEED, phase: 'loading' } }), null);
    assert.equal(RemindersBannerView({ ...base, state: { ...READY_FEED, items: [], due: null } }), null);
  });
});

describe('reminder feed', () => {
  it('claims new items, then keeps them pending without a second claim', async () => {
    const calls = [];
    let dueCount = 0;
    const feed = createReminderFeed({
      call: async (ns, method, payload) => {
        calls.push({ ns, method, payload });
        if (method === 'due') {
          dueCount += 1;
          return ok(dueCount === 1
            ? { newItems: [ITEM_A, ITEM_B], pendingItems: [], deferredItems: [], pausedReason: null, review: READY_FEED.due.review, date: '2026-11-10' }
            : { newItems: [], pendingItems: [ITEM_A, ITEM_B], deferredItems: [], pausedReason: null, review: READY_FEED.due.review, date: '2026-11-10' });
        }
        if (method === 'claim') {
          return ok({ claimed: [ITEM_A, ITEM_B].filter(item => payload.keys.includes(item.key)).map(item => ({ ...item, state: 'shown' })), existing: [] });
        }
        throw new Error(`unexpected ${ns}.${method}`);
      },
    });

    await feed.poll();
    assert.equal(feed.getSnapshot().items.length, 2);
    assert.equal(calls.filter(call => call.method === 'claim').length, 1);

    await feed.poll();
    assert.equal(feed.getSnapshot().items.length, 2);
    assert.equal(calls.filter(call => call.method === 'claim').length, 1, 'pending cards are not claimed again');
  });

  it('does not claim work while quiet or focused', async () => {
    const calls = [];
    const feed = createReminderFeed({
      call: async (ns, method, payload) => {
        calls.push({ ns, method, payload });
        return ok({
          newItems: [],
          pendingItems: [],
          deferredItems: [ITEM_A],
          pausedReason: 'quiet',
          review: READY_FEED.due.review, date: '2026-11-10',
        });
      },
    });
    await feed.poll();
    assert.equal(feed.getSnapshot().pausedReason, 'quiet');
    assert.equal(feed.getSnapshot().deferred.length, 1);
    assert.equal(calls.some(call => call.method === 'claim'), false);
  });

  it('hides unclaimed items when the claim fails, and retries on the next poll', async () => {
    let attempt = 0;
    const feed = createReminderFeed({
      call: async (ns, method) => {
        if (method === 'due') {
          attempt += 1;
          return ok({
            newItems: [ITEM_A],
            pendingItems: [],
            deferredItems: [],
            pausedReason: null,
            review: READY_FEED.due.review, date: '2026-11-10',
          });
        }
        if (method === 'claim') {
          if (attempt === 1) throw new Error('网络失败');
          return ok({ claimed: [{ ...ITEM_A, state: 'shown' }], existing: [] });
        }
        throw new Error(`unexpected ${method}`);
      },
    });

    await feed.poll();
    assert.equal(feed.getSnapshot().items.length, 0);
    assert.match(feed.getSnapshot().error, /网络失败/);

    await feed.poll();
    assert.equal(feed.getSnapshot().items.length, 1);
    assert.equal(feed.getSnapshot().error, null);
  });

  it('answers and snoozes through the service, then reloads the feed', async () => {
    const calls = [];
    const feed = createReminderFeed({
      makeRequestId: () => 'rid-1',
      call: async (ns, method, payload) => {
        calls.push({ ns, method, payload });
        if (method === 'due') {
          return ok({ newItems: [], pendingItems: [], deferredItems: [], pausedReason: null, review: READY_FEED.due.review, date: '2026-11-10' });
        }
        return ok({});
      },
    });

    assert.equal(await feed.answer(ITEM_A.key, 'done'), true);
    assert.deepEqual(calls[0], { ns: 'followup', method: 'answer', payload: { requestId: 'rid-1', key: ITEM_A.key, reply: 'done' } });
    assert.equal(calls.find(c=>c.method==='due').method, 'due');

    assert.equal(await feed.snooze(ITEM_A.key, 5), true);
    assert.deepEqual(calls.find(c=>c.method==='snooze'), { ns: 'followup', method: 'snooze', payload: { requestId: 'rid-1', key: ITEM_A.key, minutes: 5 } });
    assert.equal(calls.filter(c=>c.method==='due').length, 2);
  });

  it('keeps dismissed cards and the review nudge hidden on later polls', async () => {
    const feed = createReminderFeed({
      call: async (ns, method) => {
        if (method === 'due') {
          return ok({
            date: '2026-11-10',
            newItems: [],
            pendingItems: [ITEM_A],
            deferredItems: [],
            pausedReason: null,
            review: { due: true, at: '21:30', status: 'pending' },
          });
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    await feed.poll();
    assert.equal(feed.getSnapshot().items.length, 1);
    assert.equal(feed.getSnapshot().due.review.due, true);

    feed.dismiss();
    assert.equal(feed.getSnapshot().items.length, 0);
    assert.equal(feed.getSnapshot().due.review.due, false);

    await feed.poll();
    assert.equal(feed.getSnapshot().items.length, 0, 'the dismissed card stays hidden');
    assert.equal(feed.getSnapshot().due.review.due, false, 'the dismissed review nudge stays hidden');
  });

  it('loads the recovery summary once and clears it on dismissal', async () => {
    let recoveryCalls = 0;
    const feed = createReminderFeed({
      call: async (ns, method) => {
        if (method === 'recovery') {
          recoveryCalls += 1;
          return ok({ scheduling: { status: 'degraded' }, pending: [], pendingConfirmation: [], reviewDecision: 'manual_confirmation' });
        }
        if (method === 'due') {
          return ok({ newItems: [], pendingItems: [], deferredItems: [], pausedReason: null, review: READY_FEED.due.review, date: '2026-11-10' });
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    await feed.poll();
    assert.equal(feed.getSnapshot().recovery.reviewDecision, 'manual_confirmation');
    feed.dismiss();
    assert.equal(feed.getSnapshot().recovery, null);
    await feed.poll();
    assert.equal(feed.getSnapshot().recovery, null);
    assert.equal(recoveryCalls, 1, 'the startup summary is not re-read on every poll');
  });

  it('starts and stops one interval and disposes the feed', () => {
    const timer = fakeTimer();
    const feed = createReminderFeed({
      call: async () => ok({ newItems: [], pendingItems: [], deferredItems: [], pausedReason: null, review: READY_FEED.due.review, date: '2026-11-10' }),
      timer,
      intervalMs: 5000,
    });
    feed.start();
    feed.start();
    assert.equal(timer.size, 1, 'start is idempotent');
    feed.stop();
    assert.equal(timer.size, 0);
    feed.dispose();
    assert.ok(feed.getSnapshot());
  });
});

describe('followup banner installer', () => {
  it('registers one shell overlay and opens the reminders page', () => {
    const registrations = [];
    const injections = [];
    let selected = null;
    const ctx = {
      slots: {
        inject(slot, callback) {
          injections.push(slot);
          callback();
          return () => {};
        },
        register(options, component) {
          registrations.push({ options, component });
          return () => {};
        },
      },
      inject(names, callback) {
        injections.push(names.join(','));
        callback({ layout: { selectPanel: page => { selected = page; } } });
      },
      effect(run) {
        run();
        return () => {};
      },
    };
    const feed = installFollowupReminders(ctx, {
      namespace: 'study',
      call: async () => ok({ newItems: [], pendingItems: [], deferredItems: [], pausedReason: null, review: READY_FEED.due.review, date: '2026-11-10' }),
      timer: fakeTimer(),
    });
    assert.ok(feed);
    assert.deepEqual(injections, ['layout', 'shell.overlay']);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].options.name, 'shell.overlay');
    assert.equal(registrations[0].options.id, 'study.followup-reminders');
    assert.equal(registrations[0].options.locale, 'study');
    assert.equal(registrations[0].component.name, 'RemindersBanner');
    registrations[0].options.inject().openPage();
    assert.equal(selected, 'reminders');
  });
});
