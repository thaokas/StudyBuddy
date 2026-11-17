/**
 * Timer module: a locally timed pomodoro with an optional task link.
 *
 * The host owns the clock. A session stores the time already credited
 * (`accumulated_ms`), the moment the current running segment resumed, and the
 * last moment the process observed the timer (`last_seen_at`). Focused time is
 * always `accumulated + (now - resumed_at)`, clamped to the planned length, so
 * reading or pausing can never invent time.
 *
 * Liveness is a heartbeat: while a session runs, a short interval advances
 * `last_seen_at`. A jump larger than the gap limit means the app was suspended,
 * so the session becomes interrupted with the credit stopped at the last
 * observed moment, and the student must choose resume (skip the gap) or finish.
 * On plugin load, a session that was still running is always interrupted: the
 * time between the last heartbeat and this boot was not observed, and the
 * process restart is proof the app was not running. A session that had already
 * reached its planned length before the restart is recorded as completed.
 *
 * A finished timer never touches the linked task. Task completion is the
 * student's decision and belongs to the tasks module (T06); this module only
 * records focus time. Nothing here calls a model, and every call works offline.
 *
 * The heartbeat's transitions are internal bookkeeping: they append a
 * `change_log` entry with actor `system` but do not bump the global revision,
 * because no client can be holding a stale revision constructed from liveness
 * state it could not have seen. Service writes (`start`/`pause`/…) do bump it
 * through the kernel as usual.
 */
import { randomUUID } from 'node:crypto';
import { StudyError } from '../../../../packages/study-contracts/index.mjs';

/** Module id; matches the `timer` service namespace. */
export const id = 'timer';

/** Reads the task table, so the tasks module must create it first. */
export const deps = ['tasks'];

/** Schema version recorded in `module_schema`; bump when the DDL below changes. */
export const schemaVersion = 1;

/** Tables owned by this module. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS study_timer_session (
    id                  TEXT PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN ('study', 'rest')),
    task_id             TEXT,
    task_title          TEXT,
    planned_ms          INTEGER NOT NULL CHECK (planned_ms > 0),
    accumulated_ms      INTEGER NOT NULL DEFAULT 0 CHECK (accumulated_ms >= 0),
    phase               TEXT NOT NULL CHECK (phase IN ('running', 'paused', 'interrupted', 'finished')),
    started_at          TEXT NOT NULL,
    resumed_at          TEXT,
    last_seen_at        TEXT NOT NULL,
    ended_at            TEXT,
    outcome             TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'ended')),
    interrupted_at      TEXT,
    interruption_ms     INTEGER,
    interruption_reason TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_timer_session_open ON study_timer_session (phase, started_at)',
  'CREATE INDEX IF NOT EXISTS study_timer_session_history ON study_timer_session (ended_at)',
  `CREATE TABLE IF NOT EXISTS study_timer_settings (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    study_minutes INTEGER NOT NULL CHECK (study_minutes BETWEEN 1 AND 180),
    rest_minutes  INTEGER NOT NULL CHECK (rest_minutes BETWEEN 1 AND 180),
    updated_at    TEXT NOT NULL
  ) STRICT`,
];

const WRITE_METHODS = ['start', 'pause', 'resume', 'finish', 'confirm', 'updateSettings'];

const KINDS = new Set(['study', 'rest']);
const CONFIRM_ACTIONS = new Set(['resume', 'finish']);
const DEFAULT_STUDY_MINUTES = 25;
const DEFAULT_REST_MINUTES = 5;
const MIN_MINUTES = 1;
const MAX_MINUTES = 180;
const MINUTE_MS = 60_000;

/** How often the running session's liveness timestamp is refreshed. */
export const HEARTBEAT_MS = 5_000;

/**
 * Largest observed gap that still counts as normal running. Nine missed
 * heartbeats: longer than a busy event loop, short enough that a suspended
 * machine is caught on the next wake.
 */
export const GAP_LIMIT_MS = 45_000;

/**
 * Register the timer namespace and start its liveness heartbeat.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study`.
 * @param {object} kernel - Kernel handle, used for boot recovery and the clock.
 */
export async function apply(ctx, kernel) {
  await recover(kernel);
  ctx.effect(() => ctx.study.register('timer', {
    methods: {
      status,
      start,
      pause,
      resume,
      finish,
      confirm,
      updateSettings,
    },
    writes: WRITE_METHODS,
  }), 'study: timer namespace');
  ctx.effect(() => startHeartbeat(kernel), 'study: timer heartbeat');
}

// ---------------------------------------------------------------------------
// Clock, heartbeat, and restart recovery
// ---------------------------------------------------------------------------

/**
 * Read the kernel's own clock. Boot recovery and the heartbeat run outside a
 * service call, so this is how they share the injected clock the kernel uses.
 */
function kernelNow(kernel) {
  return new Date(kernel.status().serverTime);
}

/** Start the heartbeat interval; returns its disposer. */
function startHeartbeat(kernel) {
  const handle = setInterval(() => { reconcile(kernel); }, HEARTBEAT_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

/**
 * One heartbeat: keep a healthy running session observed, and persist the
 * interruption or completion the clock has reached. Also exported so tests can
 * drive the same code with a deterministic clock.
 * @param {object} kernel - Kernel handle.
 * @returns {object | null} Derived session view, or null when no session runs.
 */
export function reconcile(kernel) {
  let row;
  try {
    row = latestRunning(kernel.database);
  } catch {
    return null;
  }
  if (row === undefined) return null;
  let now;
  try {
    now = kernelNow(kernel);
  } catch {
    return null;
  }
  let view;
  try {
    view = sessionView(kernel.database, row, now);
  } catch {
    return null;
  }
  if (view.phase === 'running') {
    try {
      kernel.database.run(
        "UPDATE study_timer_session SET last_seen_at = ? WHERE id = ? AND phase = 'running'",
        now.toISOString(),
        row.id,
      );
    } catch { /* A closed database is retried by the next status or boot. */ }
    return view;
  }
  try {
    void kernel.database.transaction(() => {
      const updated = view.phase === 'finished'
        ? updateFinished(kernel.database, row, view.focusedMs, view.endedAt ?? now.toISOString(), 'completed', now.toISOString())
        : updateInterrupted(kernel.database, row, view.focusedMs, view.interruption.at, view.interruption.gapMs, now.toISOString(), 'gap');
      kernel.recordChange({
        entity: 'timer_session',
        entityId: String(row.id),
        action: view.phase === 'finished' ? 'finish' : 'interrupt',
        before: view,
        after: sessionView(kernel.database, updated, now),
        reason: view.phase === 'finished' ? '计时到点' : '检测到计时中断',
      });
    }).catch(() => { /* The next status or write derives the same state. */ });
  } catch { /* Closing database. */ }
  return view;
}

/**
 * Mark a session that was still running when the process stopped as
 * interrupted, crediting only up to the last observed heartbeat. A session
 * that had already reached its planned length is recorded as completed.
 * @param {object} kernel - Kernel handle.
 */
export async function recover(kernel) {
  const database = kernel.database;
  const row = database.get(
    "SELECT * FROM study_timer_session WHERE phase = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1",
  );
  if (row === undefined) return;
  const now = kernelNow(kernel);
  const nowIso = now.toISOString();
  const plannedMs = Number(row.planned_ms);
  const lastSeenMs = Date.parse(String(row.last_seen_at));
  const resumedMs = Date.parse(String(row.resumed_at));
  const hasTimes = Number.isFinite(lastSeenMs) && Number.isFinite(resumedMs);
  const observedMs = hasTimes ? Math.min(lastSeenMs, now.getTime()) : now.getTime();
  const creditedMs = hasTimes
    ? clampCredit(Number(row.accumulated_ms) + Math.max(0, lastSeenMs - resumedMs), plannedMs)
    : clampCredit(Number(row.accumulated_ms), plannedMs);

  await database.transaction(() => {
    if (creditedMs >= plannedMs) {
      const endedAt = new Date(completionMoment(resumedMs, Number(row.accumulated_ms), plannedMs, observedMs)).toISOString();
      const updated = updateFinished(database, row, plannedMs, endedAt, 'completed', nowIso);
      kernel.recordChange({
        entity: 'timer_session',
        entityId: String(row.id),
        action: 'finish',
        reason: '重启前计时已到点',
        before: sessionView(database, row, now),
        after: sessionView(database, updated, now),
      });
      return;
    }
    const interruptedAt = new Date(observedMs).toISOString();
    const gapMs = Math.max(0, now.getTime() - observedMs);
    const updated = updateInterrupted(database, row, creditedMs, interruptedAt, gapMs, nowIso, 'restart');
    kernel.recordChange({
      entity: 'timer_session',
      entityId: String(row.id),
      action: 'interrupt',
      reason: '应用重启，关机期间未计入专注时长',
      before: sessionView(database, row, now),
      after: sessionView(database, updated, now),
    });
  });
}

// ---------------------------------------------------------------------------
// Service reads
// ---------------------------------------------------------------------------

/** Current duration settings, falling back to 25/5 before the first update. */
function readSettings(db) {
  const row = db.get('SELECT study_minutes, rest_minutes FROM study_timer_settings WHERE id = 1');
  if (row === undefined) {
    return { studyMinutes: DEFAULT_STUDY_MINUTES, restMinutes: DEFAULT_REST_MINUTES };
  }
  return { studyMinutes: Number(row.study_minutes), restMinutes: Number(row.rest_minutes) };
}

/** The most recent session, whatever its phase. */
function latestRow(db) {
  return db.get('SELECT * FROM study_timer_session ORDER BY started_at DESC, rowid DESC LIMIT 1');
}

/** The most recent session that is still running, if any. */
function latestRunning(db) {
  return db.get('SELECT * FROM study_timer_session WHERE phase = \'running\' ORDER BY started_at DESC, rowid DESC LIMIT 1');
}

/** One stored row by id. */
function rowById(db, sessionId) {
  return db.get('SELECT * FROM study_timer_session WHERE id = ?', sessionId);
}

/**
 * Status: settings, the latest session (derived from the clock, without
 * writing), and the most recent finished session when the latest one is still
 * active. Pure read: no revision bump, no change log.
 */
function status(_payload, api) {
  const now = api.now();
  const row = latestRow(api.db);
  const session = row === undefined ? null : sessionView(api.db, row, now);
  let lastFinished = null;
  if (session === null) {
    const finished = api.db.get(
      "SELECT * FROM study_timer_session WHERE phase = 'finished' ORDER BY ended_at DESC, rowid DESC LIMIT 1",
    );
    if (finished !== undefined) lastFinished = sessionView(api.db, finished, now);
  } else if (session.phase !== 'finished') {
    const finished = api.db.get(
      "SELECT * FROM study_timer_session WHERE phase = 'finished' AND id <> ? ORDER BY ended_at DESC, rowid DESC LIMIT 1",
      session.id,
    );
    if (finished !== undefined) lastFinished = sessionView(api.db, finished, now);
  }
  return { now: now.toISOString(), settings: readSettings(api.db), session, lastFinished };
}

// ---------------------------------------------------------------------------
// Service writes
// ---------------------------------------------------------------------------

/** Start a study or rest session, optionally linked to an active task. */
function start(payload, api) {
  const now = api.now();
  const nowIso = now.toISOString();
  const kind = payload.kind === undefined || payload.kind === null ? 'study' : requireKind(payload.kind);
  const settings = readSettings(api.db);
  const minutes = payload.minutes === undefined || payload.minutes === null
    ? (kind === 'study' ? settings.studyMinutes : settings.restMinutes)
    : requireMinutes(payload.minutes, 'minutes');

  const latest = latestRow(api.db);
  if (latest !== undefined) {
    const current = sessionView(api.db, latest, now);
    if (current.phase === 'running' || current.phase === 'paused') {
      throw new StudyError('conflict', '已经有正在进行的计时，请先暂停或结束它', {
        reason: 'session_active',
        sessionId: current.id,
        phase: current.phase,
      });
    }
    if (current.phase === 'interrupted') {
      throw new StudyError('conflict', '上一次计时被中断，请先确认是继续还是结束', {
        reason: 'interruption_unconfirmed',
        sessionId: current.id,
        interruption: current.interruption,
      });
    }
    if (String(latest.phase) !== 'finished') {
      // The planned time ran out between heartbeats; record that completion
      // before starting the next session.
      const finished = updateFinished(api.db, latest, current.focusedMs, current.endedAt ?? nowIso, 'completed', nowIso);
      api.change({
        entity: 'timer_session',
        entityId: String(latest.id),
        action: 'finish',
        reason: '计时到点',
        before: current,
        after: sessionView(api.db, finished, now),
      });
    }
  }

  const taskId = payload.taskId === undefined || payload.taskId === null
    ? null
    : requireText(payload.taskId, 'taskId', { max: 64 });
  if (kind === 'rest' && taskId !== null) {
    throw new StudyError('invalid', '休息计时不能关联任务', { field: 'taskId' });
  }
  let taskTitle = null;
  if (taskId !== null) {
    const task = api.db.get('SELECT id, title, deleted_at FROM study_task WHERE id = ?', taskId);
    if (task === undefined) {
      throw new StudyError('not_found', `找不到任务 ${taskId}`, { field: 'taskId', taskId });
    }
    if (task.deleted_at !== null) {
      throw new StudyError('not_found', `任务 ${taskId} 已删除`, { field: 'taskId', taskId, deletedAt: String(task.deleted_at) });
    }
    taskTitle = String(task.title);
  }

  const sessionId = `timer_${randomUUID()}`;
  api.db.run(
    `INSERT INTO study_timer_session
       (id, kind, task_id, task_title, planned_ms, accumulated_ms, phase, started_at, resumed_at, last_seen_at,
        ended_at, outcome, interrupted_at, interruption_ms, interruption_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 'running', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    sessionId, kind, taskId, taskTitle, minutes * MINUTE_MS, nowIso, nowIso, nowIso, nowIso, nowIso,
  );
  const session = sessionView(api.db, rowById(api.db, sessionId), now);
  api.change({ entity: 'timer_session', entityId: sessionId, action: 'start', after: session });
  return { session };
}

/** Pause a running session; the frozen focused time is kept. */
function pause(payload, api) {
  const now = api.now();
  const nowIso = now.toISOString();
  const row = requireSession(api.db, payload);
  const before = sessionView(api.db, row, now);
  assertNotInterrupted(before);
  if (before.phase === 'paused') {
    throw new StudyError('conflict', '计时已经暂停', { reason: 'already_paused', sessionId: before.id });
  }
  if (before.phase === 'finished') {
    throw new StudyError('conflict', '计时已经结束', { reason: 'already_finished', sessionId: before.id });
  }
  api.db.run(
    `UPDATE study_timer_session
        SET phase = 'paused', accumulated_ms = ?, resumed_at = NULL, last_seen_at = ?, updated_at = ?
      WHERE id = ? AND phase = 'running'`,
    before.focusedMs, nowIso, nowIso, before.id,
  );
  const after = sessionView(api.db, rowById(api.db, before.id), now);
  api.change({ entity: 'timer_session', entityId: before.id, action: 'pause', before, after });
  return { session: after };
}

/** Continue a paused session. Running the same session again is a no-op success. */
function resume(payload, api) {
  const now = api.now();
  const nowIso = now.toISOString();
  const row = requireSession(api.db, payload);
  const before = sessionView(api.db, row, now);
  assertNotInterrupted(before);
  if (before.phase === 'finished') {
    throw new StudyError('conflict', '计时已经结束', { reason: 'already_finished', sessionId: before.id });
  }
  if (before.phase === 'running') return { session: before };

  api.db.run(
    `UPDATE study_timer_session
        SET phase = 'running', resumed_at = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ? AND phase = 'paused'`,
    nowIso, nowIso, nowIso, before.id,
  );
  const after = sessionView(api.db, rowById(api.db, before.id), now);
  api.change({ entity: 'timer_session', entityId: before.id, action: 'resume', before, after });
  return { session: after };
}

/**
 * End the session and record the focused time. An interrupted session requires
 * `confirmInterruption: true`, so an interruption can never silently become a
 * normal completion.
 */
function finish(payload, api) {
  const now = api.now();
  const nowIso = now.toISOString();
  const row = requireSession(api.db, payload);
  const before = sessionView(api.db, row, now);

  if (before.phase === 'finished') {
    if (String(row.phase) === 'finished') return { session: before };
    const settled = updateFinished(api.db, row, before.focusedMs, before.endedAt ?? nowIso, 'completed', nowIso);
    const after = sessionView(api.db, settled, now);
    api.change({ entity: 'timer_session', entityId: before.id, action: 'finish', reason: '计时到点', before, after });
    return { session: after };
  }

  if (before.phase === 'interrupted' && payload.confirmInterruption !== true) {
    throw new StudyError('conflict', '计时中断需要学生确认后才能结束', {
      reason: 'interruption_unconfirmed',
      sessionId: before.id,
      interruption: before.interruption,
    });
  }

  const outcome = before.focusedMs >= before.plannedMs ? 'completed' : 'ended';
  const settled = updateFinished(api.db, row, before.focusedMs, nowIso, outcome, nowIso);
  const after = sessionView(api.db, settled, now);
  api.change({
    entity: 'timer_session',
    entityId: before.id,
    action: 'finish',
    reason: before.phase === 'interrupted' ? '中断后确认结束' : null,
    before,
    after,
  });
  return { session: after };
}

/**
 * Resolve an interruption: `resume` continues without the unobserved gap,
 * `finish` records the focused time and ends the session.
 */
function confirm(payload, api) {
  const now = api.now();
  const nowIso = now.toISOString();
  const action = payload.action;
  if (typeof action !== 'string' || !CONFIRM_ACTIONS.has(action)) {
    throw new StudyError('invalid', 'action 必须是 resume 或 finish', { field: 'action', allowed: [...CONFIRM_ACTIONS] });
  }
  const row = requireSession(api.db, payload);
  const before = sessionView(api.db, row, now);
  if (before.phase !== 'interrupted') {
    throw new StudyError('conflict', '这次计时没有被中断，不需要确认', {
      reason: 'not_interrupted',
      sessionId: before.id,
      phase: before.phase,
    });
  }

  if (action === 'resume') {
    const interruptedAt = before.interruption.at;
    api.db.run(
      `UPDATE study_timer_session
          SET phase = 'running', accumulated_ms = ?, resumed_at = ?, last_seen_at = ?, updated_at = ?,
              interrupted_at = COALESCE(interrupted_at, ?),
              interruption_ms = COALESCE(interruption_ms, ?),
              interruption_reason = COALESCE(interruption_reason, 'gap')
        WHERE id = ? AND phase <> 'finished'`,
      before.focusedMs, nowIso, nowIso, nowIso, interruptedAt, before.interruption.gapMs, before.id,
    );
    const after = sessionView(api.db, rowById(api.db, before.id), now);
    api.change({ entity: 'timer_session', entityId: before.id, action: 'confirm_resume', before, after });
    return { session: after };
  }

  const outcome = before.focusedMs >= before.plannedMs ? 'completed' : 'ended';
  const settled = updateFinished(api.db, row, before.focusedMs, nowIso, outcome, nowIso);
  const after = sessionView(api.db, settled, now);
  api.change({ entity: 'timer_session', entityId: before.id, action: 'confirm_finish', before, after });
  return { session: after };
}

/** Update the default study and rest lengths. Omitted values keep their setting. */
function updateSettings(payload, api) {
  const now = api.now();
  const current = readSettings(api.db);
  const hasStudy = Object.hasOwn(payload, 'studyMinutes');
  const hasRest = Object.hasOwn(payload, 'restMinutes');
  if (!hasStudy && !hasRest) {
    throw new StudyError('invalid', '至少要提供一个时长（studyMinutes 或 restMinutes）', { field: 'studyMinutes' });
  }
  const studyMinutes = hasStudy ? requireMinutes(payload.studyMinutes, 'studyMinutes') : current.studyMinutes;
  const restMinutes = hasRest ? requireMinutes(payload.restMinutes, 'restMinutes') : current.restMinutes;
  api.db.run(
    `INSERT INTO study_timer_settings (id, study_minutes, rest_minutes, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET study_minutes = excluded.study_minutes,
                                   rest_minutes = excluded.rest_minutes,
                                   updated_at = excluded.updated_at`,
    studyMinutes, restMinutes, now.toISOString(),
  );
  const settings = { studyMinutes, restMinutes };
  api.change({ entity: 'timer_settings', entityId: 'default', action: 'update', before: current, after: settings });
  return { settings };
}

// ---------------------------------------------------------------------------
// Session views and persistence
// ---------------------------------------------------------------------------

/**
 * One session as the UI and tests read it. A stored `running` row whose
 * liveness is stale is reported as `interrupted`; one whose planned time has
 * passed is reported as a completed `finished`. Neither derivation writes.
 * @param {object} db - Study database handle.
 * @param {object} row - Stored session row.
 * @param {Date} now - Current instant.
 * @returns {object} Session view.
 */
function sessionView(db, row, now) {
  const stored = String(row.phase);
  const plannedMs = Number(row.planned_ms);
  const accumulatedMs = Number(row.accumulated_ms);
  const nowMs = now.getTime();
  const task = taskRef(db, row);
  let phase = stored;
  let focusedMs;
  let interruption = null;
  let endedAt = row.ended_at === null ? null : String(row.ended_at);
  let outcome = row.outcome === null ? null : String(row.outcome);

  if (stored === 'running') {
    const lastSeenMs = Date.parse(String(row.last_seen_at));
    const resumedMs = Date.parse(String(row.resumed_at));
    if (!Number.isFinite(lastSeenMs) || !Number.isFinite(resumedMs)) {
      throw new StudyError('unavailable', '计时数据损坏，无法读取', { sessionId: String(row.id) });
    }
    const gapMs = nowMs - lastSeenMs;
    if (gapMs > GAP_LIMIT_MS) {
      phase = 'interrupted';
      focusedMs = clampCredit(accumulatedMs + Math.max(0, lastSeenMs - resumedMs), plannedMs);
      interruption = { at: String(row.last_seen_at), gapMs, reason: 'gap' };
    } else {
      focusedMs = clampCredit(accumulatedMs + Math.max(0, nowMs - resumedMs), plannedMs);
      if (focusedMs >= plannedMs) {
        phase = 'finished';
        outcome = 'completed';
        endedAt = new Date(completionMoment(resumedMs, accumulatedMs, plannedMs, nowMs)).toISOString();
      }
    }
  } else if (stored === 'paused') {
    focusedMs = clampCredit(accumulatedMs, plannedMs);
  } else if (stored === 'interrupted') {
    focusedMs = clampCredit(accumulatedMs, plannedMs);
    interruption = {
      at: row.interrupted_at === null ? String(row.last_seen_at) : String(row.interrupted_at),
      gapMs: row.interruption_ms === null ? 0 : Number(row.interruption_ms),
      reason: row.interruption_reason === null ? 'gap' : String(row.interruption_reason),
    };
  } else {
    focusedMs = clampCredit(accumulatedMs, plannedMs);
    if (row.interruption_ms !== null && Number(row.interruption_ms) > 0) {
      interruption = {
        at: row.interrupted_at === null ? String(row.last_seen_at) : String(row.interrupted_at),
        gapMs: Number(row.interruption_ms),
        reason: row.interruption_reason === null ? 'gap' : String(row.interruption_reason),
      };
    }
  }

  return {
    id: String(row.id),
    kind: String(row.kind),
    phase,
    task,
    plannedMinutes: plannedMs / MINUTE_MS,
    plannedMs,
    focusedMs,
    remainingMs: Math.max(0, plannedMs - focusedMs),
    progress: plannedMs === 0 ? 0 : focusedMs / plannedMs,
    startedAt: String(row.started_at),
    resumedAt: phase === 'running' ? String(row.resumed_at) : null,
    lastSeenAt: String(row.last_seen_at),
    endedAt,
    outcome,
    interruption,
  };
}

/** Resolve the linked task, falling back to the snapshot when it is gone. */
function taskRef(db, row) {
  if (row.task_id === null) return null;
  const taskId = String(row.task_id);
  const snapshot = row.task_title === null ? null : String(row.task_title);
  const task = db.get('SELECT id, title, deleted_at FROM study_task WHERE id = ?', taskId);
  if (task === undefined) return { id: taskId, title: snapshot, deleted: true };
  return { id: taskId, title: String(task.title), deleted: task.deleted_at !== null };
}

/** Persist a terminal completion. Returns the stored row. */
function updateFinished(db, row, creditedMs, endedAtIso, outcome, nowIso) {
  db.run(
    `UPDATE study_timer_session
        SET phase = 'finished', accumulated_ms = ?, resumed_at = NULL, last_seen_at = ?,
            updated_at = ?, ended_at = ?, outcome = ?
      WHERE id = ? AND phase <> 'finished'`,
    creditedMs, nowIso, nowIso, endedAtIso, outcome, row.id,
  );
  return rowById(db, row.id);
}

/** Persist an interruption. Returns the stored row. */
function updateInterrupted(db, row, creditedMs, interruptedAtIso, gapMs, nowIso, reason) {
  db.run(
    `UPDATE study_timer_session
        SET phase = 'interrupted', accumulated_ms = ?, resumed_at = NULL, last_seen_at = ?,
            updated_at = ?, interrupted_at = ?, interruption_ms = ?, interruption_reason = ?
      WHERE id = ? AND phase = 'running'`,
    creditedMs, interruptedAtIso, nowIso, interruptedAtIso, gapMs, reason, row.id,
  );
  return rowById(db, row.id);
}

/** When a running segment reached `plannedMs`, capped at the last observation. */
function completionMoment(resumedMs, accumulatedMs, plannedMs, capMs) {
  const moment = resumedMs + Math.max(0, plannedMs - accumulatedMs);
  return Number.isFinite(moment) ? Math.min(moment, capMs) : capMs;
}

/** Keep a credited duration inside `[0, planned]`. */
function clampCredit(value, plannedMs) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(plannedMs, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

/** Build an `invalid` service failure with a machine-readable field name. */
function invalid(message, details = {}) {
  return new StudyError('invalid', message, details);
}

function requireText(value, field, { max = 200 } = {}) {
  if (typeof value !== 'string') throw invalid(`${field} 必须是字符串`, { field });
  const text = value.trim();
  if (text.length === 0) throw invalid(`${field} 不能为空`, { field });
  if (text.length > max) throw invalid(`${field} 不能超过 ${max} 个字符`, { field, max });
  return text;
}

function requireKind(value) {
  if (typeof value !== 'string' || !KINDS.has(value)) {
    throw invalid('kind 必须是 study 或 rest', { field: 'kind', allowed: [...KINDS] });
  }
  return value;
}

function requireMinutes(value, field) {
  if (!Number.isSafeInteger(value)) throw invalid(`${field} 必须是 1-${MAX_MINUTES} 的整数分钟`, { field });
  if (value < MIN_MINUTES || value > MAX_MINUTES) {
    throw invalid(`${field} 必须在 ${MIN_MINUTES} 到 ${MAX_MINUTES} 分钟之间`, { field, min: MIN_MINUTES, max: MAX_MINUTES });
  }
  return value;
}

/**
 * Read the session a write refers to, and refuse a stale id after the session
 * changed underneath the page.
 */
function requireSession(db, payload) {
  const sessionId = requireText(payload.id, 'id', { max: 64 });
  const latest = latestRow(db);
  if (latest === undefined) {
    throw new StudyError('not_found', `找不到计时 ${sessionId}`, { sessionId });
  }
  if (String(latest.id) !== sessionId) {
    throw new StudyError('conflict', '计时状态已经变化，请刷新后重试', {
      reason: 'session_mismatch',
      sessionId,
      currentId: String(latest.id),
    });
  }
  return latest;
}

/** Refuse actions on an interrupted session until the student confirms it. */
function assertNotInterrupted(view) {
  if (view.phase !== 'interrupted') return;
  throw new StudyError('conflict', '计时中断需要先确认是继续还是结束', {
    reason: 'interruption_unconfirmed',
    sessionId: view.id,
    interruption: view.interruption,
  });
}
