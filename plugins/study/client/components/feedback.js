/**
 * Milestone feedback surface: a short completion toast, a once-per-period
 * stage card, and a quiet failure line. All three render into the frame-wide
 * `shell.overlay` and never take focus, block input, or open a dialog.
 *
 * The host does the counting. This module only keeps a local ledger of what it
 * already showed (Web Storage, with an in-memory fallback), so a reload or a
 * repeated poll cannot repeat a completion or a milestone. The first read after
 * a page load is a baseline: work recorded before the page opened is not
 * announced; only records that appear afterwards produce a toast.
 *
 * No model is involved. Two local polls drive it: `milestones.feedback` (one
 * day of confirmed completions) and `milestones.overview` (week/month stage
 * summaries). Both are read-only service calls; an outage hides the surface and
 * shows one retry line instead of inventing feedback.
 */
import { createElement as h, useSyncExternalStore } from 'react';

/** Frame-wide overlay slot the surface renders into. */
export const FEEDBACK_SLOT = 'shell.overlay';
/** Registration id inside the overlay. */
export const FEEDBACK_ID = 'study.milestones.feedback';
/** Local ledger of completion rows already announced. */
export const RECORDED_KEY = 'study.milestones.feedback.recorded';
/** Local ledger of milestones already announced. */
export const MILESTONES_KEY = 'study.milestones.feedback.milestones';
/** Local ledger of week/month cards already shown. */
export const SUMMARY_KEY = 'study.milestones.feedback.summary';
/** Ledger format version; an unknown version is discarded rather than guessed. */
export const LEDGER_VERSION = 1;
/** Entries kept in one ledger, newest last. */
export const LEDGER_LIMIT = 300;
/** How often confirmed completions are read (local route call, no model). */
export const FEEDBACK_INTERVAL_MS = 15000;
/** How often the week/month stage is read. */
export const SUMMARY_INTERVAL_MS = 600000;
/** How long one completion/milestone toast stays visible. */
export const TOAST_DURATION_MS = 6000;
/** How long the stage card stays visible before hiding itself. */
export const CARD_DURATION_MS = 30000;
/** Rows shown in one toast; older rows are dropped. */
export const MAX_TOAST_ITEMS = 3;

const ROOT_STYLE = {
  position: 'fixed', left: '20px', bottom: '20px', zIndex: 61,
  width: 'min(380px, calc(100vw - 40px))', boxSizing: 'border-box',
  display: 'flex', flexDirection: 'column', gap: '10px', pointerEvents: 'none',
};
const TOAST_STYLE = {
  pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: '8px',
  padding: '12px 14px', border: '1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.4))',
  borderRadius: '10px', background: 'var(--dsw-alias-bg-overlay, rgba(32, 32, 36, 0.96))',
  color: 'var(--dsw-alias-label-primary, inherit)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.24)',
  fontSize: '13px', lineHeight: 1.5,
};
const CARD_STYLE = {
  ...TOAST_STYLE, gap: '10px', maxHeight: 'min(60vh, 520px)', overflowY: 'auto',
};
const HEADER_STYLE = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' };
const TITLE_STYLE = { margin: 0, fontSize: '14px', fontWeight: 600 };
const RANGE_STYLE = { margin: 0, fontSize: '11.5px', opacity: 0.66, fontVariantNumeric: 'tabular-nums' };
const LIST_STYLE = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '4px' };
const LINE_STYLE = { margin: 0, fontSize: '12.5px', lineHeight: 1.6, opacity: 0.9 };
const META_STYLE = { margin: 0, fontSize: '11.5px', lineHeight: 1.6, opacity: 0.66 };
const BUTTON_STYLE = {
  appearance: 'none', border: '1px solid rgba(127, 127, 127, 0.45)', borderRadius: '6px',
  background: 'transparent', color: 'inherit', padding: '3px 10px', fontSize: '12px', cursor: 'pointer',
};
const ACTIONS_STYLE = { display: 'flex', justifyContent: 'flex-end', gap: '8px' };
const ERROR_STYLE = { ...TOAST_STYLE, borderStyle: 'dashed' };

/** In-memory Web Storage replacement for a blocked or absent area. */
function memoryArea() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

/**
 * Resolve one Web Storage area, falling back to memory when the access throws
 * (sandboxed frames) or the area refuses a probe write (private mode).
 * @param {object | undefined} provided - Injected area (tests), else `localStorage`.
 * @returns {{ getItem: Function, setItem: Function, removeItem: Function }} Usable area.
 */
function storageArea(provided) {
  let area;
  try {
    area = provided ?? globalThis.localStorage;
  } catch {
    return memoryArea();
  }
  if (area === null || typeof area !== 'object') return memoryArea();
  try {
    const probe = '__study_milestones_probe__';
    area.setItem(probe, '1');
    area.removeItem(probe);
    return area;
  } catch {
    return memoryArea();
  }
}

/** Read one versioned ledger, ignoring missing, malformed, or unknown-version data. */
function readLedger(area, key) {
  let raw;
  try {
    raw = area.getItem(key);
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('[study] milestone feedback ledger is not valid JSON and was ignored:', error);
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== LEDGER_VERSION) return null;
  return parsed;
}

/** Persist one ledger, reporting a refused write instead of failing the surface. */
function writeLedger(area, key, payload) {
  try {
    area.setItem(key, JSON.stringify({ version: LEDGER_VERSION, ...payload }));
  } catch (error) {
    console.warn('[study] milestone feedback ledger was not stored:', error);
  }
}

/** Trim a Set-like list to the most recent entries. */
function trim(list) {
  return list.length > LEDGER_LIMIT ? list.slice(list.length - LEDGER_LIMIT) : list;
}

/** Read the announced completion tokens. */
function readRecorded(area) {
  const ledger = readLedger(area, RECORDED_KEY);
  const list = Array.isArray(ledger?.tokens) ? ledger.tokens.filter(token => typeof token === 'string') : [];
  return new Set(list);
}

/** Read the announced milestone keys (`<id>@<achievedOn>`). */
function readMilestones(area) {
  const ledger = readLedger(area, MILESTONES_KEY);
  const list = Array.isArray(ledger?.keys) ? ledger.keys.filter(key => typeof key === 'string') : [];
  return new Set(list);
}

/** Read which week/month card was already shown. */
function readShown(area) {
  const ledger = readLedger(area, SUMMARY_KEY);
  const result = {};
  for (const period of ['week', 'month']) {
    const from = ledger?.[period];
    result[period] = typeof from === 'string' && from.length > 0 ? from : null;
  }
  return result;
}

/** Whether a value looks like one stage summary from `milestones.overview`. */
function isStage(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.from === 'string'
    && typeof value.to === 'string'
    && Array.isArray(value.lines)
    && Array.isArray(value.earned)
    && value.counts !== null
    && typeof value.counts === 'object';
}

/** A non-negative safe integer, for deciding whether a card has evidence. */
function countOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Localized text over the shipped dictionary, falling back to the host sentence. */
function message(t, key, params, fallback) {
  const text = t(key, params);
  return text === key ? fallback : text;
}

/** Localized milestone title; an unknown id keeps the host title. */
function milestoneTitle(t, milestone) {
  if (milestone === null || typeof milestone !== 'object') return '';
  const key = `feedback.milestone.${String(milestone.id)}`;
  return message(t, key, undefined, typeof milestone.title === 'string' ? milestone.title : String(milestone.id));
}

/**
 * Build the feedback state machine over injectable edges.
 * @param {{
 *   call: Function,
 *   storage?: object,
 *   timer?: { setTimeout: Function, clearTimeout: Function },
 *   now?: () => number,
 *   feedbackIntervalMs?: number,
 *   summaryIntervalMs?: number,
 *   toastDurationMs?: number,
 *   cardDurationMs?: number,
 * }} options - Edges; the route caller is required.
 * @returns {object} Feed with `source`, `start`, `stop`, `pollFeedback`, `pollSummary`,
 *   `dismissToast`, `dismissCard`, and `retry`.
 */
export function createMilestoneFeed(options = {}) {
  const call = options.call;
  if (typeof call !== 'function') throw new TypeError('createMilestoneFeed needs the study route caller');
  const timer = options.timer ?? globalThis;
  const now = options.now ?? (() => Date.now());
  const feedbackIntervalMs = options.feedbackIntervalMs ?? FEEDBACK_INTERVAL_MS;
  const summaryIntervalMs = options.summaryIntervalMs ?? SUMMARY_INTERVAL_MS;
  const toastDurationMs = options.toastDurationMs ?? TOAST_DURATION_MS;
  const cardDurationMs = options.cardDurationMs ?? CARD_DURATION_MS;
  const storage = storageArea(options.storage);
  const recorded = readRecorded(storage);
  const milestones = readMilestones(storage);
  const shown = readShown(storage);

  const listeners = new Set();
  const errors = { feedback: null, summary: null };
  let snapshot = Object.freeze({
    phase: 'loading',
    error: null,
    toasts: Object.freeze([]),
    card: null,
    at: 0,
    seq: 0,
  });
  let feedbackBaseline = false;
  let overviewBaseline = false;
  let feedbackTimer;
  let summaryTimer;
  let toastTimer;
  let cardTimer;
  let started = false;

  /** Publish one immutable snapshot to the subscribed components. */
  function publish(patch) {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[study] milestone feedback subscriber failed:', error);
      }
    }
  }

  /** Recompute the visible failure from both scopes. */
  function publishErrors() {
    const error = errors.feedback !== null
      ? { scope: 'feedback', message: errors.feedback }
      : errors.summary !== null
        ? { scope: 'summary', message: errors.summary }
        : null;
    publish({ phase: error === null ? 'ready' : 'error', error });
  }

  /** Record a failed read without discarding whatever is already on screen. */
  function fail(scope, error) {
    errors[scope] = error instanceof Error ? error.message : String(error);
    publishErrors();
  }

  /** Clear one scope's failure after a successful read. */
  function succeed(scope) {
    if (errors[scope] === null) return;
    errors[scope] = null;
    publishErrors();
  }

  /** Persist the completion ledger in insertion order (bounded). */
  function persistRecorded() {
    writeLedger(storage, RECORDED_KEY, { tokens: trim([...recorded]) });
  }

  /** Persist the milestone ledger in insertion order (bounded). */
  function persistMilestones() {
    writeLedger(storage, MILESTONES_KEY, { keys: trim([...milestones]) });
  }

  /** Persist which week/month cards were already shown. */
  function persistShown() {
    writeLedger(storage, SUMMARY_KEY, { week: shown.week, month: shown.month });
  }

  /** Show one merged toast group, restarting its dismissal timer. */
  function showToasts(entries) {
    if (entries.length === 0) return;
    const byToken = new Map();
    for (const entry of [...snapshot.toasts, ...entries]) byToken.set(entry.token, entry);
    const toasts = [...byToken.values()].slice(-MAX_TOAST_ITEMS);
    if (toastTimer !== undefined) timer.clearTimeout(toastTimer);
    publish({ toasts: Object.freeze(toasts), at: now(), seq: snapshot.seq + 1 });
    toastTimer = timer.setTimeout(() => {
      toastTimer = undefined;
      publish({ toasts: Object.freeze([]) });
    }, toastDurationMs);
  }

  /** Show the stage card once, and remember the shown period immediately. */
  function showCard(stage) {
    if (cardTimer !== undefined) timer.clearTimeout(cardTimer);
    shown[stage.period] = stage.from;
    persistShown();
    publish({
      card: Object.freeze({
        key: `${stage.period}:${stage.from}`,
        period: stage.period,
        from: stage.from,
        to: stage.to,
        lines: Object.freeze(stage.lines.map(line => Object.freeze({ key: line.key, values: line.values ?? {}, text: line.text ?? '' }))),
        earned: Object.freeze(stage.earned.map(milestone => Object.freeze({
          id: milestone.id,
          title: milestone.title,
          achievedOn: milestone.achievedOn,
        }))),
        next: stage.next === null ? null : Object.freeze({ ...stage.next }),
        streak: Object.freeze({ ...(stage.streak ?? {}) }),
        at: now(),
        seq: snapshot.seq + 1,
      }),
    });
    cardTimer = timer.setTimeout(() => {
      cardTimer = undefined;
      publish({ card: null });
    }, cardDurationMs);
  }

  /** Choose the first period whose stage has evidence and was not shown yet. */
  function dueStage(overview) {
    // Do not replace a card the student may still be reading; the next period
    // waits for the current card to be dismissed or to hide itself.
    if (snapshot.card !== null) return null;
    for (const period of ['week', 'month']) {
      const stage = overview[period];
      if (!isStage(stage)) continue;
      const hasEvidence = countOf(stage.counts.recorded) > 0 || countOf(stage.earnedCount) > 0;
      if (!hasEvidence) continue;
      if (shown[period] === stage.from) continue;
      return stage;
    }
    return null;
  }

  /**
   * Read today's confirmed completions and toast the ones this page has not
   * announced yet. The first successful read is a baseline.
   */
  async function pollFeedback() {
    try {
      const envelope = await call('milestones', 'feedback', {});
      const value = envelope?.value;
      if (value === null || typeof value !== 'object' || !Array.isArray(value.items)) {
        throw new Error('milestones.feedback returned no item list');
      }
      const fresh = [];
      for (const item of value.items) {
        if (item === null || typeof item !== 'object' || typeof item.token !== 'string') continue;
        if (recorded.has(item.token)) continue;
        recorded.add(item.token);
        if (feedbackBaseline) {
          fresh.push({
            token: `record:${item.token}`,
            type: 'record',
            title: typeof item.title === 'string' && item.title.length > 0 ? item.title : null,
            recordDate: typeof item.recordDate === 'string' ? item.recordDate : null,
          });
        }
      }
      persistRecorded();
      if (!feedbackBaseline) {
        feedbackBaseline = true;
      } else {
        showToasts(fresh);
      }
      succeed('feedback');
      if (snapshot.phase === 'loading') publish({ phase: 'ready' });
    } catch (error) {
      fail('feedback', error);
    }
  }

  /**
   * Read the week/month stage, announce newly earned milestones, and show the
   * due stage card. The first successful read is a milestone baseline.
   */
  async function pollSummary() {
    try {
      const envelope = await call('milestones', 'overview', {});
      const value = envelope?.value;
      if (value === null || typeof value !== 'object' || !isStage(value.week) || !isStage(value.month)) {
        throw new Error('milestones.overview returned no week/month stage');
      }
      const fresh = [];
      for (const period of ['week', 'month']) {
        for (const milestone of value[period].earned) {
          if (milestone === null || typeof milestone !== 'object') continue;
          if (typeof milestone.id !== 'string' || typeof milestone.achievedOn !== 'string') continue;
          const key = `${milestone.id}@${milestone.achievedOn}`;
          if (milestones.has(key)) continue;
          milestones.add(key);
          if (overviewBaseline) {
            fresh.push({
              token: `milestone:${key}`,
              type: 'milestone',
              id: milestone.id,
              title: typeof milestone.title === 'string' ? milestone.title : milestone.id,
              achievedOn: milestone.achievedOn,
            });
          }
        }
      }
      persistMilestones();
      if (!overviewBaseline) overviewBaseline = true;
      const stage = dueStage(value);
      if (stage !== null) showCard(stage);
      showToasts(fresh);
      succeed('summary');
      if (snapshot.phase === 'loading') publish({ phase: 'ready' });
    } catch (error) {
      fail('summary', error);
    }
  }

  /** Schedule the next completion poll; a stopped feed does not reschedule. */
  function scheduleFeedback(delay) {
    if (!started) return;
    feedbackTimer = timer.setTimeout(async () => {
      feedbackTimer = undefined;
      await pollFeedback();
      scheduleFeedback(feedbackIntervalMs);
    }, delay);
  }

  /** Schedule the next stage poll; a stopped feed does not reschedule. */
  function scheduleSummary(delay) {
    if (!started) return;
    summaryTimer = timer.setTimeout(async () => {
      summaryTimer = undefined;
      await pollSummary();
      scheduleSummary(summaryIntervalMs);
    }, delay);
  }

  /** Start both local polls and their loops; the first subscribe calls this. */
  function start() {
    if (started) return;
    started = true;
    scheduleFeedback(0);
    scheduleSummary(0);
  }

  /** Stop the polls and hide everything this surface owns; a later start may restart it. */
  function stop() {
    started = false;
    for (const handle of [feedbackTimer, summaryTimer, toastTimer, cardTimer]) {
      if (handle !== undefined) timer.clearTimeout(handle);
    }
    feedbackTimer = undefined;
    summaryTimer = undefined;
    toastTimer = undefined;
    cardTimer = undefined;
    publish({ toasts: Object.freeze([]), card: null });
  }

  /** Hide the toast immediately. */
  function dismissToast() {
    if (toastTimer !== undefined) {
      timer.clearTimeout(toastTimer);
      toastTimer = undefined;
    }
    if (snapshot.toasts.length > 0) publish({ toasts: Object.freeze([]) });
  }

  /** Hide the stage card immediately; it stays marked as shown for this period. */
  function dismissCard() {
    if (cardTimer !== undefined) {
      timer.clearTimeout(cardTimer);
      cardTimer = undefined;
    }
    if (snapshot.card !== null) publish({ card: null });
  }

  /** Read both surfaces immediately after a failure. */
  async function retry() {
    errors.feedback = null;
    errors.summary = null;
    publishErrors();
    await Promise.all([pollFeedback(), pollSummary()]);
  }

  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        // Poll only while the overlay is mounted: a context that never renders
        // the surface (unit tests, disabled shell) must not leave timers behind.
        start();
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) stop();
        };
      },
    },
    start,
    stop,
    pollFeedback,
    pollSummary,
    dismissToast,
    dismissCard,
    retry,
  };
}

/**
 * Rendered overlay. Toast rows are `role="status"` and polite, the stage card
 * is a plain section, and neither is modal or focus-stealing.
 * @param {{
 *   t: Function,
 *   useMilestones: (selector: (state: object) => unknown) => unknown,
 *   dismissToast: Function,
 *   dismissCard: Function,
 *   retry: Function,
 * }} props - Locale seat and the injected feed callbacks.
 * @returns {object | null} Overlay element, or nothing while it has no content.
 */
export function MilestoneFeedback({ t, useMilestones, dismissToast, dismissCard, retry }) {
  const state = useMilestones(current => current);
  return FeedbackView({
    create: h,
    t,
    state,
    onDismissToast: dismissToast,
    onDismissCard: dismissCard,
    onRetry: retry,
  });
}

/**
 * Render one state of the feedback surface without React.
 * @param {{
 *   create: Function,
 *   t: Function,
 *   state: { toasts?: Array<object>, card?: object | null, error?: object | null },
 *   onDismissToast: Function,
 *   onDismissCard: Function,
 *   onRetry: Function,
 * }} props - Render inputs; `create` is the React element factory.
 * @returns {object | null} Overlay element, or null when there is nothing to show.
 */
export function FeedbackView(props) {
  const { create, t, state } = props;
  const toasts = Array.isArray(state?.toasts) ? state.toasts : [];
  const card = state?.card ?? null;
  const error = state?.error ?? null;
  if (toasts.length === 0 && card === null && error === null) return null;
  return create('div', { 'data-testid': 'study-milestones-feedback', style: ROOT_STYLE },
    toasts.length === 0 ? null : renderToast(create, t, toasts, props.onDismissToast),
    card === null ? null : renderCard(create, t, card, props.onDismissCard),
    error === null ? null : renderError(create, t, error, props.onRetry));
}

/** One completion/milestone toast with a single dismiss button. */
function renderToast(create, t, toasts, dismiss) {
  return create('div', {
    role: 'status',
    'aria-live': 'polite',
    'data-testid': 'study-feedback-toast',
    style: TOAST_STYLE,
  },
  create('ul', { style: LIST_STYLE }, toasts.map(entry => create('li', {
    key: entry.token,
    'data-testid': `study-feedback-toast-${entry.type}`,
    style: LINE_STYLE,
  }, toastText(t, entry)))),
  create('div', { style: ACTIONS_STYLE },
    create('button', {
      type: 'button',
      'data-testid': 'study-feedback-toast-dismiss',
      style: BUTTON_STYLE,
      onClick: dismiss,
    }, t('feedback.toast.dismiss'))));
}

/** The one sentence of a toast row. */
function toastText(t, entry) {
  if (entry.type === 'milestone') {
    return t('feedback.toast.milestone', { title: milestoneTitle(t, entry) });
  }
  const title = typeof entry.title === 'string' && entry.title.length > 0
    ? entry.title
    : t('feedback.toast.untitled');
  return t('feedback.toast.record', { title });
}

/** The once-per-period stage card: range, evidence lines, milestones, next step. */
function renderCard(create, t, card, dismiss) {
  const titleKey = card.period === 'month' ? 'feedback.card.month' : 'feedback.card.week';
  return create('section', {
    'data-testid': 'study-milestone-summary',
    'data-period': card.period,
    style: CARD_STYLE,
  },
  create('div', { style: HEADER_STYLE },
    create('div', null,
      create('h2', { style: TITLE_STYLE }, t(titleKey)),
      create('p', { style: RANGE_STYLE }, t('feedback.card.range', { from: card.from, to: card.to }))),
    create('button', {
      type: 'button',
      'data-testid': 'study-milestone-summary-dismiss',
      style: BUTTON_STYLE,
      onClick: dismiss,
    }, t('feedback.card.dismiss'))),
  create('ul', { 'data-testid': 'study-milestone-lines', style: LIST_STYLE },
    (card.lines ?? []).map(line => create('li', {
      key: line.key,
      'data-testid': `study-milestone-line-${line.key}`,
      style: LINE_STYLE,
    }, lineText(t, line)))),
  create('div', null,
    create('p', { style: TITLE_STYLE }, t('feedback.card.milestones')),
    (card.earned ?? []).length === 0
      ? create('p', { 'data-testid': 'study-milestone-none', style: META_STYLE }, t('feedback.card.noMilestones'))
      : create('ul', { 'data-testid': 'study-milestone-earned', style: LIST_STYLE },
        card.earned.map(milestone => create('li', {
          key: `${milestone.id}@${milestone.achievedOn}`,
          'data-testid': `study-milestone-${milestone.id}`,
          style: LINE_STYLE,
        }, milestoneTitle(t, milestone), milestone.achievedOn === null
          ? null
          : ` · ${t('feedback.milestone.achieved', { date: milestone.achievedOn })}`)))),
  card.next === null
    ? null
    : create('p', { 'data-testid': 'study-milestone-next', style: META_STYLE },
      t('feedback.card.next', { title: milestoneTitle(t, card.next), remaining: card.next.remaining })),
  create('p', { 'data-testid': 'study-milestone-policy', style: META_STYLE }, t('feedback.card.policy')));
}

/** The evidence line, localized over the host's key and values. */
function lineText(t, line) {
  if (line === null || typeof line !== 'object' || typeof line.key !== 'string') return '';
  return message(t, `feedback.line.${line.key}`, line.values ?? {}, line.text ?? '');
}

/** One quiet failure line with an explicit retry. */
function renderError(create, t, error, retry) {
  const key = error.scope === 'summary' ? 'feedback.error.summary' : 'feedback.error.feedback';
  return create('div', {
    role: 'status',
    'data-testid': 'study-feedback-error',
    style: ERROR_STYLE,
  },
  create('p', { style: LINE_STYLE }, t(key, { message: String(error.message ?? '') })),
  create('div', { style: ACTIONS_STYLE },
    create('button', {
      type: 'button',
      'data-testid': 'study-feedback-retry',
      style: BUTTON_STYLE,
      onClick: retry,
    }, t('feedback.error.retry'))));
}

/**
 * Install the feedback surface into one client plugin.
 * @param {object} ctx - Client plugin context (`slots`, `locale`, `effect`).
 * @param {{
 *   namespace: string, call: Function, feed?: object, storage?: object,
 *   timer?: object, now?: Function, feedbackIntervalMs?: number,
 *   summaryIntervalMs?: number, toastDurationMs?: number, cardDurationMs?: number,
 * }} options - Dictionary namespace, the study route caller, and optional test edges.
 * @returns {object | undefined} The feed, or undefined when this client cannot host slots.
 * @throws when the namespace or route caller is missing (a wiring defect).
 */
export function installMilestoneFeedback(ctx, options = {}) {
  const namespace = options.namespace;
  if (typeof namespace !== 'string' || namespace === '') {
    throw new Error('installMilestoneFeedback needs the dictionary namespace the plugin body registered');
  }
  if (typeof options.call !== 'function') {
    throw new Error('installMilestoneFeedback needs the study route caller');
  }
  if (typeof ctx?.slots?.inject !== 'function' || typeof ctx.effect !== 'function') {
    console.warn('[study] milestone feedback stays off: this client context cannot host overlay slots');
    return undefined;
  }
  const feed = options.feed ?? createMilestoneFeed({
    call: options.call,
    storage: options.storage,
    timer: options.timer,
    now: options.now,
    feedbackIntervalMs: options.feedbackIntervalMs,
    summaryIntervalMs: options.summaryIntervalMs,
    toastDurationMs: options.toastDurationMs,
    cardDurationMs: options.cardDurationMs,
  });
  ctx.effect(() => () => { feed.stop(); }, 'study: milestone feedback lifecycle');
  ctx.slots.inject(FEEDBACK_SLOT, () => ctx.slots.register({
    name: FEEDBACK_SLOT,
    id: FEEDBACK_ID,
    locale: namespace,
    inject: () => ({
      hooks: { milestones: feed.source },
      dismissToast: feed.dismissToast,
      dismissCard: feed.dismissCard,
      retry: feed.retry,
    }),
  }, MilestoneFeedback));
  return feed;
}
