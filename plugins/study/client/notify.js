/**
 * Reply-completion reminders.
 *
 * A turn is over when the client Session list reports a row's `running` flag
 * falling from true to false. That transition is the only trigger, so a reload
 * (which starts from an idle baseline) cannot repeat a reminder. Completions
 * that land inside one merge window become one notice: one system notification
 * carrying a fixed tag, plus one banner in the shell overlay. The banner is the
 * fallback and renders regardless of the `Notification` API, so a missing or
 * denied permission degrades instead of silencing the reminder.
 *
 * Nothing here reads the study database. The on/off choice and the
 * already-announced ledger live in Web Storage, and every edge (clock, timer,
 * storage, notification API, navigation) is injectable for the Node tests.
 */
import { createElement as h } from 'react';

/** Slot key of the frame-wide overlay the banner renders into. */
export const BANNER_SLOT = 'shell.overlay';
/** Registration id of the banner inside {@link BANNER_SLOT}. */
export const BANNER_ID = 'study.completion-notify';
/** Slot key of the General settings rows the switch renders into. */
export const SETTINGS_SLOT = 'settings.general.item';
/** Registration id of the settings row inside {@link SETTINGS_SLOT}. */
export const SETTINGS_ID = 'study.completion-notify';
/** Row position among the General settings items. */
export const SETTINGS_ORDER = 40;
/** Storage key of the on/off preference. */
export const ENABLED_KEY = 'study.notify.completion.enabled';
/** Storage key of the announced-turn ledger. */
export const ANNOUNCED_KEY = 'study.notify.completion.announced';
/** Ledger format version; an unknown version is discarded rather than guessed. */
export const ANNOUNCED_VERSION = 1;
/** Announcements kept in the ledger, newest first. */
export const ANNOUNCED_LIMIT = 100;
/** Completions closer together than this become one reminder. */
export const MERGE_WINDOW_MS = 1200;
/** How long the banner stays on screen. */
export const BANNER_DURATION_MS = 8000;
/** Notification tag: a later reminder replaces the previous one instead of stacking. */
export const NOTIFICATION_TAG = 'study.completion';

const BANNER_STYLE = {
  position: 'fixed', right: '20px', bottom: '20px', zIndex: 60,
  width: 'min(360px, calc(100vw - 40px))', boxSizing: 'border-box',
  display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px',
  border: '1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.4))',
  borderRadius: '12px', background: 'var(--dsw-alias-bg-overlay, rgba(32, 32, 36, 0.96))',
  color: 'var(--dsw-alias-label-primary, inherit)',
  boxShadow: '0 10px 30px rgba(0, 0, 0, 0.28)', fontSize: '13px', lineHeight: 1.5,
};
const HEADLINE_STYLE = { margin: 0, fontWeight: 600 };
const LIST_STYLE = { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' };
const HINT_STYLE = { margin: 0, opacity: 0.7, fontSize: '12px' };
const ACTIONS_STYLE = { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' };
const BUTTON_STYLE = {
  appearance: 'none', border: '1px solid rgba(127, 127, 127, 0.45)', borderRadius: '6px',
  background: 'transparent', color: 'inherit', padding: '4px 10px', fontSize: '12.5px', cursor: 'pointer',
};
const LINK_STYLE = {
  appearance: 'none', border: 'none', background: 'transparent', color: 'inherit',
  padding: 0, font: 'inherit', textDecoration: 'underline', cursor: 'pointer', textAlign: 'left',
};
const SETTING_ROW_STYLE = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', padding: '12px 0' };
const SETTING_TEXT_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px' };
const SETTING_LABEL_STYLE = { fontSize: '13.5px', fontWeight: 500 };
const SETTING_DESCRIPTION_STYLE = { margin: 0, fontSize: '12.5px', lineHeight: 1.6, opacity: 0.7, maxWidth: '46ch' };
const SWITCH_STYLE = {
  appearance: 'none', borderRadius: '999px', padding: '4px 14px', minWidth: '68px',
  border: '1px solid rgba(127, 127, 127, 0.45)', background: 'transparent',
  color: 'inherit', font: 'inherit', fontSize: '12.5px', cursor: 'pointer',
};
const SWITCH_ON_STYLE = {
  ...SWITCH_STYLE,
  border: '1px solid rgba(64, 128, 255, 0.65)',
  background: 'rgba(64, 128, 255, 0.16)',
};

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
 * @param {() => object | undefined} resolve - Area reader.
 * @returns {{ getItem: Function, setItem: Function, removeItem: Function }} Usable area.
 */
function storageArea(resolve) {
  let area;
  try {
    area = resolve();
  } catch {
    // Reading `localStorage` throws when the frame denies storage access.
    return memoryArea();
  }
  try {
    const probe = '__study_notify_probe__';
    area.setItem(probe, '1');
    area.removeItem(probe);
    return area;
  } catch {
    // Private mode keeps the property but refuses writes.
    return memoryArea();
  }
}

/**
 * Normalize the reported permission into the states the UI understands.
 * @param {{ supported: boolean, permission: string }} gateway - Notification gateway.
 * @returns {'unsupported' | 'default' | 'granted' | 'denied'} Permission state.
 */
function permissionOf(gateway) {
  if (gateway.supported !== true) return 'unsupported';
  const value = gateway.permission;
  return value === 'granted' || value === 'denied' ? value : 'default';
}

/**
 * Browser `Notification` adapter. Every method tolerates an absent, refusing, or
 * untrusted API: the reminder still reaches the in-app banner.
 * @param {object} [env] - Host object carrying `Notification` (the browser global by default).
 * @returns {{ supported: boolean, permission: string, requestPermission: Function, show: Function }} Gateway.
 */
export function createBrowserGateway(env = globalThis) {
  const Constructor = env?.Notification;
  const supported = typeof Constructor === 'function';
  return {
    supported,
    get permission() {
      if (!supported) return 'unsupported';
      const value = Constructor.permission;
      return typeof value === 'string' ? value : 'default';
    },
    async requestPermission() {
      if (!supported) return 'unsupported';
      try {
        const answer = await Constructor.requestPermission();
        return typeof answer === 'string' ? answer : permissionOf({ supported, permission: Constructor.permission });
      } catch (error) {
        console.warn('[study] reply reminder could not ask for notification permission:', error);
        return 'denied';
      }
    },
    show({ title, body, tag, onClick }) {
      if (!supported || Constructor.permission !== 'granted') return undefined;
      try {
        const notice = new Constructor(title, { body, tag });
        notice.onclick = () => {
          try {
            if (typeof onClick === 'function') onClick();
          } finally {
            notice.close?.();
          }
        };
        return notice;
      } catch (error) {
        console.warn('[study] reply reminder could not show a system notification:', error);
        return undefined;
      }
    },
  };
}

/**
 * Build the reminder state machine over injectable edges.
 * @param {{
 *   translate?: (key: string, params?: Record<string, unknown>) => string,
 *   gateway?: ReturnType<typeof createBrowserGateway>,
 *   storage?: { local?: object, session?: object },
 *   timer?: { setTimeout: Function, clearTimeout: Function },
 *   now?: () => number,
 *   focus?: (sessionId: string) => void,
 *   isWatching?: (sessionId: string) => boolean,
 *   mergeWindowMs?: number,
 *   bannerDurationMs?: number,
 * }} [options] - Edges; every field defaults to its browser counterpart.
 * @returns {object} Notifier with `source`, `observe`, `setEnabled`, `focus`, `dismiss`, `dispose`.
 */
export function createCompletionNotifier(options = {}) {
  const translate = options.translate ?? (key => key);
  const gateway = options.gateway ?? createBrowserGateway();
  const timer = options.timer ?? globalThis;
  const now = options.now ?? (() => Date.now());
  const mergeWindowMs = options.mergeWindowMs ?? MERGE_WINDOW_MS;
  const bannerDurationMs = options.bannerDurationMs ?? BANNER_DURATION_MS;
  const focusSession = options.focus;
  const watched = options.isWatching ?? (() => false);
  const local = storageArea(() => options.storage?.local ?? globalThis.localStorage);
  const session = storageArea(() => options.storage?.session ?? globalThis.sessionStorage);

  const listeners = new Set();
  const running = new Map();
  const announced = readAnnounced();
  const pending = [];
  let snapshot = Object.freeze({
    enabled: readEnabled(),
    osStatus: permissionOf(gateway),
    focusable: typeof focusSession === 'function',
    entries: Object.freeze([]),
    at: 0,
    seq: 0,
  });
  let mergeTimer;
  let dismissTimer;
  let prompted = false;
  let disposed = false;

  /**
   * Replace the published snapshot and notify the registered hooks.
   * @param {object} patch - Changed fields.
   */
  function publish(patch) {
    if (disposed) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[study] reply reminder subscriber failed:', error);
      }
    }
  }

  /** @param {string} value - Permission state to publish when it changed. */
  function setOsStatus(value) {
    if (snapshot.osStatus !== value) publish({ osStatus: value });
  }

  /** @returns {boolean} Whether reminders are on, defaulting to on. */
  function readEnabled() {
    return local.getItem(ENABLED_KEY) !== '0';
  }

  /**
   * Read the already-announced ledger.
   * @returns {Map<string, number>} Session id to the announced turn's activity stamp.
   */
  function readAnnounced() {
    const ledger = new Map();
    const raw = session.getItem(ANNOUNCED_KEY);
    if (typeof raw !== 'string' || raw === '') return ledger;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn('[study] reply reminder ledger is not valid JSON and was ignored:', error);
      return ledger;
    }
    if (parsed?.version !== ANNOUNCED_VERSION || parsed.sessions === null || typeof parsed.sessions !== 'object') return ledger;
    for (const [id, stamp] of Object.entries(parsed.sessions)) {
      if (typeof stamp === 'number' && Number.isFinite(stamp)) ledger.set(id, stamp);
    }
    return ledger;
  }

  /** Persist the ledger, newest first and bounded. */
  function writeAnnounced() {
    const sessions = {};
    const newest = [...announced.entries()].sort((left, right) => right[1] - left[1]).slice(0, ANNOUNCED_LIMIT);
    for (const [id, stamp] of newest) sessions[id] = stamp;
    try {
      session.setItem(ANNOUNCED_KEY, JSON.stringify({ version: ANNOUNCED_VERSION, sessions }));
    } catch (error) {
      console.warn('[study] reply reminder ledger was not stored:', error);
    }
  }

  /**
   * Record one finished turn, merging it into the waiting group.
   * @param {string} sessionId - Session whose turn ended.
   * @param {object} row - Its Session list row.
   */
  function complete(sessionId, row) {
    if (!snapshot.enabled) return;
    const stamp = typeof row?.updatedAt === 'number' && Number.isFinite(row.updatedAt) && row.updatedAt > 0
      ? row.updatedAt
      : 0;
    if (stamp > 0 && announced.get(sessionId) === stamp) return;
    if (watched(sessionId)) return;
    if (stamp > 0) {
      announced.set(sessionId, stamp);
      writeAnnounced();
    }
    pending.push({
      sessionId,
      title: typeof row?.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : String(sessionId),
      completedAt: now(),
    });
    if (mergeTimer === undefined) mergeTimer = timer.setTimeout(flush, mergeWindowMs);
  }

  /** Publish the merged group as one reminder. */
  function flush() {
    mergeTimer = undefined;
    if (disposed || pending.length === 0) return;
    const seen = new Set();
    const entries = [];
    for (const entry of pending.splice(0, pending.length)) {
      if (seen.has(entry.sessionId)) continue;
      seen.add(entry.sessionId);
      entries.push(entry);
    }
    publish({ entries: Object.freeze(entries), at: now(), seq: snapshot.seq + 1 });
    scheduleDismiss();
    announce(entries);
  }

  /** Clear the banner after its display window. */
  function scheduleDismiss() {
    if (dismissTimer !== undefined) timer.clearTimeout(dismissTimer);
    dismissTimer = timer.setTimeout(() => {
      dismissTimer = undefined;
      clear();
    }, bannerDurationMs);
  }

  /** Drop the visible banner and its dismissal timer. */
  function clear() {
    if (dismissTimer !== undefined) {
      timer.clearTimeout(dismissTimer);
      dismissTimer = undefined;
    }
    if (snapshot.entries.length === 0) return;
    publish({ entries: Object.freeze([]) });
  }

  /**
   * Resolve the system notification permission, asking at most once per page
   * lifetime unless an explicit gesture resets the prompt.
   * @returns {string | Promise<string>} Settled state; a string when no prompt is needed.
   */
  function ensurePermission() {
    if (gateway.supported !== true) {
      setOsStatus('unsupported');
      return 'unsupported';
    }
    const current = permissionOf(gateway);
    if (current === 'granted' || current === 'denied') {
      setOsStatus(current);
      return current;
    }
    if (prompted) return 'default';
    prompted = true;
    setOsStatus('requesting');
    return Promise.resolve()
      .then(() => gateway.requestPermission())
      .then(answer => (answer === 'granted' || answer === 'denied' ? answer : 'default'))
      .catch(error => {
        console.warn('[study] reply reminder permission request failed:', error);
        return 'denied';
      })
      .then((settled) => {
        setOsStatus(settled);
        return settled;
      });
  }

  /**
   * Show the system notification for one merged group.
   * @param {Array<{ sessionId: string, title: string }>} entries - Merged completions.
   */
  function showNotice(entries) {
    const newest = entries[entries.length - 1];
    gateway.show({
      title: translate('notify.notification.title'),
      body: entries.length === 1
        ? translate('notify.banner.single', { title: entries[0].title })
        : translate('notify.banner.merged', { count: entries.length }),
      tag: NOTIFICATION_TAG,
      onClick: () => { focus(newest.sessionId); },
    });
  }

  /**
   * Announce one merged group, asking for permission only when the browser has
   * not decided yet. An already-decided permission shows the notification
   * without leaving the caller's turn.
   * @param {Array<{ sessionId: string, title: string }>} entries - Merged completions.
   */
  function announce(entries) {
    const permission = ensurePermission();
    if (typeof permission === 'string') {
      if (permission === 'granted') showNotice(entries);
      return;
    }
    void permission.then((settled) => {
      if (settled === 'granted') showNotice(entries);
    });
  }

  /**
   * Reconcile the Session list into completion events.
   * @param {{ byId?: Record<string, object> }} list - Current `SessionListState`.
   */
  function observe(list) {
    if (disposed) return;
    const byId = list?.byId ?? {};
    const next = new Map();
    for (const id of Object.keys(byId)) {
      const row = byId[id];
      if (row?.origin === 'subagent') continue;
      const isRunning = row?.running === true;
      next.set(id, isRunning);
      if (running.get(id) === true && !isRunning) complete(id, row);
    }
    running.clear();
    for (const [id, value] of next) running.set(id, value);
  }

  /**
   * Turn reminders on or off, persisting the choice. Turning them on again is an
   * explicit gesture, so it may ask for the system permission once more.
   * @param {boolean} value - Requested state.
   */
  function setEnabled(value) {
    const next = value === true;
    if (snapshot.enabled !== next) {
      try {
        local.setItem(ENABLED_KEY, next ? '1' : '0');
      } catch (error) {
        console.warn('[study] reply reminder preference was not stored:', error);
      }
      publish({ enabled: next });
    }
    if (!next) {
      pending.splice(0, pending.length);
      if (mergeTimer !== undefined) {
        timer.clearTimeout(mergeTimer);
        mergeTimer = undefined;
      }
      clear();
      return;
    }
    prompted = false;
    if (snapshot.osStatus === 'default' || snapshot.osStatus === 'requesting') void ensurePermission();
  }

  /**
   * Open the session behind one entry, then clear the banner.
   * @param {string} sessionId - Session to show.
   */
  function focus(sessionId) {
    if (typeof focusSession === 'function') {
      try {
        focusSession(sessionId);
      } catch (error) {
        console.error('[study] reply reminder could not open the session:', error);
      }
    }
    clear();
  }

  /** Clear the banner without opening anything. */
  function dismiss() {
    clear();
  }

  /** Release timers, listeners, and the visible banner with the owning plugin. */
  function dispose() {
    if (disposed) return;
    if (mergeTimer !== undefined) {
      timer.clearTimeout(mergeTimer);
      mergeTimer = undefined;
    }
    pending.splice(0, pending.length);
    clear();
    disposed = true;
    running.clear();
    listeners.clear();
  }

  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    observe,
    setEnabled,
    focus,
    dismiss,
    dispose,
  };
}

/**
 * Frame-wide banner: one row per merged completion, with the fallback note when
 * the system notification is not available.
 * @param {{
 *   t: (key: string, params?: Record<string, unknown>) => string,
 *   useCompletion: (selector: (state: object) => unknown) => unknown,
 *   focus: (sessionId: string) => void,
 *   dismiss: () => void,
 *   setEnabled: (value: boolean) => void,
 * }} props - Framework locale seat and injected reminder callbacks.
 * @returns {object | null} Banner element, or nothing while it is empty.
 */
export function CompletionBanner({ t, useCompletion, focus, dismiss, setEnabled }) {
  const state = useCompletion(snapshot => snapshot);
  if (!state.enabled || state.entries.length === 0) return null;
  const merged = state.entries.length > 1;
  const newest = state.entries[state.entries.length - 1];
  const headline = merged
    ? t('notify.banner.merged', { count: state.entries.length })
    : t('notify.banner.single', { title: state.entries[0].title });
  return h('div', {
    role: 'status',
    'aria-live': 'polite',
    'data-testid': 'study-completion-notice',
    style: BANNER_STYLE,
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
    h('p', { style: HEADLINE_STYLE }, headline),
    merged
      ? h('ul', { style: LIST_STYLE }, state.entries.map(entry => h('li', { key: entry.sessionId },
        h('button', {
          type: 'button',
          style: LINK_STYLE,
          onClick: () => { focus(entry.sessionId); },
        }, entry.title))))
      : null,
    state.osStatus === 'granted'
      ? null
      : h('p', { style: HINT_STYLE }, t('notify.banner.fallback'))),
  h('div', { style: ACTIONS_STYLE },
    h('button', { type: 'button', style: BUTTON_STYLE, onClick: () => { setEnabled(false); } }, t('notify.banner.disable')),
    state.focusable
      ? h('button', { type: 'button', style: BUTTON_STYLE, onClick: () => { focus(newest.sessionId); } }, t('notify.banner.open'))
      : null,
    h('button', { type: 'button', style: BUTTON_STYLE, onClick: () => { dismiss(); } }, t('notify.banner.dismiss'))));
}

/**
 * General settings row holding the on/off switch and the system notification
 * state, so the fallback mode is stated where the choice lives.
 * @param {{
 *   t: (key: string, params?: Record<string, unknown>) => string,
 *   useCompletion: (selector: (state: object) => unknown) => unknown,
 *   setEnabled: (value: boolean) => void,
 * }} props - Framework locale seat and the injected switch.
 * @returns {object} Row element.
 */
export function NotifyToggle({ t, useCompletion, setEnabled }) {
  const state = useCompletion(snapshot => snapshot);
  const hint = state.osStatus === 'granted'
    ? 'notify.setting.osReady'
    : state.osStatus === 'unsupported'
      ? 'notify.setting.osUnavailable'
      : state.osStatus === 'denied'
        ? 'notify.setting.osBlocked'
        : null;
  return h('div', { 'data-testid': 'study-notify-setting', style: SETTING_ROW_STYLE },
    h('div', { style: SETTING_TEXT_STYLE },
      h('span', { style: SETTING_LABEL_STYLE }, t('notify.setting.label')),
      h('p', { style: SETTING_DESCRIPTION_STYLE }, t('notify.setting.description')),
      hint === null ? null : h('p', { style: SETTING_DESCRIPTION_STYLE }, t(hint))),
    h('button', {
      type: 'button',
      style: state.enabled ? SWITCH_ON_STYLE : SWITCH_STYLE,
      'aria-pressed': state.enabled ? 'true' : 'false',
      onClick: () => { setEnabled(!state.enabled); },
    }, t(state.enabled ? 'notify.setting.on' : 'notify.setting.off')));
}

/**
 * Install the reminder into one client plugin: watch the Session list, then
 * contribute the overlay banner and the General settings row. Both entries
 * leave with the caller's fiber because they register through `slots.inject`.
 *
 * The Session service is taken through an in-place `ctx.inject` instead of the
 * plugin's declared dependencies: the reminder is an optional extra, and a
 * client build without the Session Controller keeps working without it.
 * @param {object} ctx - Client plugin context (`slots`, `locale`, `effect`, and
 *   in-place injection for the optional services).
 * @param {{
 *   namespace: string, translate?: Function, gateway?: object, storage?: object,
 *   timer?: object, now?: Function, focus?: Function, isWatching?: Function,
 *   mergeWindowMs?: number, bannerDurationMs?: number,
 * }} options - Dictionary namespace plus edge overrides (tests, embedded boots).
 * @returns {object | undefined} The notifier when the Session service was
 *   already active, otherwise undefined (the injection runs when it becomes
 *   active). Absent injection leaves the reminder off.
 * @throws when the dictionary namespace is missing (a wiring defect).
 */
export function installCompletionNotify(ctx, options = {}) {
  const namespace = options.namespace;
  if (typeof namespace !== 'string' || namespace === '') {
    throw new Error('installCompletionNotify needs the dictionary namespace the plugin body registered');
  }
  if (typeof ctx.inject !== 'function') {
    console.warn('[study] reply reminders stay off: this client context cannot inject the Session service');
    return undefined;
  }
  let installed;
  ctx.inject(['sessions'], (scope) => {
    installed = attachReminder(scope, scope.sessions, options, namespace);
  });
  return installed;
}

/**
 * Build the notifier and its two contributions on a context that owns the
 * Session service.
 * @param {object} ctx - Context whose fiber owns the reminder.
 * @param {object} sessions - `ISessions` service.
 * @param {object} options - The installer options.
 * @param {string} namespace - Dictionary namespace the plugin body registered.
 * @returns {object} The notifier.
 */
function attachReminder(ctx, sessions, options, namespace) {
  const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
  const focus = typeof options.focus === 'function'
    ? options.focus
    : typeof workspace?.openSession === 'function'
      ? sessionId => { workspace.openSession(sessionId); }
      : undefined;
  const isWatching = options.isWatching ?? (sessionId => (
    (sessions.list.getSnapshot().byId?.[sessionId]?.retainedBy?.mainView ?? 0) > 0
  ));
  const notifier = createCompletionNotifier({
    translate: typeof options.translate === 'function' ? options.translate : ctx.locale.bind(namespace),
    gateway: options.gateway,
    storage: options.storage,
    timer: options.timer,
    now: options.now,
    mergeWindowMs: options.mergeWindowMs,
    bannerDurationMs: options.bannerDurationMs,
    focus,
    isWatching,
  });

  ctx.effect(() => {
    const sync = () => { notifier.observe(sessions.list.getSnapshot()); };
    const unsubscribe = sessions.list.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      notifier.dispose();
    };
  }, 'study: reply completion reminder watch');

  ctx.slots.inject(BANNER_SLOT, () => ctx.slots.register({
    name: BANNER_SLOT,
    id: BANNER_ID,
    locale: namespace,
    inject: () => ({
      hooks: { completion: notifier.source },
      focus: notifier.focus,
      dismiss: notifier.dismiss,
      setEnabled: notifier.setEnabled,
    }),
  }, CompletionBanner));

  ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
    name: SETTINGS_SLOT,
    id: SETTINGS_ID,
    order: SETTINGS_ORDER,
    locale: namespace,
    inject: () => ({
      hooks: { completion: notifier.source },
      setEnabled: notifier.setEnabled,
    }),
  }, NotifyToggle));

  return notifier;
}
