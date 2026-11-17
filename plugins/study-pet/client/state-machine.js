/**
 * Pure scene machine for the StudyBuddy pet.
 *
 * The React component feeds three facts into this reducer: DSH session status
 * (running / pendingInteraction / completionUnread), the optional StudyBuddy
 * timer status, and user gestures. The reducer owns scene priority and the
 * "done fires once" edge; speech effects are returned alongside the next state
 * so the renderer can hand them to the bubble controller.
 *
 * Scenes: `idle`, `think`, `working`, `celebrate`, `rest`, `error`, `sleep`,
 * `dragging`.
 *
 * Priority, highest first:
 * 1. dragging (explicit pointer capture);
 * 2. an interrupted StudyBuddy timer (worried face until the student confirms);
 * 3. a Session pending interaction (the student must answer, so `think`);
 * 4. a running StudyBuddy timer: study → `working`, rest → `rest`;
 * 5. any running Session → `working`;
 * 6. a completion celebration window;
 * 7. 20 s without a gesture → `sleep`;
 * 8. `idle`.
 *
 * `done` and `timerFinish` effects fire only on an observed true→false running
 * edge (Session) or a newly observed finished timer session. A later snapshot
 * that still reports the same facts does not re-fire them.
 */

/** Scenes the pet can render. */
export const PET_SCENES = Object.freeze([
  'idle', 'think', 'working', 'celebrate', 'rest', 'error', 'sleep', 'dragging',
]);

/** Default timing values, shared with the component. */
export const TIMINGS = Object.freeze({
  /** Time without a gesture before the pet falls asleep. */
  sleepAfterMs: 20_000,
  /** How long a completed step keeps the pet celebrating. */
  celebrateMs: 6_000,
});

/** Scenes whose entrance speaks one status line. */
const AUTO_SPEAK_SCENES = Object.freeze(['think', 'working', 'rest']);

/** A finished timer older than this is not announced when the pet mounts. */
const FRESH_FINISH_MS = 90_000;

/**
 * Build the initial machine state.
 * @param {number} [now] - Current epoch milliseconds.
 * @returns {object} Initial state.
 */
export function createPetState(now = 0) {
  return Object.freeze({
    scene: 'idle',
    since: now,
    lastInteractionAt: now,
    dragging: false,
    sessions: Object.freeze({}),
    timer: null,
    lastFinishedTimerId: null,
    lastErrorTimerId: null,
    lastStartedTimerId: null,
    celebrateUntil: 0,
  });
}

/**
 * Normalize the Session status snapshot into the facts this machine needs.
 * @param {Map<string, { running?: boolean, pendingInteraction?: unknown, completionUnread?: boolean }>} snapshot - `useSessionStatus` snapshot.
 * @returns {Record<string, { running: boolean, pendingInteraction: boolean }>} Per-session facts.
 */
export function normalizeSessions(snapshot) {
  const facts = {};
  if (snapshot === null || snapshot === undefined) return facts;
  const entries = snapshot instanceof Map ? snapshot.entries() : Object.entries(snapshot);
  for (const [id, status] of entries) {
    if (status === null || typeof status !== 'object') continue;
    facts[id] = {
      running: status.running === true,
      pendingInteraction: status.pendingInteraction !== undefined && status.pendingInteraction !== null,
    };
  }
  return facts;
}

/**
 * Resolve the scene implied by the current facts.
 * @param {object} state - Machine state.
 * @param {number} now - Current epoch milliseconds.
 * @param {{ sleepAfterMs: number, celebrateMs: number }} timings - Timing values.
 * @returns {string} Scene key.
 */
export function resolveScene(state, now, timings = TIMINGS) {
  if (state.dragging) return 'dragging';
  const timer = state.timer;
  if (timer !== null && timer.phase === 'interrupted') return 'error';
  const sessions = Object.values(state.sessions);
  if (sessions.some(session => session.pendingInteraction)) return 'think';
  if (timer !== null && timer.phase === 'running') return timer.kind === 'rest' ? 'rest' : 'working';
  if (sessions.some(session => session.running)) return 'working';
  if (now < state.celebrateUntil) return 'celebrate';
  if (now - state.lastInteractionAt >= timings.sleepAfterMs) return 'sleep';
  return 'idle';
}

/**
 * Detect running true→false edges in the session fact map.
 * @param {Record<string, { running: boolean }>} previous - Facts before the update.
 * @param {Record<string, { running: boolean }>} next - Facts after the update.
 * @returns {string[]} Ids that just stopped running.
 */
function stoppedSessions(previous, next) {
  const stopped = [];
  for (const [id, before] of Object.entries(previous)) {
    if (before.running !== true) continue;
    const after = next[id];
    if (after === undefined || after.running === false) stopped.push(id);
  }
  return stopped;
}

/**
 * Derive timer-related effects for one status update.
 * @param {object} state - Current state.
 * @param {object | null} timer - Latest timer status (`{ session, lastFinished }` normalized) or null.
 * @param {number} now - Current epoch milliseconds.
 * @returns {{ effects: object[], patch: object }} Speech effects and state patch.
 */
function observeTimerFacts(state, timer, now) {
  const effects = [];
  const patch = {};
  const session = timer?.session ?? null;
  const running = session !== null && session.phase === 'running';
  const endedAt = session === null ? NaN : Date.parse(String(session.endedAt ?? ''));
  const freshFinish = Number.isFinite(endedAt) && now - endedAt <= FRESH_FINISH_MS;
  if (session !== null && session.phase === 'finished' && session.id !== state.lastFinishedTimerId) {
    patch.lastFinishedTimerId = session.id;
    // A session finished long before this pet mounted is old news, not a completion to announce.
    if (freshFinish) {
      patch.celebrateUntil = now + TIMINGS.celebrateMs;
      effects.push({ type: 'speak', scene: 'timerFinish', kind: 'status', force: true });
    }
  }
  if (session !== null && session.phase === 'interrupted' && session.id !== state.lastErrorTimerId) {
    patch.lastErrorTimerId = session.id;
    effects.push({ type: 'speak', scene: 'error', kind: 'status', force: true });
  }
  if (running && session.id !== state.lastStartedTimerId) {
    patch.lastStartedTimerId = session.id;
    if (session.kind === 'study') effects.push({ type: 'speak', scene: 'timerStart', kind: 'status', force: true });
  }
  return { effects, patch };
}

/**
 * Reduce one machine event.
 * @param {object} state - Current state from {@link createPetState} or a previous reduction.
 * @param {object} event - Event:
 *   `{ type: 'sessions', sessions, at }` (normalized facts or a `useSessionStatus` snapshot),
 *   `{ type: 'timer', timer, at }`,
 *   `{ type: 'interact', at }`,
 *   `{ type: 'dragging', value, at }`,
 *   `{ type: 'tick', at }`,
 *   `{ type: 'wake', at }`.
 * @param {{ sleepAfterMs?: number, celebrateMs?: number }} [timings] - Timing overrides.
 * @returns {{ state: object, effects: object[] }} Next state and speech effects.
 */
export function reducePetState(state, event, timings = TIMINGS) {
  const at = Number.isFinite(event?.at) ? event.at : state.since;
  const settings = { ...TIMINGS, ...timings };
  let next = state;
  const effects = [];
  if (event.type === 'sessions') {
    const sessions = event.normalized === true ? event.sessions : normalizeSessions(event.sessions);
    const stopped = stoppedSessions(state.sessions, sessions);
    next = { ...next, sessions: Object.freeze(sessions) };
    if (stopped.length > 0) {
      next = { ...next, celebrateUntil: Math.max(next.celebrateUntil, at + settings.celebrateMs) };
      effects.push({ type: 'speak', scene: 'done', kind: 'status', force: true });
    }
  } else if (event.type === 'timer') {
    const observed = observeTimerFacts(next, event.timer ?? null, at);
    next = { ...next, timer: event.timer?.session ?? null, ...observed.patch };
    effects.push(...observed.effects);
  } else if (event.type === 'interact' || event.type === 'wake') {
    const wasSleeping = state.scene === 'sleep';
    next = { ...next, lastInteractionAt: at };
    if (wasSleeping) {
      next = { ...next, celebrateUntil: 0 };
      effects.push({ type: 'speak', scene: 'greet', kind: 'gesture', force: true });
    }
  } else if (event.type === 'dragging') {
    next = { ...next, dragging: event.value === true, lastInteractionAt: at };
  } else if (event.type !== 'tick') {
    return { state, effects };
  }
  const scene = resolveScene(next, at, settings);
  if (scene !== state.scene) {
    next = { ...next, scene, since: at };
    if (AUTO_SPEAK_SCENES.includes(scene) && effects.length === 0) {
      effects.push({ type: 'speak', scene, kind: 'status', force: false });
    }
  }
  return { state: Object.freeze(next), effects };
}
