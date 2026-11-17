/**
 * Persisted pet preferences for one browser.
 *
 * The settings row and the floating pet share this one store, so the size
 * chips, the visibility switch, and the hiding action inside the pet panel all
 * read and write the same snapshot. Every storage access is wrapped: a browser
 * that blocks Web Storage degrades to an in-memory area instead of breaking the
 * pet or the settings row.
 */

/** Web Storage key of the show/hide preference. */
export const ENABLED_KEY = 'study-pet:enabled';
/** Web Storage key of the chatter preference. */
export const CHATTER_KEY = 'study-pet:chatter';
/** Web Storage key of the pet scale. */
export const SIZE_KEY = 'study-pet:size';
/** Web Storage key of the last dragged position. */
export const POSITION_KEY = 'study-pet:position';

/** Selectable scales, in settings-row order. */
export const SIZES = Object.freeze(['0.85', '1', '1.2']);
/** Default scale. */
export const DEFAULT_SIZE = '1';

/**
 * Resolve the browser's Web Storage, falling back to an in-memory area.
 * @param {{ storage?: { local?: object } }} [options] - Injectable storage edge for tests and callers.
 * @returns {{ getItem: Function, setItem: Function, removeItem: Function }} Storage area.
 */
export function resolveStorage(options = {}) {
  try {
    const area = options.storage?.local ?? globalThis.localStorage;
    if (area !== undefined && area !== null) return area;
  } catch (error) {
    console.warn('[study-pet] Web Storage is unavailable; using an in-memory area:', error);
  }
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

/**
 * Normalize one stored scale.
 * @param {unknown} value - Stored value.
 * @returns {string} One of {@link SIZES}.
 */
export function normalizeSize(value) {
  return typeof value === 'string' && SIZES.includes(value) ? value : DEFAULT_SIZE;
}

/**
 * Parse one stored position.
 * @param {unknown} raw - Stored JSON text.
 * @returns {{ left: number, top: number } | null} Finite position, or null for a corrupt value.
 */
export function parsePosition(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { left, top } = value;
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left: Math.round(left), top: Math.round(top) };
}

/**
 * Create the shared pet store.
 * @param {{ storage?: { local?: object }, warn?: (message: string) => void }} [options] - Injectable storage edge.
 * @returns {{
 *   source: { getSnapshot: () => object, subscribe: (listener: Function) => Function },
 *   snapshot: object,
 *   setEnabled: (value: boolean) => void,
 *   setChatter: (value: boolean) => void,
 *   setSize: (value: string) => void,
 *   setPosition: (position: { left: number, top: number }) => void,
 *   clearPosition: () => void,
 *   dispose: () => void,
 * }} Store handle.
 */
export function createPetStore(options = {}) {
  const local = resolveStorage(options);
  const warn = options.warn ?? (message => console.warn(message));
  const listeners = new Set();
  let disposed = false;

  /** @param {string} key @returns {string | null} */
  function read(key) {
    try {
      return local.getItem(key);
    } catch (error) {
      warn(`[study-pet] preference ${key} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** @param {string} key @param {string} value */
  function write(key, value) {
    try {
      local.setItem(key, value);
    } catch (error) {
      warn(`[study-pet] preference ${key} was not stored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let snapshot = Object.freeze({
    enabled: read(ENABLED_KEY) !== '0',
    chatter: read(CHATTER_KEY) !== '0',
    size: normalizeSize(read(SIZE_KEY)),
    position: parsePosition(read(POSITION_KEY)),
  });

  /**
   * Replace the published snapshot and notify subscribers.
   * @param {{ enabled?: boolean, chatter?: boolean, size?: string, position?: object | null }} patch - Changed fields.
   */
  function publish(patch) {
    if (disposed) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[study-pet] subscriber failed:', error);
      }
    }
  }

  const source = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  /** @param {string} value */
  function setSize(value) {
    const next = normalizeSize(value);
    if (snapshot.size === next) return;
    write(SIZE_KEY, next);
    publish({ size: next });
  }

  return {
    source,
    subscribe: source.subscribe,
    get snapshot() { return snapshot; },
    setEnabled(value) {
      const next = value === true;
      if (snapshot.enabled === next) return;
      write(ENABLED_KEY, next ? '1' : '0');
      publish({ enabled: next });
    },
    setChatter(value) {
      const next = value === true;
      if (snapshot.chatter === next) return;
      write(CHATTER_KEY, next ? '1' : '0');
      publish({ chatter: next });
    },
    setSize,
    setPosition(position) {
      if (position === null || !Number.isFinite(position?.left) || !Number.isFinite(position?.top)) return;
      const next = Object.freeze({ left: Math.round(position.left), top: Math.round(position.top) });
      if (snapshot.position !== null && snapshot.position.left === next.left && snapshot.position.top === next.top) return;
      write(POSITION_KEY, JSON.stringify(next));
      publish({ position: next });
    },
    clearPosition() {
      if (snapshot.position === null) return;
      try {
        local.removeItem(POSITION_KEY);
      } catch (error) {
        warn(`[study-pet] preference ${POSITION_KEY} was not removed: ${error instanceof Error ? error.message : String(error)}`);
      }
      publish({ position: null });
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
