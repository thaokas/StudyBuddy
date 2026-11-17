/**
 * Shared fixtures for the reply-completion reminder tests: a virtual clock with
 * a controllable timer, Web Storage stand-ins, a recording Notification
 * gateway, and a Session-list observable the tests can drive.
 *
 * The notifier is browser state, so every external edge (clock, storage,
 * permissions, navigation) is injected; these helpers are the Node-side
 * replacements for that edges. Translation reads the shipped dictionary, so a
 * missing copy key fails a test instead of silently rendering the key.
 */
import notifyMessages from '../../client/messages/notify.js';

/** Copy keys the reminder renders, read from the shipped module. */
export const DICTIONARY = notifyMessages;

/**
 * Build a translator over the shipped dictionary.
 * @param {string} [locale] - Dictionary to read.
 * @returns {(key: string, params?: Record<string, unknown>) => string} Translator.
 */
export function translator(locale = 'en') {
  return (key, params) => {
    const template = DICTIONARY[locale]?.[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

/** In-memory Web Storage area. */
export function memoryArea() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

/** Storage area whose reads and writes both throw, like a sandboxed frame. */
export const BLOCKED_AREA = Object.freeze({
  /** @throws always - the frame denies storage access. */
  getItem() { throw new Error('storage blocked'); },
  /** @throws always - the frame denies storage access. */
  setItem() { throw new Error('storage blocked'); },
  /** @throws always - the frame denies storage access. */
  removeItem() { throw new Error('storage blocked'); },
});

/**
 * Let every queued promise callback run.
 * @param {number} [times] - Microtask turns to drain.
 * @returns {Promise<void>} Resolves after the turns.
 */
export async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

/**
 * Virtual clock plus manual timer.
 * @returns {{
 *   now: () => number,
 *   timer: { setTimeout: Function, clearTimeout: Function },
 *   advance: (ms: number) => void,
 *   pending: () => number,
 * }} Clock harness.
 */
export function clock() {
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

/**
 * Recording Notification gateway.
 * @param {{ supported?: boolean, permission?: string, grant?: string }} [options]
 *   Capability, current permission, and the answer the next prompt returns.
 * @returns {object} Gateway whose `shown` and `requests` record the calls.
 */
export function gateway({ supported = true, permission = 'granted', grant = 'granted' } = {}) {
  let current = permission;
  let answer = grant;
  const shown = [];
  const requests = [];
  return {
    get supported() { return supported; },
    get permission() { return supported ? current : 'unsupported'; },
    async requestPermission() {
      requests.push(current);
      current = answer;
      return current;
    },
    show(payload) {
      if (!supported || current !== 'granted') return undefined;
      shown.push(payload);
      return { close() {} };
    },
    shown,
    requests,
    /** Change the permission the browser reports without a prompt. */
    setPermission(value) { current = value; },
    /** Change the answer the next prompt returns. */
    setAnswer(value) { answer = value; },
  };
}

/**
 * Observable Session-list state the tests drive.
 * @param {object} initial - First `SessionListState` snapshot.
 * @returns {{ list: object, set: Function, listenerCount: Function }} Sessions-service stand-in.
 */
export function sessionList(initial = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    set(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

/**
 * Build one Session list snapshot from rows.
 * @param {Array<{ id: string, running: boolean, updatedAt?: number, displayTitle?: string, origin?: string }>} rows
 *   Rows in host order.
 * @returns {object} `SessionListState` snapshot.
 */
export function listOf(rows) {
  const byId = {};
  for (const row of rows) {
    byId[row.id] = {
      id: row.id,
      displayTitle: row.displayTitle ?? `Session ${row.id}`,
      running: row.running,
      updatedAt: row.updatedAt ?? 1,
      retainedBy: row.retainedBy ?? {},
      blank: false,
      ...(row.origin === undefined ? {} : { origin: row.origin }),
    };
  }
  return { ids: rows.map(row => row.id), byId, phase: 'ready', projectionsBySession: {} };
}
