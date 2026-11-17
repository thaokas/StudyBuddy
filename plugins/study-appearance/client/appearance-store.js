/**
 * Persisted appearance state for one browser.
 *
 * The store publishes immutable snapshots and never owns rendering; the plugin
 * body subscribes to restack the theme-token layer and the settings row reads
 * the same source through its `useAppearance` hook. Storage failures degrade to
 * an in-memory area so a blocked Web Storage cannot break the settings row.
 *
 * `study.appearance.accent` was the MVP's single-accent key. It is no longer
 * read: an old value there is ignored instead of being normalized into a pack,
 * so an upgrade never crashes or silently picks the wrong palette.
 */
import {
  DEFAULT_DARK_PACK,
  DEFAULT_LIGHT_PACK,
  normalizeDarkPack,
  normalizeLightPack,
} from './theme.js';

/** Web Storage key of the on/off switch. */
export const ENABLED_KEY = 'study.appearance.enabled';
/** Web Storage key of the light palette pack. */
export const LIGHT_PACK_KEY = 'study.appearance.light-pack';
/** Web Storage key of the dark palette pack. */
export const DARK_PACK_KEY = 'study.appearance.dark-pack';
/** Retired MVP key; read only by the migration note in tests, never by the store. */
export const LEGACY_ACCENT_KEY = 'study.appearance.accent';

/**
 * Resolve one Web Storage area, falling back to memory when access throws.
 * @param {() => object | undefined} resolve - Candidate area accessor.
 * @returns {{ getItem: Function, setItem: Function, removeItem: Function }} Storage area.
 */
function storageArea(resolve) {
  try {
    const area = resolve();
    if (area !== undefined && area !== null) return area;
  } catch (error) {
    console.warn('[study-appearance] Web Storage is unavailable; using an in-memory area:', error);
  }
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

/**
 * Create the appearance state store.
 * @param {{ storage?: { local?: object } }} [options] - Injectable storage edge for tests.
 * @returns {{
 *   source: { getSnapshot: () => object, subscribe: (listener: Function) => Function },
 *   snapshot: object,
 *   setEnabled: (value: boolean) => void,
 *   setLightPack: (value: string) => void,
 *   setDarkPack: (value: string) => void,
 *   dispose: () => void,
 * }} Store handle.
 */
export function createAppearanceStore(options = {}) {
  const local = storageArea(() => options.storage?.local ?? globalThis.localStorage);
  const listeners = new Set();
  let disposed = false;
  let snapshot = Object.freeze({
    enabled: readEnabled(local),
    lightPack: normalizeLightPack(local.getItem(LIGHT_PACK_KEY)),
    darkPack: normalizeDarkPack(local.getItem(DARK_PACK_KEY)),
  });

  /** @param {string} key @param {string} value */
  function write(key, value) {
    try {
      local.setItem(key, value);
    } catch (error) {
      console.warn('[study-appearance] preference was not stored:', error);
    }
  }

  /**
   * Replace the published snapshot and notify subscribers.
   * @param {{ enabled?: boolean, lightPack?: string, darkPack?: string }} patch - Changed fields.
   */
  function publish(patch) {
    if (disposed) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[study-appearance] subscriber failed:', error);
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
    setLightPack(value) {
      const next = normalizeLightPack(value);
      if (snapshot.lightPack === next) return;
      write(LIGHT_PACK_KEY, next);
      publish({ lightPack: next });
    },
    setDarkPack(value) {
      const next = normalizeDarkPack(value);
      if (snapshot.darkPack === next) return;
      write(DARK_PACK_KEY, next);
      publish({ darkPack: next });
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

/**
 * @param {object} local - Storage area.
 * @returns {boolean} Whether the StudyBuddy appearance is on, defaulting to on.
 */
function readEnabled(local) {
  return local.getItem(ENABLED_KEY) !== '0';
}

export { DEFAULT_DARK_PACK, DEFAULT_LIGHT_PACK };
