/**
 * 04:00 study-day windows: local boundaries, creation on capture, sealing, the
 * 14-day catch-up tick, and the status read used by the questions page.
 *
 * A study day runs from local 04:00 to the next local 04:00, so a question
 * asked at 02:00 still belongs to "yesterday". Boundaries are built with the
 * `Date` constructor in local time; the stored instants are ISO-8601 UTC, which
 * makes range filters plain lexicographic comparisons.
 *
 * This file owns the window state machine and its SQL. Rule summaries live in
 * `summary.mjs`, which imports the day helpers from here.
 */
import { randomUUID } from 'node:crypto';
import { StudyError } from '../registry.mjs';

/** The only window kind this increment writes; weeks arrive later. */
export const WINDOW_KIND = 'day';

/** The study-day hour that starts a new window. */
export const DAY_START_HOUR = 4;

/** How many days the catch-up tick is allowed to rebuild. */
export const BACKFILL_DAYS = 14;

/** Timer cadence for seal/summary catch-up; ten minutes keeps a day prompt. */
export const TICK_INTERVAL_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Format a local calendar date as `YYYY-MM-DD`.
 * @param {Date} date - Local instant.
 * @returns {string} Local date.
 */
function localDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * The study day an instant belongs to: before 04:00 it is still yesterday.
 * @param {Date | string | number} value - Instant to classify.
 * @returns {string} Local `YYYY-MM-DD` study day.
 */
export function studyDay(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`invalid instant for studyDay: ${String(value)}`);
  if (date.getHours() < DAY_START_HOUR) date.setDate(date.getDate() - 1);
  return localDay(date);
}

/**
 * Window bounds of one study day: local 04:00 to the next local 04:00.
 * @param {string} day - Study day (`YYYY-MM-DD`).
 * @returns {{ day: string, startAt: string, endAt: string }} ISO bounds.
 */
export function windowBounds(day) {
  const match = typeof day === 'string' ? DATE_ONLY.exec(day) : null;
  if (match === null) throw new TypeError(`invalid study day: ${String(day)}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  const start = new Date(year, month - 1, dayOfMonth, DAY_START_HOUR, 0, 0, 0);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== dayOfMonth) {
    throw new TypeError(`invalid study day: ${day}`);
  }
  const end = new Date(year, month - 1, dayOfMonth + 1, DAY_START_HOUR, 0, 0, 0);
  return { day, startAt: start.toISOString(), endAt: end.toISOString() };
}

/**
 * The oldest window start the catch-up tick may rebuild.
 * @param {Date} now - Current instant.
 * @returns {string} ISO cutoff; anything earlier is marked `failed`.
 */
export function backfillCutoff(now) {
  return new Date(now.getTime() - BACKFILL_DAYS * DAY_MS).toISOString();
}

/**
 * Whether a window starts before the catch-up limit.
 * @param {string} startAt - Window start (ISO).
 * @param {Date} now - Current instant.
 * @returns {boolean} True when the window is too old to rebuild.
 */
export function isBeforeBackfill(startAt, now) {
  const millis = Date.parse(String(startAt));
  return !Number.isFinite(millis) || millis < Date.parse(backfillCutoff(now));
}

/**
 * Create the open window of the instant's study day, reopening a window that an
 * earlier exit sealed. A turn captured after an exit seal must land in the same
 * day window so the summary is rebuilt instead of duplicated.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, at: string | Date }} entry - Owning goal and instant.
 * @returns {{ id: string, day: string, startAt: string, endAt: string, created: boolean, reopened: boolean }}
 *   Window reference.
 */
export function ensureWindow(db, { goalId, at }) {
  const day = studyDay(at);
  const bounds = windowBounds(day);
  const existing = db.get(
    `SELECT * FROM study_window WHERE goal_id = ? AND kind = ? AND start_at = ?`,
    goalId,
    WINDOW_KIND,
    bounds.startAt,
  );
  if (existing !== undefined) {
    const status = String(existing.status);
    if (status === 'sealed' || status === 'summarized') {
      db.run("UPDATE study_window SET status = 'open', closed_at = NULL WHERE id = ?", existing.id);
      return { id: String(existing.id), ...bounds, created: false, reopened: true };
    }
    return { id: String(existing.id), ...bounds, created: false, reopened: false };
  }
  const id = `win_${randomUUID()}`;
  db.run(
    `INSERT INTO study_window
      (id, goal_id, kind, start_at, end_at, status, cursor_json, summary_id, closed_at, attempts)
     VALUES (?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, 0)`,
    id,
    goalId,
    WINDOW_KIND,
    bounds.startAt,
    bounds.endAt,
  );
  return { id, ...bounds, created: true, reopened: false };
}

/**
 * The open window of an instant's study day, if any. Read-only; the exit
 * disposer uses it to issue one seal call before the kernel closes.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, now: Date }} entry - Owning goal and instant.
 * @returns {{ id: string, sealGeneration: number } | null} Window reference.
 */
export function openWindowForInstant(db, { goalId, now }) {
  const bounds = windowBounds(studyDay(now));
  const row = db.get(
    "SELECT * FROM study_window WHERE goal_id = ? AND kind = ? AND start_at = ? AND status = 'open'",
    goalId,
    WINDOW_KIND,
    bounds.startAt,
  );
  if (row === undefined) return null;
  return { id: String(row.id), sealGeneration: Number(cursorOf(row).seals ?? 0) };
}

/**
 * Seal one window. Sealing a window that is already sealed, summarized, or
 * failed returns its current state, so the tick may replay safely.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ id: string, now: Date }} entry - Window id and current instant.
 * @returns {object} Window view after the transition.
 */
export function sealWindowRow(db, { id, now }) {
  const row = db.get('SELECT * FROM study_window WHERE id = ?', id);
  if (row === undefined) throw new StudyError('not_found', `没有 id 为 ${id} 的学习窗口`, { id });
  const status = String(row.status);
  if (status !== 'open') return windowView(db, row, now);
  const at = now.toISOString();
  const cursor = cursorOf(row);
  const next = { ...cursor, seals: Number(cursor.seals ?? 0) + 1 };
  if (isBeforeBackfill(String(row.start_at), now)) {
    db.run(
      "UPDATE study_window SET status = 'failed', attempts = attempts + 1, closed_at = ?, cursor_json = ? WHERE id = ?",
      at,
      JSON.stringify({ ...next, failure: 'backfill_limit', failedAt: at }),
      id,
    );
  } else {
    db.run(
      "UPDATE study_window SET status = 'sealed', closed_at = ?, cursor_json = ? WHERE id = ?",
      at,
      JSON.stringify(next),
      id,
    );
  }
  return windowView(db, db.get('SELECT * FROM study_window WHERE id = ?', id), now);
}

/**
 * Current window plus the recent windows of the active goal.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, now: Date }} entry - Active goal and current instant.
 * @returns {object} `{ today, goalId, window, recent, backfill, pending }`.
 */
export function windowStatusData(db, { goalId, now }) {
  const today = studyDay(now);
  const bounds = windowBounds(today);
  const current = db.get(
    'SELECT * FROM study_window WHERE goal_id = ? AND kind = ? AND start_at = ?',
    goalId,
    WINDOW_KIND,
    bounds.startAt,
  );
  const recent = db.all(
    'SELECT * FROM study_window WHERE goal_id = ? AND kind = ? ORDER BY start_at DESC LIMIT 7',
    goalId,
    WINDOW_KIND,
  );
  return {
    today,
    goalId,
    window: current === undefined ? null : windowView(db, current, now),
    recent: recent.map(row => windowView(db, row, now)),
    backfill: { days: BACKFILL_DAYS, cutoff: backfillCutoff(now) },
    pending: {
      seal: countWindows(db, goalId, "status = 'open' AND end_at <= ?", now.toISOString()),
      summarize: countWindows(db, goalId, "status = 'sealed' AND end_at <= ?", now.toISOString()),
      failed: countWindows(db, goalId, "status = 'failed'", undefined),
    },
  };
}

/**
 * One window as the service layer returns it. The summary is the currently
 * referenced row, so an open window may still show the summary it had before a
 * reopen.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {Record<string, unknown>} row - `study_window` row.
 * @param {Date} now - Current instant, for the note code.
 * @returns {object} Serializable window view.
 */
export function windowView(db, row, now) {
  const summary = row.summary_id === null || row.summary_id === undefined
    ? undefined
    : db.get('SELECT id, text, created_at, input_hash FROM study_window_summary WHERE id = ?', row.summary_id);
  const cursor = cursorOf(row);
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    kind: String(row.kind),
    day: studyDay(new Date(String(row.start_at))),
    startAt: String(row.start_at),
    endAt: String(row.end_at),
    status: String(row.status),
    closedAt: row.closed_at === null || row.closed_at === undefined ? null : String(row.closed_at),
    summaryId: row.summary_id === null || row.summary_id === undefined ? null : String(row.summary_id),
    attempts: Number(row.attempts),
    sealGeneration: Number(cursor.seals ?? 0),
    summary: summary === undefined
      ? null
      : {
        id: String(summary.id),
        text: String(summary.text),
        createdAt: String(summary.created_at),
        inputHash: String(summary.input_hash),
      },
    note: noteCode(row, now),
  };
}

/**
 * Machine-readable reason a window is not on the happy path; the page maps it
 * to localized copy instead of showing host text.
 * @param {Record<string, unknown>} row - `study_window` row.
 * @param {Date} now - Current instant.
 * @returns {'backfill_limit' | 'overdue' | 'empty' | 'retrying' | null} Note code.
 */
function noteCode(row, now) {
  const status = String(row.status);
  if (status === 'failed') return 'backfill_limit';
  if (status === 'open' && Date.parse(String(row.end_at)) <= now.getTime()) return 'overdue';
  if (status === 'summarized' && (row.summary_id === null || row.summary_id === undefined)) return 'empty';
  if (Number(row.attempts) > 0 && status !== 'summarized') return 'retrying';
  return null;
}

/**
 * Run one catch-up pass: seal every finished open window, then summarize every
 * finished sealed window. Each transition is a service write with a
 * generation-suffixed `requestId`, so a replay returns the prior result while a
 * window that was reopened and sealed again gets a fresh request.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {(ns: string, method: string, payload: object, options: object) => Promise<object>} call
 *   Service caller, normally `ctx.study.call`.
 * @param {() => Date} now - Clock.
 * @returns {Promise<{ sealed: number, summarized: number, failed: number, errors: number }>} Pass counts.
 */
export async function runWindowTick(db, call, now = () => new Date()) {
  const at = now();
  const atIso = at.toISOString();
  const result = { sealed: 0, summarized: 0, failed: 0, errors: 0 };

  const openRows = db.all(
    "SELECT * FROM study_window WHERE kind = ? AND status = 'open' AND end_at <= ? ORDER BY start_at ASC",
    WINDOW_KIND,
    atIso,
  );
  for (const row of openRows) {
    const generation = Number(cursorOf(row).seals ?? 0) + 1;
    const outcome = await settleCall(call, 'sealWindow', { id: String(row.id) }, `window:seal:${row.id}:${generation}`);
    if (outcome === null) {
      result.errors += 1;
      continue;
    }
    if (outcome.status === 'failed') result.failed += 1;
    else result.sealed += 1;
  }

  const sealedRows = db.all(
    "SELECT * FROM study_window WHERE kind = ? AND status = 'sealed' AND end_at <= ? ORDER BY start_at ASC",
    WINDOW_KIND,
    atIso,
  );
  for (const row of sealedRows) {
    // Keyed by the seal generation and the invalidation counter, so a window
    // reopened, resealed, or corrected gets a fresh summarize call instead of
    // replaying a stale envelope.
    const cursor = cursorOf(row);
    const generation = `${Number(cursor.seals ?? 0)}.${Number(cursor.stale ?? 0)}`;
    const outcome = await settleCall(call, 'summarizeWindow', { id: String(row.id) }, `window:summary:${row.id}:${generation}`);
    if (outcome === null) {
      result.errors += 1;
      continue;
    }
    if (outcome.status === 'failed') result.failed += 1;
    else result.summarized += 1;
  }
  return result;
}

/**
 * Reopen a summarized day for rebuilding after a merge or split touched one of
 * its units. The stale counter changes the next summarize request id, so the
 * summary is genuinely recomputed instead of replayed.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {string[]} episodeIds - Units whose boundary changed.
 * @returns {number} Number of windows marked for rebuilding.
 */
export function markSummaryStaleForEpisodes(db, episodeIds) {
  if (episodeIds.length === 0) return 0;
  const placeholders = episodeIds.map(() => '?').join(', ');
  const rows = db.all(
    `SELECT DISTINCT w.* FROM study_window w
       JOIN study_episode e ON e.goal_id = w.goal_id
        AND e.opened_at >= w.start_at AND e.opened_at < w.end_at
      WHERE e.id IN (${placeholders}) AND w.kind = ? AND w.status = 'summarized'`,
    ...episodeIds,
    WINDOW_KIND,
  );
  for (const row of rows) {
    const cursor = cursorOf(row);
    db.run(
      "UPDATE study_window SET status = 'sealed', cursor_json = ? WHERE id = ?",
      JSON.stringify({ ...cursor, stale: Number(cursor.stale ?? 0) + 1 }),
      row.id,
    );
  }
  return rows.length;
}

/**
 * One service call whose failure is logged instead of stopping the pass.
 * @returns {Promise<object | null>} Service value, or null on failure.
 */
async function settleCall(call, method, payload, requestId) {
  try {
    const outcome = await call('learning', method, payload, { actor: 'system', requestId });
    if (outcome?.ok === true) return outcome.value;
    console.warn(`[study] window tick ${method} failed: ${outcome?.code ?? 'unknown'}: ${outcome?.message ?? ''}`);
  } catch (error) {
    console.warn(`[study] window tick ${method} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

function countWindows(db, goalId, condition, param) {
  const statement = `SELECT COUNT(*) AS total FROM study_window WHERE goal_id = ? AND kind = ? AND ${condition}`;
  const row = param === undefined
    ? db.get(statement, goalId, WINDOW_KIND)
    : db.get(statement, goalId, WINDOW_KIND, param);
  return Number(row.total);
}

/**
 * Parsed `cursor_json`; a corrupt cursor is treated as empty.
 * @param {Record<string, unknown>} row - Window row.
 * @returns {Record<string, unknown>} Cursor object.
 */
function cursorOf(row) {
  const raw = row.cursor_json;
  if (raw === null || raw === undefined) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
