import { createLearningNotifier } from '../learning-notify.js';
/**
 * Reminders page and shell banner: in-app cards for due study blocks, the four
 * quick replies, quiet/focus postponement, and the evening review that saves a
 * plan revision.
 *
 * The page and the frame-wide banner share one feed controller. The controller
 * reads `followup.due`, claims only the unclaimed cards, and keeps the claimed
 * cards visible until the student answers, snoozes, or the period ends. It has
 * no timer of its own beyond an injectable interval, so Node tests drive it
 * without a browser.
 *
 * The evening review preview is a read. Saving it calls `followup.review`,
 * which rechecks the plan revision and the pending draft before calling the
 * plans service; a `committed: false` result is shown as "needs adjustment",
 * never as a saved review.
 */
import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react';

/** Page key; also the shell page the banner opens. */
export const PAGE_KEY = 'reminders';
/** Slot key of the frame-wide banner. */
export const BANNER_SLOT = 'shell.overlay';
/** Registration id of the banner inside {@link BANNER_SLOT}. */
export const BANNER_ID = 'study.followup-reminders';
/** Banner order among shell overlays. */
export const BANNER_ORDER = 30;
/** How often the feed checks for due reminders. */
export const POLL_MS = 15_000;
/** Cards shown in the compact banner before its "more" line. */
export const BANNER_ITEM_LIMIT = 3;
/** Quick replies accepted by the followup service. */
export const QUICK_REPLIES = Object.freeze(['done', 'partial', 'not_done']);

const ROOT_STYLE = { padding: '28px 32px 48px', maxWidth: '880px', display: 'flex', flexDirection: 'column', gap: '18px' };
const HEADER_STYLE = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' };
const TITLE_STYLE = { margin: 0, fontSize: '20px', fontWeight: 600, letterSpacing: '0.01em' };
const SUBTITLE_STYLE = { margin: '6px 0 0', fontSize: '13px', lineHeight: 1.6, opacity: 0.68, maxWidth: '66ch' };
const RULE_STYLE = { margin: 0, fontSize: '12px', lineHeight: 1.6, opacity: 0.66 };
const CARD_STYLE = { border: '1px solid rgba(127, 127, 127, 0.28)', borderRadius: '10px', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '10px' };
const CARD_ALERT_STYLE = { ...CARD_STYLE, borderColor: 'rgba(194, 65, 12, 0.55)' };
const SECTION_HEADING_STYLE = { margin: 0, fontSize: '15px', fontWeight: 600 };
const MESSAGE_STYLE = { margin: 0, fontSize: '13px', lineHeight: 1.6, opacity: 0.82 };
const WARNING_STYLE = { ...MESSAGE_STYLE, color: 'var(--dsw-alias-state-error-primary, #c2410c)' };
const MUTED_STYLE = { margin: 0, fontSize: '12px', lineHeight: 1.6, opacity: 0.66 };
const BUTTON_STYLE = {
  appearance: 'none', border: '1px solid rgba(127, 127, 127, 0.45)', borderRadius: '6px',
  background: 'transparent', color: 'inherit', padding: '4px 10px', fontSize: '12.5px', cursor: 'pointer',
};
const BUTTON_PRIMARY_STYLE = { ...BUTTON_STYLE, borderColor: 'currentColor', fontWeight: 600 };
const BUTTON_ACTIVE_STYLE = { ...BUTTON_STYLE, borderColor: 'rgba(64, 128, 255, 0.65)', background: 'rgba(64, 128, 255, 0.16)' };
const TOOLBAR_STYLE = { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' };
const LIST_STYLE = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' };
const ITEM_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 0', borderTop: '1px solid rgba(127, 127, 127, 0.2)' };
const ITEM_HEAD_STYLE = { display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'baseline', flexWrap: 'wrap' };
const ITEM_TITLE_STYLE = { margin: 0, fontSize: '13.5px', fontWeight: 500 };
const BADGE_STYLE = { border: '1px solid rgba(127, 127, 127, 0.4)', borderRadius: '999px', padding: '0 7px', fontSize: '11px', opacity: 0.8 };
const FIELDS_STYLE = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' };
const FIELD_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' };
const INPUT_STYLE = { padding: '5px 7px', fontSize: '13px', fontFamily: 'inherit' };
const BANNER_STYLE = {
  position: 'fixed', right: '20px', bottom: '20px', zIndex: 60,
  width: 'min(380px, calc(100vw - 40px))', boxSizing: 'border-box',
  display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px',
  border: '1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.4))',
  borderRadius: '12px', background: 'var(--dsw-alias-bg-overlay, rgba(32, 32, 36, 0.96))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  boxShadow: '0 10px 30px rgba(0, 0, 0, 0.28)', fontSize: '13px', lineHeight: 1.5,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Locale keys for the unscheduled reasons the followup service reports. */
const REVIEW_REASON_KEYS = Object.freeze({
  capacity: 'reminders.review.reason.capacity',
  unknown_availability: 'reminders.review.reason.unknown-availability',
  no_target_days: 'reminders.review.reason.no-target-days',
});

/** One discovered page: contract consumed by `client/plugin.js`. */
export default {
  key: PAGE_KEY,
  order: 16,
  label: 'reminders.panel',
  Page: RemindersPage,
};

/**
 * Turn a rejection into display text.
 * @param {unknown} error - Rejection value.
 * @returns {string} Diagnostic text.
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Format an ISO instant as local `HH:MM`.
 * @param {unknown} iso - ISO timestamp.
 * @returns {string} Time text, or the raw value when it cannot be parsed.
 */
function localTime(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  return `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`;
}

/** Build the editable settings draft from one stored settings value. */
export function settingsDraftOf(settings) {
  return {
    enabled: settings?.enabled !== false,
    reviewEnabled: settings?.reviewEnabled !== false,
    quietStart: settings?.quietStart ?? '22:00',
    quietEnd: settings?.quietEnd ?? '07:00',
    reviewAt: settings?.reviewAt ?? '21:30',
    snoozeMinutes: String(settings?.snoozeMinutes ?? 10),
  };
}

/**
 * Validate the settings draft. Equal quiet start/end mean "no quiet hours".
 * @param {object} draft - Editable settings.
 * @returns {{ ok: true, value: object } | { ok: false, field: string }} Validation result.
 */
export function validateSettingsDraft(draft) {
  if (typeof draft?.quietStart !== 'string' || !TIME_PATTERN.test(draft.quietStart)) return { ok: false, field: 'quietStart' };
  if (typeof draft?.quietEnd !== 'string' || !TIME_PATTERN.test(draft.quietEnd)) return { ok: false, field: 'quietEnd' };
  if (typeof draft?.reviewAt !== 'string' || !TIME_PATTERN.test(draft.reviewAt)) return { ok: false, field: 'reviewAt' };
  const snooze = Number(draft?.snoozeMinutes);
  if (!Number.isSafeInteger(snooze) || snooze < 1 || snooze > 120) return { ok: false, field: 'snoozeMinutes' };
  return {
    ok: true,
    value: {
      enabled: draft.enabled === true,
      reviewEnabled: draft.reviewEnabled === true,
      quietStart: draft.quietStart,
      quietEnd: draft.quietEnd,
      reviewAt: draft.reviewAt,
      snoozeMinutes: snooze,
    },
  };
}

/** One fresh request id for a write. */
function requestId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `followup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Build the polling feed shared by the page and the banner.
 * @param {{
 *   call: Function, timer?: { setInterval: Function, clearInterval: Function },
 *   intervalMs?: number, makeRequestId?: () => string,
 * }} options - Study route caller plus injectable timer and id source.
 * @returns {object} Feed with `getSnapshot`, `subscribe`, `start`, `stop`, `poll`, `answer`, `snooze`, `dispose`.
 */
export function createReminderFeed({ call, timer = globalThis, intervalMs = POLL_MS, makeRequestId = requestId, notifier = createLearningNotifier() } = {}) {
  let snapshot = {
    phase: 'idle',
    items: [],
    deferred: [],
    due: null,
    pausedReason: null,
    error: null,
    actionError: null,
    busy: false,
    at: null,
    recovery:null,
  };
  const listeners = new Set();
  const dismissed = new Set();
  let reviewDismissedKey = null;
  let handle;
  let disposed = false;
  let sequence = 0;

  function publish(patch) {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch, at: Date.now() };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[study] reminder feed subscriber failed:', error);
      }
    }
  }

  function getSnapshot() {
    return snapshot;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  async function poll() {
    if (disposed) return;
    const current = sequence + 1;
    sequence = current;
    if (snapshot.phase === 'idle') {
      publish({ phase: 'loading' });
      try {
        const recovered=await call('followup','recovery',{});
        publish({recovery:recovered.value});
      } catch(error) { publish({recovery:{error:describeError(error)}}); }
    }
    try {
      const envelope = await call('followup', 'due', {});
      if (disposed || current !== sequence) return;
      const due = envelope.value;
      const unclaimed = Array.isArray(due.newItems) ? due.newItems : [];
      let claimed = [];
      let claimError = null;
      if (unclaimed.length > 0) {
        try {
          const claim = await call('followup', 'claim', { keys: unclaimed.map(item => item.key), requestId:makeRequestId() });
          claimed = Array.isArray(claim.value?.claimed) ? claim.value.claimed : [];
        } catch (error) {
          claimError = describeError(error);
        }
      }
      if (disposed || current !== sequence) return;
      const byKey = new Map();
      for (const item of [...(Array.isArray(due.pendingItems) ? due.pendingItems : []), ...claimed]) {
        byKey.set(item.key, item);
      }
      const items = [...byKey.values()]
        .filter(item => !dismissed.has(item.key))
        .sort((left, right) => String(left.start).localeCompare(String(right.start)));
      notifier.reminders(items);
      try {
        const timerState = await call('timer', 'status', {});
        notifier.timer(timerState.value?.session);
      } catch { /* Reminder delivery does not depend on the timer route. */ }
      const review = due.review === null || due.review === undefined ? null : { ...due.review };
      if (review !== null && reviewDismissedKey === `${due.date}:${review.at}`) review.due = false;
      publish({
        phase: 'ready',
        items,
        deferred: Array.isArray(due.deferredItems) ? due.deferredItems.filter(item => !dismissed.has(item.key)) : [],
        due: review === null || due.review === null || due.review === undefined ? due : { ...due, review },
        pausedReason: due.pausedReason ?? null,
        error: claimError,
        busy: false,
      });
    } catch (error) {
      if (disposed || current !== sequence) return;
      publish({ phase: 'error', error: describeError(error), busy: false });
    }
  }

  async function act(method, payload) {
    if (snapshot.busy) return false;
    publish({ busy: true, actionError: null });
    try {
      await call('followup', method, { requestId: makeRequestId(), ...payload });
      await poll();
      return true;
    } catch (error) {
      publish({ busy: false, actionError: describeError(error) });
      return false;
    }
  }

  function start() {
    if (disposed || handle !== undefined) return;
    void poll();
    handle = timer.setInterval(() => { void poll(); }, intervalMs);
    if (typeof handle?.unref === 'function') handle.unref();
  }

  function stop() {
    if (handle === undefined) return;
    timer.clearInterval(handle);
    handle = undefined;
  }

  /** Hide the banner's current cards and review nudge until the next day/period. */
  function dismiss() {
    const current = snapshot.due;
    for (const item of snapshot.items) dismissed.add(item.key);
    for (const item of snapshot.deferred) dismissed.add(item.key);
    if (current?.review !== null && current?.review !== undefined) reviewDismissedKey = `${current.date}:${current.review.at}`;
    while (dismissed.size > 200) dismissed.delete(dismissed.values().next().value);
    publish({
      recovery: null,
      items: [],
      deferred: [],
      due: current === null || current === undefined
        ? current
        : { ...current, review: current.review === null || current.review === undefined ? current.review : { ...current.review, due: false } },
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    sequence += 1;
    listeners.clear();
    dismissed.clear();
  }

  return {
    getSnapshot,
    subscribe,
    start,
    stop,
    poll,
    answer: (key, reply) => act('answer', { key, reply }),
    snooze: (key, minutes) => act('snooze', minutes === undefined ? { key } : { key, minutes }),
    dismiss,
    dispose,
  };
}

/**
 * Page body: owns one feed, the settings form, and the review preview/commit.
 * @param {{ t: Function, call: Function }} props - Locale seat and study route caller.
 * @returns {object} Page element.
 */
function RemindersPage({ t, call }) {
  const feed = useMemo(() => createReminderFeed({ call }), [call]);
  const [feedState, setFeedState] = useState(feed.getSnapshot());
  const [settings, setSettings] = useState({ phase: 'loading', value: null, error: null });
  const [draft, setDraft] = useState(settingsDraftOf(null));
  const [notificationPermission, setNotificationPermission] = useState(() => createLearningNotifier().permission());
  const [review, setReview] = useState({ phase: 'idle', value: null, message: null, due: false, at: null });
  const [notice, setNotice] = useState(null);

  const loadSettings = useCallback(async () => {
    try {
      const envelope = await call('followup', 'getSettings', {});
      setSettings({ phase: 'ready', value: envelope.value.settings, error: null });
      setDraft(settingsDraftOf(envelope.value.settings));
    } catch (error) {
      setSettings({ phase: 'error', value: null, error: describeError(error) });
    }
  }, [call]);

  const loadReview = useCallback(async () => {
    setReview(current => ({ ...current, phase: 'loading', message: null }));
    try {
      const envelope = await call('followup', 'reviewPreview', {});
      const value = envelope.value;
      setReview({
        phase: value.status === 'ready' ? 'preview' : value.status,
        value,
        message: value.reason ?? null,
        due: true,
        at: value.at ?? null,
      });
    } catch (error) {
      setReview({ phase: 'error', value: null, message: describeError(error), due: true, at: null });
    }
  }, [call]);

  useEffect(() => {
    const unsubscribe = feed.subscribe(() => { setFeedState(feed.getSnapshot()); });
    feed.start();
    void loadSettings();
    return () => {
      unsubscribe();
      feed.stop();
    };
  }, [feed, loadSettings]);

  const reviewDue = feedState.due?.review?.due === true;
  useEffect(() => {
    if (reviewDue && (review.phase === 'idle' || review.phase === 'no_plan')) void loadReview();
  }, [reviewDue, review.phase, loadReview]);

  const saveSettings = useCallback(async () => {
    const valid = validateSettingsDraft(draft);
    if (valid.ok !== true) {
      setNotice(t('reminders.settings.invalid'));
      return;
    }
    try {
      const envelope = await call('followup', 'updateSettings', { requestId: requestId(), ...valid.value });
      setSettings({ phase: 'ready', value: envelope.value.settings, error: null });
      setDraft(settingsDraftOf(envelope.value.settings));
      setNotice(t('reminders.settings.saved'));
      void feed.poll();
    } catch (error) {
      setNotice(t('reminders.settings.failed', { message: describeError(error) }));
    }
  }, [call, draft, feed, t]);

  const saveReview = useCallback(async () => {
    const preview = review.value;
    if (preview === null || preview?.status !== 'ready') return;
    setReview(current => ({ ...current, phase: 'loading', message: null }));
    try {
      const envelope = await call('followup', 'review', {
        requestId: requestId(),
        planId: preview.planId,
        baseRevision: preview.baseRevision,
      });
      const value = envelope.value;
      if (value.committed === true) {
        setReview({ phase: 'committed', value, message: null, due: reviewDue, at: preview.date });
        setNotice(t('reminders.review.committed', { revision: value.planRevision }));
      } else if (value.status === 'blocked') {
        setReview({ phase: 'blocked', value, message: value.reason, due: reviewDue, at: preview.date });
      } else if (value.status === 'nothing_to_do') {
        setReview({ phase: 'nothing_to_do', value, message: value.reason, due: reviewDue, at: preview.date });
      } else if (value.status === 'no_plan') {
        setReview({ phase: 'no_plan', value, message: value.reason, due: reviewDue, at: preview.date });
      } else {
        setReview({ phase: 'needs_adjustment', value, message: value.message ?? value.reason, due: reviewDue, at: preview.date });
      }
      void feed.poll();
    } catch (error) {
      setReview({ phase: 'error', value: preview, message: describeError(error), due: reviewDue, at: preview.date });
    }
  }, [call, feed, review.value, reviewDue, t]);

  const answer = useCallback((key, reply) => { void feed.answer(key, reply); }, [feed]);
  const snooze = useCallback(key => { void feed.snooze(key); }, [feed]);
  const enableNotifications = useCallback(async () => {
    const permission = await createLearningNotifier().requestPermission();
    setNotificationPermission(permission);
    setNotice(t('reminders.notify.permission', { status: permission }));
  }, [t]);

  return RemindersView({
    create: h,
    t,
    feed: feedState,
    settings,
    draft,
    review: { ...review, due: reviewDue, at: feedState.due?.review?.at ?? review.at },
    notice,
    busy: feedState.busy,
    notificationPermission,
    onRefresh: () => { void feed.poll(); void loadSettings(); if (reviewDue) void loadReview(); },
    onAnswer: answer,
    onSnooze: snooze,
    onDraft: (field, value) => { setDraft(current => ({ ...current, [field]: value })); },
    onSaveSettings: () => { void saveSettings(); },
    onToggleDraft: field => { setDraft(current => ({ ...current, [field]: !current[field] })); },
    onReview: () => { void loadReview(); },
    onSaveReview: () => { void saveReview(); },
    onEnableNotifications: () => { void enableNotifications(); },
  });
}

/**
 * Render the whole page from one state.
 * @param {object} props - Render inputs; see {@link RemindersPage} for producers.
 * @returns {object} Section element.
 */
export function RemindersView(props) {
  const { create, t, feed, settings, draft, review, notice, busy } = props;
  const items = Array.isArray(feed.items) ? feed.items : [];
  const deferred = Array.isArray(feed.deferred) ? feed.deferred : [];
  return create('section', { 'data-testid': 'study-reminders', 'data-page': PAGE_KEY, style: ROOT_STYLE },
    create('header', { style: HEADER_STYLE },
      create('div', null,
        create('h1', { style: TITLE_STYLE }, t('reminders.title')),
        create('p', { style: SUBTITLE_STYLE }, t('reminders.subtitle')),
        create('p', { style: RULE_STYLE }, t('reminders.rule'))),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', style: BUTTON_STYLE, 'data-testid': 'followup-refresh', onClick: props.onRefresh }, t('reminders.refresh')))),
    notice === null || notice === undefined ? null : create('p', { role: 'status', style: MESSAGE_STYLE, 'data-testid': 'followup-notice' }, notice),
    feed.phase === 'loading' ? create('p', { role: 'status', style: MESSAGE_STYLE }, t('reminders.loading')) : null,
    feed.phase === 'error'
      ? create('p', { role: 'alert', style: WARNING_STYLE, 'data-testid': 'followup-error' }, t('reminders.error', { message: feed.error }))
      : null,
    feed.actionError === null || feed.actionError === undefined
      ? null
      : create('p', { role: 'alert', style: WARNING_STYLE, 'data-testid': 'followup-action-error' }, t('reminders.answer.failed', { message: feed.actionError })),
    renderPause(create, t, feed, deferred),
    items.length === 0
      ? (feed.phase === 'ready' && feed.pausedReason === null && deferred.length === 0
        ? create('p', { style: MESSAGE_STYLE, 'data-testid': 'followup-empty' }, t('reminders.empty'))
        : null)
      : ReminderCardView({ create, t, items, busy, onAnswer: props.onAnswer, onSnooze: props.onSnooze }),
    ReviewCardView({ create, t, review, busy, onReview: props.onReview, onSaveReview: props.onSaveReview }),
    SettingsView({ create, t, settings, draft, busy, notificationPermission: props.notificationPermission, onDraft: props.onDraft, onToggle: props.onToggleDraft, onSave: props.onSaveSettings, onEnableNotifications: props.onEnableNotifications }));
}

/** Render the paused/deferred state, if any. */
function renderPause(create, t, feed, deferred) {
  if (feed.pausedReason === 'disabled') {
    return create('p', { style: MUTED_STYLE, 'data-testid': 'followup-paused-disabled' }, t('reminders.state.disabled'));
  }
  if (feed.pausedReason === 'quiet') {
    return create('div', { style: CARD_STYLE, 'data-testid': 'followup-paused-quiet' },
      create('p', { style: MESSAGE_STYLE }, t('reminders.state.quiet', {
        start: feed.due?.quiet?.start ?? '',
        end: feed.due?.quiet?.end ?? '',
        until: localTime(feed.due?.quiet?.until) || '—',
      })),
      deferred.length === 0 ? null : create('p', { style: MUTED_STYLE }, t('reminders.state.deferred', { count: deferred.length })),
      (feed.due?.pausedPendingCount ?? 0) === 0 ? null : create('p', { style: MUTED_STYLE }, t('reminders.state.pausedPending', { count: feed.due.pausedPendingCount })));
  }
  if (feed.pausedReason === 'focus') {
    return create('div', { style: CARD_STYLE, 'data-testid': 'followup-paused-focus' },
      create('p', { style: MESSAGE_STYLE }, t('reminders.state.focus', {
        until: localTime(feed.due?.focus?.until) || '—',
      })),
      deferred.length === 0 ? null : create('p', { style: MUTED_STYLE }, t('reminders.state.deferred', { count: deferred.length })),
      (feed.due?.pausedPendingCount ?? 0) === 0 ? null : create('p', { style: MUTED_STYLE }, t('reminders.state.pausedPending', { count: feed.due.pausedPendingCount })));
  }
  if (deferred.length > 0) {
    return create('p', { style: MUTED_STYLE, 'data-testid': 'followup-deferred' }, t('reminders.state.deferred', { count: deferred.length }));
  }
  return null;
}

/**
 * One merged reminder card with a quick reply for every due item.
 * @param {{
 *   create: Function, t: Function, items: object[], busy: boolean,
 *   onAnswer: (key: string, reply: string) => void, onSnooze: (key: string) => void,
 *   compact?: boolean,
 * }} props - Render inputs.
 * @returns {object} Card element.
 */
export function ReminderCardView({ create, t, items, busy, onAnswer, onSnooze, compact = false }) {
  const headline = items.length === 1
    ? t('reminders.card.single', { title: items[0].title })
    : t('reminders.card.merged', { count: items.length });
  return create('section', {
    style: CARD_STYLE,
    'data-testid': compact ? 'followup-banner-card' : 'followup-reminder-card',
    role: 'status',
  },
  create('h2', { style: SECTION_HEADING_STYLE }, headline),
  create('ul', { style: LIST_STYLE }, items.map(item => create('li', { key: item.key, style: ITEM_STYLE },
    create('div', { style: ITEM_HEAD_STYLE },
      create('span', { style: ITEM_TITLE_STYLE }, item.title),
      create('span', { style: MUTED_STYLE }, t('reminders.card.minutes', { minutes: item.minutes, start: item.start, end: item.end }))),
    create('p', { style: MUTED_STYLE }, item.state === 'new'
      ? t('reminders.card.overdue', { minutes: item.overdueMinutes })
      : t('reminders.card.pending')),
    create('div', { style: TOOLBAR_STYLE },
      quickButton(create, t, item.key, 'done', busy, onAnswer),
      quickButton(create, t, item.key, 'partial', busy, onAnswer),
      quickButton(create, t, item.key, 'not_done', busy, onAnswer),
      create('button', {
        type: 'button',
        style: BUTTON_STYLE,
        disabled: busy,
        'data-testid': `followup-later-${item.key}`,
        onClick: () => { onSnooze(item.key); },
      }, t('reminders.answer.later')))))));
}

/** One quick-reply button. */
function quickButton(create, t, key, reply, busy, onAnswer) {
  const labelKeys = { done: 'reminders.answer.done', partial: 'reminders.answer.partial', not_done: 'reminders.answer.notDone' };
  return create('button', {
    type: 'button',
    style: reply === 'done' ? BUTTON_PRIMARY_STYLE : BUTTON_STYLE,
    disabled: busy,
    'data-testid': `followup-answer-${key}-${reply}`,
    onClick: () => { onAnswer(key, reply); },
  }, t(labelKeys[reply]));
}

/**
 * Evening review card: preview, committed summary, needs-adjustment warning,
 * or the reason the review cannot run.
 * @param {{
 *   create: Function, t: Function,
 *   review: { phase: string, value: object | null, message: string | null, due?: boolean, at?: string | null },
 *   busy: boolean, onReview: Function, onSaveReview: Function,
 * }} props - Render inputs.
 * @returns {object} Card element.
 */
export function ReviewCardView({ create, t, review, busy, onReview, onSaveReview }) {
  const phase = review?.phase ?? 'idle';
  const value = review?.value ?? null;
  return create('section', { style: CARD_STYLE, 'data-testid': 'followup-review', 'data-phase': phase },
    create('h2', { style: SECTION_HEADING_STYLE }, t('reminders.review.title')),
    create('p', { style: MUTED_STYLE }, t('reminders.review.subtitle')),
    create('p', { style: MUTED_STYLE }, t('reminders.review.manual')),
    renderReviewBody(create, t, phase, value, review, busy, onReview, onSaveReview));
}

function renderReviewBody(create, t, phase, value, review, busy, onReview, onSaveReview) {
  if (phase === 'loading') return create('p', { role: 'status', style: MESSAGE_STYLE }, t('reminders.review.loading'));
  if (phase === 'idle') {
    return create('div', null,
      create('p', { style: MUTED_STYLE }, review?.due === true
        ? t('reminders.review.due')
        : t('reminders.review.notDue', { at: review?.at ?? '21:30' })),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', style: BUTTON_STYLE, 'data-testid': 'followup-review-start', onClick: onReview }, t('reminders.review.start'))));
  }
  if (phase === 'no_plan') return create('p', { style: MESSAGE_STYLE, 'data-testid': 'followup-review-no-plan' }, t('reminders.review.noPlan'));
  if (phase === 'blocked') {
    const messageKey = value?.reason === 'draft_pending' ? 'reminders.review.draftPending' : 'reminders.review.planNotConfirmed';
    return create('div', null,
      create('p', { role: 'status', style: WARNING_STYLE, 'data-testid': 'followup-review-blocked' }, t(messageKey)),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', style: BUTTON_STYLE, onClick: onReview }, t('reminders.review.refresh'))));
  }
  if (phase === 'nothing_to_do') {
    return create('div', null,
      create('p', { style: MESSAGE_STYLE, 'data-testid': 'followup-review-nothing' }, t('reminders.review.nothingToDo')),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', style: BUTTON_STYLE, onClick: onReview }, t('reminders.review.refresh'))));
  }
  if (phase === 'needs_adjustment') {
    return create('div', null,
      create('p', { role: 'alert', style: WARNING_STYLE, 'data-testid': 'followup-review-adjust' }, t('reminders.review.needsAdjustment', {
        message: review?.message ?? value?.message ?? '',
      })),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', style: BUTTON_STYLE, onClick: onReview }, t('reminders.review.refresh'))));
  }
  if (phase === 'error') {
    return create('div', null,
      create('p', { role: 'alert', style: WARNING_STYLE }, t('reminders.review.failed', { message: review?.message ?? '' })),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', style: BUTTON_STYLE, onClick: onReview }, t('reminders.review.refresh'))));
  }
  if (phase === 'committed') {
    const summary = value?.summary ?? {};
    return create('div', null,
      create('p', { role: 'status', style: MESSAGE_STYLE, 'data-testid': 'followup-review-committed' }, t('reminders.review.committed', { revision: value?.planRevision ?? '—' })),
      create('p', { style: MUTED_STYLE }, t('reminders.review.committedSummary', {
        moved: summary.movedItems ?? 0,
        movedMinutes: summary.movedMinutes ?? 0,
        unscheduled: summary.unscheduledItems ?? 0,
        unscheduledMinutes: summary.unscheduledMinutes ?? 0,
      })));
  }
  if (phase === 'preview' && value !== null) {
    return renderPreview(create, t, value, busy, onReview, onSaveReview);
  }
  return null;
}

/** Render the proposal and the explicit save button. */
function renderPreview(create, t, preview, busy, onReview, onSaveReview) {
  const proposal = preview.proposal ?? { moves: [], unscheduled: [], kept: [], explanations: [] };
  const summary = preview.summary ?? {};
  return create('div', { 'data-testid': 'followup-review-preview' },
    create('div', { style: TOOLBAR_STYLE },
      create('span', { style: BADGE_STYLE }, t('reminders.review.remaining', { items: summary.remainingItems ?? 0, minutes: summary.remainingMinutes ?? 0 })),
      create('span', { style: BADGE_STYLE }, t('reminders.review.moved', { items: summary.movedItems ?? 0, minutes: summary.movedMinutes ?? 0 })),
      create('span', { style: BADGE_STYLE }, t('reminders.review.unscheduled', { items: summary.unscheduledItems ?? 0, minutes: summary.unscheduledMinutes ?? 0 })),
      create('span', { style: BADGE_STYLE }, t('reminders.review.kept', { items: summary.keptItems ?? 0 }))),
    proposal.moves.length === 0 ? null : create('div', null,
      create('h3', { style: MUTED_STYLE }, t('reminders.review.moves')),
      create('ul', { style: LIST_STYLE }, proposal.moves.map(move => create('li', { key: move.itemId, style: MESSAGE_STYLE },
        t('reminders.review.move', {
          title: move.title,
          from: move.fromDate,
          to: move.toDate,
          minutes: move.minutes,
        }))))),
    proposal.unscheduled.length === 0 ? null : create('div', { 'data-testid': 'followup-review-unscheduled' },
      create('h3', { style: MUTED_STYLE }, t('reminders.review.left')),
      create('ul', { style: LIST_STYLE }, proposal.unscheduled.map(entry => create('li', { key: entry.itemId, style: MESSAGE_STYLE },
        t('reminders.review.leftItem', {
          title: entry.title,
          minutes: entry.minutes,
          reason: t(REVIEW_REASON_KEYS[entry.reason] ?? 'reminders.review.reason.capacity'),
        }))))),
    proposal.explanations.length === 0 ? null : create('ul', { style: LIST_STYLE }, proposal.explanations.map((line, index) => create('li', { key: index, style: MUTED_STYLE }, line))),
    create('div', { style: TOOLBAR_STYLE },
      create('button', { type: 'button', style: BUTTON_PRIMARY_STYLE, disabled: busy, 'data-testid': 'followup-review-save', onClick: onSaveReview }, t('reminders.review.save')),
      create('button', { type: 'button', style: BUTTON_STYLE, disabled: busy, onClick: onReview }, t('reminders.review.refresh'))));
}

/**
 * Settings form: on/off, quiet hours, review time, and snooze length.
 * @param {{
 *   create: Function, t: Function,
 *   settings: { phase: string, value: object | null, error: string | null },
 *   draft: object, busy: boolean, onDraft: Function, onToggle: Function, onSave: Function,
 * }} props - Render inputs.
 * @returns {object} Card element.
 */
export function SettingsView({ create, t, settings, draft, busy, notificationPermission, onDraft, onToggle, onSave, onEnableNotifications }) {
  return create('section', { style: CARD_STYLE, 'data-testid': 'followup-settings' },
    create('h2', { style: SECTION_HEADING_STYLE }, t('reminders.settings.title')),
    settings?.phase === 'error' ? create('p', { role: 'alert', style: WARNING_STYLE }, settings.error) : null,
    create('div', { style: TOOLBAR_STYLE },
      switchButton(create, t, 'enabled', draft.enabled, busy, onToggle, 'reminders.settings.enabled'),
      switchButton(create, t, 'reviewEnabled', draft.reviewEnabled, busy, onToggle, 'reminders.settings.reviewEnabled')),
    create('div', { style: FIELDS_STYLE },
      timeField(create, t, 'quietStart', draft, busy, onDraft),
      timeField(create, t, 'quietEnd', draft, busy, onDraft),
      timeField(create, t, 'reviewAt', draft, busy, onDraft),
      create('label', { style: FIELD_STYLE },
        create('span', null, t('reminders.settings.snooze')),
        create('input', {
          type: 'number',
          min: 1,
          max: 120,
          step: 1,
          value: draft.snoozeMinutes,
          disabled: busy,
          style: INPUT_STYLE,
          onChange: event => { onDraft('snoozeMinutes', event.target.value); },
        }))),
    create('div', { style: TOOLBAR_STYLE },
      create('button', { type: 'button', style: BUTTON_STYLE, disabled: busy, 'data-testid': 'followup-settings-save', onClick: onSave }, t('reminders.settings.save'))),
    create('div', { 'data-testid': 'followup-notifications', style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' } },
      create('span', { style: MUTED_STYLE }, t('reminders.notify.body')),
      create('div', { style: TOOLBAR_STYLE },
        create('span', { 'data-testid': 'followup-notification-permission', style: BADGE_STYLE }, t('reminders.notify.state', { status: notificationPermission ?? 'unsupported' })),
        notificationPermission === 'granted' || typeof onEnableNotifications !== 'function'
          ? null
          : create('button', { type: 'button', style: BUTTON_STYLE, 'data-testid': 'followup-enable-notifications', onClick: onEnableNotifications }, t('reminders.notify.enable')))));
}

/** One on/off switch rendered as a button. */
function switchButton(create, t, field, value, busy, onToggle, labelKey) {
  return create('button', {
    type: 'button',
    style: value ? BUTTON_ACTIVE_STYLE : BUTTON_STYLE,
    'aria-pressed': value ? 'true' : 'false',
    disabled: busy,
    'data-testid': `followup-toggle-${field}`,
    onClick: () => { onToggle(field); },
  }, `${t(labelKey)} · ${t(value ? 'reminders.settings.on' : 'reminders.settings.off')}`);
}

/** One `type=time` field. */
function timeField(create, t, field, draft, busy, onDraft) {
  const labels = {
    quietStart: 'reminders.settings.quietStart',
    quietEnd: 'reminders.settings.quietEnd',
    reviewAt: 'reminders.settings.reviewAt',
  };
  return create('label', { style: FIELD_STYLE },
    create('span', null, t(labels[field])),
    create('input', {
      type: 'time',
      value: draft[field],
      disabled: busy,
      style: INPUT_STYLE,
      'data-testid': `followup-field-${field}`,
      onChange: event => { onDraft(field, event.target.value); },
    }));
}

/**
 * Frame-wide banner component. It owns the feed lifecycle while mounted.
 * @param {{ t: Function, feed: object, openPage?: Function }} props - Locale seat, feed, and page opener.
 * @returns {object | null} Banner element, or nothing while it is empty.
 */
export function RemindersBanner({ t, feed, openPage }) {
  const [state, setState] = useState(feed.getSnapshot());
  useEffect(() => {
    const unsubscribe = feed.subscribe(() => { setState(feed.getSnapshot()); });
    feed.start();
    return () => {
      unsubscribe();
      feed.stop();
    };
  }, [feed]);
  return RemindersBannerView({
    create: h,
    t,
    state,
    openPage,
    onAnswer: (key, reply) => { void feed.answer(key, reply); },
    onSnooze: key => { void feed.snooze(key); },
    onDismiss: () => { feed.dismiss(); },
  });
}

/**
 * Render the compact shell banner.
 * @param {{
 *   create: Function, t: Function,
 *   state: { phase: string, items: object[], due: object | null, pausedReason: string | null },
 *   openPage?: Function,
 *   onAnswer: Function, onSnooze: Function, onDismiss: Function,
 * }} props - Render inputs.
 * @returns {object | null} Banner element or nothing.
 */
export function RemindersBannerView({ create, t, state, openPage, onAnswer, onSnooze, onDismiss }) {
  if (state?.phase === 'error' || state?.phase === 'loading' || state?.phase === 'idle') return null;
  if (state?.pausedReason !== null && state?.pausedReason !== undefined) return null;
  const items = Array.isArray(state.items) ? state.items : [];
  const review = state.due?.review ?? null;
  const reviewDue = state.pausedReason === null
    && review?.due === true
    && review?.status !== 'committed'
    && review?.status !== 'nothing_to_do';
  if (items.length === 0 && !reviewDue && !state.recovery) return null;
  const visible = items.slice(0, BANNER_ITEM_LIMIT);
  const hidden = items.length - visible.length;
  return create('div', { role: 'status', 'aria-live': 'polite', 'data-testid': 'study-followup-banner', style: BANNER_STYLE },
    state.recovery ? create('div',{'data-testid':'followup-recovery'},
      create('p',null,state.recovery.error ? t('daily.recoveryError',{message:state.recovery.error}) : t('daily.recovered')),
      state.recovery.error ? null : create('p',null,t('daily.recoveryDetails',{status:state.recovery.lastReview?.status??'?',pending:state.recovery.pending?.length??0,confirmation:state.recovery.pendingConfirmation?.length??0})),
      create('div', { style: TOOLBAR_STYLE },
        create('button',{type:'button',style:BUTTON_STYLE,'data-testid':'followup-enable-notifications',onClick:()=>{void createLearningNotifier().requestPermission();}},t('daily.permission')),
        create('button',{type:'button',style:BUTTON_STYLE,'data-testid':'followup-recovery-dismiss',onClick:onDismiss},t('reminders.banner.dismiss')))) : null,
    items.length === 0 && reviewDue
      ? create('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        create('p', { style: { margin: 0, fontWeight: 600 } }, t('reminders.banner.review')),
        create('div', { style: TOOLBAR_STYLE },
          typeof openPage === 'function'
            ? create('button', { type: 'button', style: BUTTON_STYLE, 'data-testid': 'followup-banner-open', onClick: openPage }, t('reminders.banner.open'))
            : null,
          create('button', { type: 'button', style: BUTTON_STYLE, 'data-testid': 'followup-banner-dismiss', onClick: onDismiss }, t('reminders.banner.dismiss'))))
      : create('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        ReminderCardView({ create, t, items: visible, busy: false, onAnswer, onSnooze, compact: true }),
        hidden > 0 ? create('p', { style: MUTED_STYLE }, t('reminders.banner.more', { count: hidden })) : null,
        create('div', { style: TOOLBAR_STYLE },
          typeof openPage === 'function'
            ? create('button', { type: 'button', style: BUTTON_STYLE, 'data-testid': 'followup-banner-open', onClick: openPage }, t('reminders.banner.open'))
            : null,
          create('button', { type: 'button', style: BUTTON_STYLE, 'data-testid': 'followup-banner-dismiss', onClick: onDismiss }, t('reminders.banner.dismiss')))));
}

/**
 * Install the frame-wide banner. The study route caller and dictionary
 * namespace come from the plugin body; the page itself is auto-discovered.
 * @param {object} ctx - Client plugin context (`slots`, `locale`, optional `layout`).
 * @param {{ namespace: string, call: Function, timer?: object, intervalMs?: number }} options - Wiring.
 * @returns {object | undefined} The feed when the overlay could be registered.
 * @throws when the namespace or route caller is missing (a wiring defect).
 */
export function installFollowupReminders(ctx, options = {}) {
  const { namespace, call } = options;
  if (typeof namespace !== 'string' || namespace === '') {
    throw new Error('installFollowupReminders needs the dictionary namespace the plugin body registered');
  }
  if (typeof call !== 'function') {
    throw new Error('installFollowupReminders needs the study route caller');
  }
  if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') {
    console.warn('[study] followup reminders stay off: this client context has no shell overlay slot');
    return undefined;
  }
  const feed = createReminderFeed({ call, timer: options.timer, intervalMs: options.intervalMs });
  let openPage;
  if (typeof ctx.inject === 'function') {
    ctx.inject(['layout'], (scope) => {
      if (typeof scope.layout?.selectPanel === 'function') {
        openPage = () => { scope.layout.selectPanel(PAGE_KEY); };
      }
    });
  }
  ctx.slots.inject(BANNER_SLOT, () => ctx.slots.register({
    name: BANNER_SLOT,
    id: BANNER_ID,
    order: BANNER_ORDER,
    locale: namespace,
    inject: () => ({ feed, openPage: openPage === undefined ? undefined : () => { openPage(); } }),
  }, RemindersBanner));
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { feed.dispose(); }, 'study: followup reminder feed');
  }
  return feed;
}
