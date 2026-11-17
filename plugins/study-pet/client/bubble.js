/**
 * Bubble scheduling for the StudyBuddy pet.
 *
 * One bubble surface presents status lines, gesture replies, chatter, and
 * sleep talk. This controller owns the timing rules:
 * - a bubble lives for 4 s;
 * - the same scene does not speak again for 9 s unless a caller forces it;
 * - a long scene (think/working/rest) refreshes the line every 8 s;
 * - chatter appears only while idle, every 45-90 s, and must be enabled;
 * - sleep suppresses status bubbles; dream talk appears every 60-120 s.
 *
 * The controller is pure apart from the clock and randomness it is handed, and
 * returns immutable bubble snapshots so the React component only renders them.
 */
import { voiceLocale } from './lines.js';

/** Default bubble lifetime. */
export const BUBBLE_TTL_MS = 4_000;
/** Default same-scene cooldown. */
export const SCENE_COOLDOWN_MS = 9_000;
/** Default long-scene line rotation. */
export const LONG_SCENE_ROTATE_MS = 8_000;
/** Default chatter interval range. */
export const CHATTER_RANGE_MS = Object.freeze([45_000, 90_000]);
/** Default sleep-talk interval range. */
export const DREAM_RANGE_MS = Object.freeze([60_000, 120_000]);

/** Scenes that keep talking while they remain active. */
const LONG_SCENES = Object.freeze(['think', 'working', 'rest']);

/**
 * Draw one value from an inclusive-ish numeric range.
 * @param {() => number} random - Random source in `[0, 1)`.
 * @param {readonly [number, number]} range - `[min, max]`.
 * @returns {number} Picked duration.
 */
function pickDelay(random, range) {
  return Math.round(range[0] + random() * (range[1] - range[0]));
}

/**
 * Create the bubble controller.
 * @param {{
 *   voice?: object,
 *   random?: () => number,
 *   ttlMs?: number,
 *   cooldownMs?: number,
 *   rotateMs?: number,
 *   chatterRange?: readonly [number, number],
 *   dreamRange?: readonly [number, number],
 * }} [options] - Voice table and timing overrides.
 * @returns {{
 *   setVoice: (voice: object) => void,
 *   setChatterEnabled: (enabled: boolean) => void,
 *   say: (scene: string, at: number, options?: object) => object | null,
 *   enterScene: (scene: string, at: number, options?: object) => object | null,
 *   rotate: (at: number) => object | null,
 *   chatter: (at: number) => object | null,
 *   dream: (at: number) => object | null,
 *   tick: (at: number) => object,
 *   current: () => object | null,
 *   isAsleep: () => boolean,
 * }} Controller handle.
 */
export function createBubbleController(options = {}) {
  const random = options.random ?? Math.random;
  const ttlMs = options.ttlMs ?? BUBBLE_TTL_MS;
  const cooldownMs = options.cooldownMs ?? SCENE_COOLDOWN_MS;
  const rotateMs = options.rotateMs ?? LONG_SCENE_ROTATE_MS;
  const chatterRange = options.chatterRange ?? CHATTER_RANGE_MS;
  const dreamRange = options.dreamRange ?? DREAM_RANGE_MS;
  let voice = options.voice ?? {};
  let chatterEnabled = true;
  let bubble = null;
  let scene = 'idle';
  let sceneSince = 0;
  let asleep = false;
  let nextChatterAt = null;
  let nextDreamAt = null;
  let nextRotateAt = 0;
  let serial = 0;
  const lastSpokenAt = new Map();
  const cursor = new Map();

  /**
   * Pick the next line of one pool; rotate through the pool before repeating.
   * @param {string} key - Scene/pool key.
   * @returns {string | null} Chosen line, or null when the pool is empty.
   */
  function pickLine(key) {
    const pool = typeof voice[key] === 'function' ? voice[key]() : voice[key];
    if (!Array.isArray(pool) || pool.length === 0) return null;
    const index = (cursor.get(key) ?? 0) % pool.length;
    cursor.set(key, index + 1);
    return pool[index];
  }

  /**
   * Present one line on the shared bubble surface.
   * @param {string} key - Scene/pool key.
   * @param {number} at - Current epoch milliseconds.
   * @param {{ kind?: string, force?: boolean }} [options] - Bubble kind and cooldown bypass.
   * @returns {object | null} Bubble snapshot, or null when suppressed.
   */
  function say(key, at, options = {}) {
    if (asleep && key !== 'sleep') return null;
    const forced = options.force === true;
    if (!forced && at - (lastSpokenAt.get(key) ?? -Infinity) < cooldownMs) return null;
    const text = pickLine(key);
    if (text === null) return null;
    serial += 1;
    bubble = Object.freeze({
      id: serial,
      scene: key,
      kind: options.kind ?? 'status',
      text,
      at,
      expiresAt: at + ttlMs,
    });
    lastSpokenAt.set(key, at);
    return bubble;
  }

  /**
   * Enter one scene, starting its bubble/chatter/sleep schedule.
   * @param {string} next - Scene key.
   * @param {number} at - Current epoch milliseconds.
   * @param {{ speak?: boolean }} [options] - Set `speak: false` to skip the entrance line.
   * @returns {object | null} Entrance bubble, if one was spoken.
   */
  function enterScene(next, at, options = {}) {
    if (next === scene) {
      if (next === 'idle' && nextChatterAt === null) nextChatterAt = at + pickDelay(random, chatterRange);
      return null;
    }
    scene = next;
    sceneSince = at;
    nextRotateAt = at + rotateMs;
    if (next === 'sleep') {
      asleep = true;
      bubble = null;
      nextDreamAt = at + pickDelay(random, dreamRange);
      return null;
    }
    asleep = false;
    if (next === 'idle') {
      if (nextChatterAt === null) nextChatterAt = at + pickDelay(random, chatterRange);
      return null;
    }
    if (options.speak === false) return null;
    if (!LONG_SCENES.includes(next)) return null;
    return say(next, at);
  }

  /**
   * Refresh a long scene's line while it stays active.
   * @param {number} at - Current epoch milliseconds.
   * @returns {object | null} Refreshed bubble, if one was spoken.
   */
  function rotate(at) {
    if (!LONG_SCENES.includes(scene)) return null;
    if (at < nextRotateAt) return null;
    nextRotateAt = at + rotateMs;
    return say(scene, at, { force: true });
  }

  /**
   * Speak one idle-time inner thought when its interval elapsed.
   * @param {number} at - Current epoch milliseconds.
   * @returns {object | null} Chatter bubble, if one was spoken.
   */
  function chatter(at) {
    if (!chatterEnabled || asleep || scene !== 'idle') return null;
    if (nextChatterAt === null) {
      nextChatterAt = at + pickDelay(random, chatterRange);
      return null;
    }
    if (at < nextChatterAt) return null;
    const spoken = say('chatter', at, { kind: 'chatter', force: true });
    nextChatterAt = at + pickDelay(random, chatterRange);
    return spoken;
  }

  /**
   * Speak one dream line while asleep.
   * @param {number} at - Current epoch milliseconds.
   * @returns {object | null} Dream bubble, if one was spoken.
   */
  function dream(at) {
    if (!asleep) return null;
    if (nextDreamAt === null) {
      nextDreamAt = at + pickDelay(random, dreamRange);
      return null;
    }
    if (at < nextDreamAt) return null;
    const spoken = say('sleep', at, { kind: 'dream', force: true });
    nextDreamAt = at + pickDelay(random, dreamRange);
    return spoken;
  }

  /**
   * Expire the current bubble and run the periodic schedules.
   * @param {number} at - Current epoch milliseconds.
   * @returns {{ bubble: object | null, expired: boolean, spoken: object | null }} Frame result.
   */
  function tick(at) {
    let expired = false;
    if (bubble !== null && at >= bubble.expiresAt) {
      bubble = null;
      expired = true;
    }
    const spoken = rotate(at) ?? chatter(at) ?? dream(at);
    return { bubble, expired, spoken };
  }

  return {
    setVoice(next) {
      voice = next;
    },
    setChatterEnabled(enabled) {
      chatterEnabled = enabled === true;
    },
    say,
    enterScene,
    rotate,
    chatter,
    dream,
    tick,
    current: () => bubble,
    isAsleep: () => asleep,
  };
}

/**
 * Build the voice table the controller reads for one locale.
 * @param {object} voice - Full voice packs keyed by `zh`/`en` (built-in or merged).
 * @param {string | undefined} active - Active locale id.
 * @returns {Record<string, readonly string[]>} Scene pools for the active locale.
 */
export function voiceForLocale(voice, active) {
  const locale = voiceLocale(active);
  return voice[locale] ?? voice.en ?? {};
}
