/**
 * Web Storage access for the study surfaces.
 *
 * Preferences are optional: when the browser blocks Storage (privacy mode,
 * sandboxed iframe) the pane falls back to an in-memory area so the current run
 * keeps working and only the persistence across restarts is lost.
 */

/**
 * Web Storage, or a per-install in-memory area when storage is blocked.
 * @param {object} [win] - Window-like object to read `localStorage` from.
 * @returns {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void,
 *   removeItem: (key: string) => void }} Storage area with the three methods this module uses.
 */
export function createStorageArea(win = globalThis) {
  try {
    const storage = win.localStorage;
    const probe = '__study_layout_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch (error) {
    console.warn(`[study] Web Storage is unavailable (${error instanceof Error ? error.name : String(error)}); layout preferences reset on restart`);
    const values = new Map();
    return {
      getItem: key => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => { values.set(key, String(value)); },
      removeItem: (key) => { values.delete(key); },
    };
  }
}

/**
 * Write one preference, reporting a rejected write instead of throwing.
 * @param {{ setItem: (key: string, value: string) => void }} storage - Storage area.
 * @param {string} key - Preference key.
 * @param {string} value - Value to store.
 * @returns {boolean} Whether the value was written.
 */
export function writeValue(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`[study] the preference ${key} was not saved (${error instanceof Error ? error.name : String(error)})`);
    return false;
  }
}

/**
 * Remove one preference, reporting a rejected removal instead of throwing.
 * @param {{ removeItem: (key: string) => void }} storage - Storage area.
 * @param {string} key - Preference key.
 * @returns {boolean} Whether the value was removed.
 */
export function removeValue(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch (error) {
    console.warn(`[study] the preference ${key} was not cleared (${error instanceof Error ? error.name : String(error)})`);
    return false;
  }
}
