/**
 * Replaceable voice pack for the StudyBuddy pet.
 *
 * The built-in lines in `lines.js` can be overridden by one JSON document in
 * Web Storage under `study-pet:voice`:
 *
 * ```json
 * {
 *   "status": { "idle": ["..."] },
 *   "click": ["..."],
 *   "chatter": ["..."],
 *   "sleep": ["..."]
 * }
 * ```
 *
 * `status` scenes replace only the named status pools; `click`, `chatter`, and
 * `sleep` replace whole gesture/freeform pools. Omitted keys keep the built-in
 * lines. A pack is language-neutral: overrides apply to both zh and en.
 *
 * Validation is all-or-nothing. A malformed type, an unknown key, an oversized
 * pool or line makes the whole pack ignored with one warning, so a broken edit
 * can never leave half the pet speaking from a partial file. Empty pools are
 * accepted and keep the built-in lines rather than silencing the pet.
 */
import { STATUS_SCENES, VOICE } from './lines.js';

/** Web Storage key of the replaceable voice pack. */
export const VOICE_KEY = 'study-pet:voice';
/** Longest accepted pool length. */
export const MAX_POOL_LINES = 64;
/** Longest accepted single line, in characters. */
export const MAX_LINE_LENGTH = 160;

/** Top-level keys a pack may define. */
export const VOICE_PACK_KEYS = Object.freeze(['status', 'click', 'chatter', 'sleep']);
/** Whole-pool override keys. */
export const POOL_KEYS = Object.freeze(['click', 'chatter', 'sleep']);

/**
 * Report one invalid pack without throwing; used by the all-or-nothing reader.
 * @param {string} reason - Human-readable validation reason.
 * @returns {{ ok: false, error: string, warning: string }} Failure result.
 */
function invalid(reason) {
  return { ok: false, error: reason, warning: `[study-pet] voice pack ignored: ${reason}` };
}

/**
 * Check one overridden pool.
 * @param {unknown} value - Candidate pool.
 * @param {string} field - Field name for diagnostics.
 * @returns {string | null} Validation error, or null when valid.
 */
function checkPool(value, field) {
  if (!Array.isArray(value)) return `${field} must be an array of strings`;
  if (value.length > MAX_POOL_LINES) return `${field} has ${value.length} lines (max ${MAX_POOL_LINES})`;
  for (let index = 0; index < value.length; index += 1) {
    const line = value[index];
    if (typeof line !== 'string') return `${field}[${index}] must be a string`;
    if (line.trim() === '') return `${field}[${index}] must not be empty`;
    if (line.length > MAX_LINE_LENGTH) return `${field}[${index}] is ${line.length} characters (max ${MAX_LINE_LENGTH})`;
    if (/[\r\n]/.test(line)) return `${field}[${index}] must be a single line`;
  }
  return null;
}

/**
 * Validate and normalize one raw voice pack.
 * @param {unknown} raw - JSON text or an already-parsed value.
 * @returns {{ ok: true, pack: object | null } | { ok: false, error: string, warning: string }}
 *   Normalized pack (status scenes and pools as frozen string arrays), or the reason it was rejected.
 */
export function parseVoicePack(raw) {
  if (raw === undefined || raw === null) return { ok: true, pack: null };
  let value = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { ok: true, pack: null };
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return invalid(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('root must be a JSON object');
  }
  for (const key of Object.keys(value)) {
    if (!VOICE_PACK_KEYS.includes(key)) return invalid(`unknown key "${key}"`);
  }
  const status = {};
  let hasStatus = false;
  if (Object.hasOwn(value, 'status')) {
    if (value.status === null || typeof value.status !== 'object' || Array.isArray(value.status)) {
      return invalid('status must be an object of scene pools');
    }
    for (const [scene, pool] of Object.entries(value.status)) {
      if (!STATUS_SCENES.includes(scene)) return invalid(`unknown status scene "${scene}"`);
      const error = checkPool(pool, `status.${scene}`);
      if (error !== null) return invalid(error);
      if (pool.length > 0) {
        status[scene] = Object.freeze([...pool]);
        hasStatus = true;
      }
    }
  }
  const pools = {};
  for (const key of POOL_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const error = checkPool(value[key], key);
    if (error !== null) return invalid(error);
    if (value[key].length > 0) pools[key] = Object.freeze([...value[key]]);
  }
  return {
    ok: true,
    pack: Object.freeze({
      status: Object.freeze(hasStatus ? status : {}),
      ...pools,
    }),
  };
}

/**
 * Merge one validated pack into the built-in voice.
 * @param {object} [voice] - Built-in voice packs keyed by `zh`/`en`; defaults to {@link VOICE}.
 * @param {object | null} [pack] - Normalized pack from {@link parseVoicePack}.
 * @returns {object} New voice table with overridden pools for both locales.
 */
export function mergeVoicePack(voice = VOICE, pack = null) {
  if (pack === null || pack === undefined) return voice;
  const merged = {};
  for (const [locale, scenes] of Object.entries(voice)) {
    const next = { ...scenes };
    for (const [scene, lines] of Object.entries(pack.status)) next[scene] = lines;
    for (const key of POOL_KEYS) {
      if (pack[key] !== undefined) next[key] = pack[key];
    }
    merged[locale] = Object.freeze(next);
  }
  return Object.freeze(merged);
}

/**
 * Read, validate, and warn about the stored voice pack.
 * @param {{ getItem: (key: string) => string | null } | null | undefined} storage - Web Storage area.
 * @param {{ warn?: (message: string) => void }} [options] - Warning sink, for tests.
 * @returns {object | null} Validated pack, or null when absent/invalid/unavailable.
 */
export function readVoicePack(storage, options = {}) {
  const warn = options.warn ?? (message => console.warn(message));
  if (storage === null || storage === undefined) return null;
  let raw;
  try {
    raw = storage.getItem(VOICE_KEY);
  } catch (error) {
    warn(`[study-pet] voice pack could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = parseVoicePack(raw);
  if (!parsed.ok) {
    warn(parsed.warning);
    return null;
  }
  return parsed.pack;
}
