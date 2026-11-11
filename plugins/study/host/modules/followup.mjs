import { resolveActiveGoal } from '../facts.mjs';
/**
 * Block-end reminders and deterministic evening review. Each execution block
 * has one durable key; quiet/focus/snooze defer delivery without consuming it.
 * The Host checks while running and never replays ends missed while closed.
 * Review preserves the original task estimate, splits remaining execution into
 * free blocks, and marks unconfirmed work tentative. Decision B: preview only
 * until the student confirms a version-checked plan revision.
 */
import { randomUUID } from 'node:crypto';
import { StudyError } from '../registry.mjs';

/** Module id; matches the `followup` service namespace. */
export const id = 'followup';

/** Followup reads and writes through the task and plan services. */
export const deps = ['tasks', 'plans'];

/** Schema version recorded in `module_schema`; bump when the DDL below changes. */
export const schemaVersion = 1;

/** How often the host records that the app is still alive. */
export const HEARTBEAT_MS = 15_000;

/**
 * Largest heartbeat gap still treated as "the app kept running". Six missed
 * beats leave room for a busy event loop; a suspended or closed app is well
 * beyond it.
 */
export const STALE_MS = 90_000;

/** Days after the review date that may receive unfinished work. */
export const REVIEW_HORIZON_DAYS = 7;

/** Tables owned by this module. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS study_followup_settings (
    id             TEXT PRIMARY KEY,
    enabled        INTEGER NOT NULL,
    quiet_start    TEXT NOT NULL,
    quiet_end      TEXT NOT NULL,
    review_at      TEXT NOT NULL,
    review_enabled INTEGER NOT NULL,
    snooze_minutes INTEGER NOT NULL,
    updated_at     TEXT NOT NULL,
    CHECK (enabled IN (0, 1)),
    CHECK (review_enabled IN (0, 1)),
    CHECK (snooze_minutes >= 1 AND snooze_minutes <= 120)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS study_followup_state (
    id           TEXT PRIMARY KEY,
    last_seen_at TEXT NOT NULL,
    resumed_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS study_followup_reminder (
    key          TEXT PRIMARY KEY,
    block_id     TEXT,
    date         TEXT NOT NULL,
    period       TEXT NOT NULL,
    task_id      TEXT NOT NULL,
    task_title   TEXT NOT NULL,
    blocks_json  TEXT NOT NULL,
    start        TEXT,
    end          TEXT,
    minutes      INTEGER NOT NULL,
    state        TEXT NOT NULL,
    outcome      TEXT,
    snooze_until TEXT,
    snooze_count INTEGER NOT NULL DEFAULT 0,
    asked_at     TEXT NOT NULL,
    answered_at  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    CHECK (state IN ('shown', 'snoozed', 'answered', 'expired')),
    CHECK (minutes >= 0)
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_followup_reminder_day ON study_followup_reminder (date, period, state)',
  `CREATE TABLE IF NOT EXISTS study_followup_review (
    id                TEXT PRIMARY KEY,
    date              TEXT NOT NULL,
    status            TEXT NOT NULL,
    plan_id           TEXT,
    base_revision     INTEGER,
    plan_revision     INTEGER,
    moved_json        TEXT NOT NULL DEFAULT '[]',
    unscheduled_json  TEXT NOT NULL DEFAULT '[]',
    kept_json         TEXT NOT NULL DEFAULT '[]',
    days_json         TEXT NOT NULL DEFAULT '[]',
    summary_json      TEXT NOT NULL DEFAULT '{}',
    error_code        TEXT,
    error_message     TEXT,
    actor             TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    CHECK (status IN ('committed', 'needs_adjustment', 'nothing_to_do', 'blocked', 'no_plan'))
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_followup_review_day ON study_followup_review (date, created_at)',
  `CREATE TRIGGER IF NOT EXISTS study_followup_review_no_update
   BEFORE UPDATE ON study_followup_review BEGIN
     SELECT RAISE(ABORT, 'study_followup_review is append-only');
   END`,
  `CREATE TRIGGER IF NOT EXISTS study_followup_review_no_delete
   BEFORE DELETE ON study_followup_review BEGIN
     SELECT RAISE(ABORT, 'study_followup_review is append-only');
   END`,
];

const WRITE_METHODS = ['runDueCheck', 'runReview', 'claim', 'answer', 'snooze', 'updateSettings', 'review'];

const REPLIES = Object.freeze({
  done: { status: 'done', note: '完成' },
  partial: { status: 'partial', note: '部分完成' },
  not_done: { status: 'not_started', note: '未完成' },
});

const PERIODS = Object.freeze(['night', 'morning', 'afternoon', 'evening']);
const PERIOD_BOUNDS = Object.freeze({
  night: [0, 360],
  morning: [360, 720],
  afternoon: [720, 1080],
  evening: [1080, 1440],
});

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  quietStart: '22:00',
  quietEnd: '07:00',
  reviewAt: '21:30',
  reviewEnabled: true,
  snoozeMinutes: 10,
});

const MAX_KEYS = 50;
const MAX_TEXT = 300;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

const KEPT_REASONS = Object.freeze({
  unrecorded: '未记录，未自动移动（未勾选不等于未完成）',
  pending_confirmation: '待确认，未自动移动',
  fixed: '固定安排，保留在原日期',
  no_remaining: '已完成数量达到总量，无需再移动',
});

/**
 * Register the `followup` service and start its liveness heartbeat.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study`.
 * @param {object} kernel - Kernel handle, used for the clock and boot state.
 */
export function apply(ctx, kernel) {
  const callStudy = (ns, method, payload, options) => ctx.study.call(ns, method, payload, options);
  kernel.database.run("UPDATE study_followup_reminder SET state='expired' WHERE key LIKE 'task:%' AND state IN ('shown','snoozed')");
  if (!kernel.database.all('PRAGMA table_info(study_followup_reminder)').some(column => column.name === 'block_id')) {
    kernel.database.exec('ALTER TABLE study_followup_reminder ADD COLUMN block_id TEXT');
  }
  const scopedCall = (payload, api) => (ns, method, body, options) => callStudy(ns, method,
    ['tasks', 'plans', 'materials', 'memory', 'outcomes'].includes(ns)
      ? { ...body, goalId: body?.goalId ?? resolveActiveGoal(api.db, payload.goalId) } : body, options);
  markStarted(kernel);
  ctx.effect(() => ctx.study.register('followup', {
    methods: {
      due: (payload, api) => due(payload, api, scopedCall(payload, api)),
      claim: (payload, api) => claim(payload, api, scopedCall(payload, api)),
      answer: (payload, api) => answer(payload, api, scopedCall(payload, api)),
      snooze,
      getSettings,
      updateSettings,
      reviewPreview: (payload, api) => reviewPreview(payload, api, scopedCall(payload, api)),
      review: (payload, api) => review(payload, api, scopedCall(payload, api)),
      reviewStatus,
      runDueCheck: (payload, api) => claim(payload, api, scopedCall(payload, api)),
      runReview: (payload, api) => reviewPreview(payload, api, scopedCall(payload, api)),
      recovery: (payload, api) => recovery(payload, api, scopedCall(payload, api)),
    },
    writes: WRITE_METHODS,
  }), 'study: followup namespace');
  ctx.effect(() => startHeartbeat(kernel, callStudy), 'study: followup heartbeat');
}

// ---------------------------------------------------------------------------
// Clock, app liveness, and periods
// ---------------------------------------------------------------------------

/** Read the kernel's own clock; heartbeats run outside a service call. */
function kernelNow(kernel) {
  return new Date(kernel.status().serverTime);
}

/** Start the liveness interval; returns its disposer. */
function startHeartbeat(kernel, callStudy) {
  let running = false;
  const handle = setInterval(() => {
    try {
      heartbeat(kernel);
      if (!running) {
        running = true;
        callStudy('followup', 'runDueCheck', {}, { actor: 'system', requestId: `due:${resolveActiveGoal(kernel.database)}:${Math.floor(Date.now() / 60000)}` })
          .then(() => callStudy('followup', 'due', {}))
          .then(state => state.ok && !state.value.pausedReason && state.value.review.due ? callStudy('followup', 'runReview', {}, { actor: 'system', requestId: `review:${resolveActiveGoal(kernel.database)}:${localDateOf(kernelNow(kernel))}` }) : null)
          .catch(error => console.warn('[study] followup check failed:', error))
          .finally(() => { running = false; });
      }
    } catch (error) {
      console.warn('[study] followup heartbeat failed:', error);
    }
  }, HEARTBEAT_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

/**
 * Mark a fresh start: a new process has begun, so nothing that started before
 * this instant may be reminded retroactively.
 * @param {object} kernel - Kernel handle.
 */
export function markStarted(kernel) {
  const now = kernelNow(kernel).toISOString();
  kernel.database.run(
    `INSERT INTO study_followup_state (id, last_seen_at, resumed_at, updated_at)
     VALUES ('app', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, resumed_at = excluded.resumed_at, updated_at = excluded.updated_at`,
    now, now, now,
  );
}

/**
 * Record one live instant. A gap over {@link STALE_MS} means the app was
 * suspended or closed, so the resume marker moves to now and work that started
 * during the gap will not be backfilled.
 * @param {object} kernel - Kernel handle.
 */
export function heartbeat(kernel) {
  const now = kernelNow(kernel);
  const nowIso = now.toISOString();
  const database = kernel.database;
  const row = database.get("SELECT last_seen_at, resumed_at FROM study_followup_state WHERE id = 'app'");
  let resumedAt = nowIso;
  if (row !== undefined) {
    const lastSeenMs = Date.parse(String(row.last_seen_at));
    const gapMs = Number.isFinite(lastSeenMs) ? now.getTime() - lastSeenMs : Number.POSITIVE_INFINITY;
    resumedAt = gapMs > STALE_MS ? nowIso : String(row.resumed_at);
  }
  database.run(
    `INSERT INTO study_followup_state (id, last_seen_at, resumed_at, updated_at)
     VALUES ('app', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, resumed_at = excluded.resumed_at, updated_at = excluded.updated_at`,
    nowIso, resumedAt, nowIso,
  );
}

/**
 * Read the effective resume marker. When the heartbeat itself is stale, treat
 * the current read as the resume instant so even the first check after a wake
 * cannot backfill the gap.
 * @param {object} database - Study database handle.
 * @param {Date} now - Current instant.
 * @returns {{ resumedAt: Date, resumedIso: string, gapMs: number | null, stale: boolean }} Resume point.
 */
function resumeInfo(database, now) {
  const row = database.get("SELECT last_seen_at, resumed_at FROM study_followup_state WHERE id = 'app'");
  if (row === undefined) {
    return { resumedAt: now, resumedIso: now.toISOString(), gapMs: null, stale: true };
  }
  const lastSeenMs = Date.parse(String(row.last_seen_at));
  const gapMs = Number.isFinite(lastSeenMs) ? now.getTime() - lastSeenMs : Number.POSITIVE_INFINITY;
  if (gapMs > STALE_MS) {
    return { resumedAt: now, resumedIso: now.toISOString(), gapMs, stale: true };
  }
  const resumedAt = new Date(String(row.resumed_at));
  return { resumedAt, resumedIso: resumedAt.toISOString(), gapMs, stale: false };
}

/** Local hour/minute of one instant. */
function localClock(date) {
  return { minutes: date.getHours() * 60 + date.getMinutes() };
}

/** The day period containing a minute-of-day. */
function periodOf(minutes) {
  if (minutes < PERIOD_BOUNDS.morning[0]) return 'night';
  if (minutes < PERIOD_BOUNDS.afternoon[0]) return 'morning';
  if (minutes < PERIOD_BOUNDS.evening[0]) return 'afternoon';
  return 'evening';
}

/** Local `YYYY-MM-DD` of one instant. */
function localDateOf(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parse `HH:MM` into minutes from midnight. */
function timeToMinutes(text) {
  const match = TIME_PATTERN.exec(text);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Format minutes from midnight as `HH:MM`; 1440 stays `24:00` for display. */
function minutesToTime(minutes) {
  if (minutes === 1440) return '24:00';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Local `HH:MM` of one instant. */
function clockText(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Days since 1970-01-01 for a validated local date. */
function dateToDayNumber(text) {
  const [year, month, day] = text.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** Inverse of {@link dateToDayNumber}. */
function dayNumberToDate(number) {
  const date = new Date(number * DAY_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Move a local date by whole days. */
function addDays(text, delta) {
  return dayNumberToDate(dateToDayNumber(text) + delta);
}

/** True when the date's local start is at or after the resume instant. */
function periodStartsAfterResume(date, startMinute, resume) {
  const resumedDate = localDateOf(resume.resumedAt);
  if (resumedDate !== date) return resumedDate < date;
  const resumedMinute = localClock(resume.resumedAt).minutes;
  return startMinute >= resumedMinute;
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function invalid(message, details = {}) {
  return new StudyError('invalid', message, details);
}

function requireText(value, field, { min = 1, max = MAX_TEXT } = {}) {
  if (typeof value !== 'string') throw invalid(`${field} 必须是字符串`, { field });
  const text = value.trim();
  if (text.length < min) throw invalid(`${field} 不能为空`, { field });
  if (text.length > max) throw invalid(`${field} 不能超过 ${max} 个字符`, { field, max });
  return text;
}

function optionalText(value, field, options) {
  if (value === undefined || value === null) return null;
  return requireText(value, field, options);
}

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw invalid(`${field} 必须是 true 或 false`, { field });
  return value;
}

function optionalInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value)) throw invalid(`${field} 必须是整数`, { field });
  if (value < min || value > max) throw invalid(`${field} 必须在 ${min} 到 ${max} 之间`, { field, min, max });
  return value;
}

function oneOf(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`${field} 只能是 ${allowed.join('、')} 之一`, { field, allowed });
  }
  return value;
}

function validDateText(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function optionalDate(value, field) {
  if (value === undefined || value === null) return null;
  const text = requireText(value, field, { max: 10 });
  if (!validDateText(text)) throw invalid(`${field} 必须是有效日期 YYYY-MM-DD`, { field });
  return text;
}

function requireTime(value, field) {
  const text = requireText(value, field, { max: 5 });
  if (!TIME_PATTERN.test(text)) throw invalid(`${field} 必须是 HH:MM 格式的时间`, { field });
  return text;
}

function optionalTime(value, field) {
  if (value === undefined || value === null) return null;
  return requireTime(value, field);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Read the one settings row, falling back to the documented defaults. */
function readSettings(db) {
  const row = db.get("SELECT * FROM study_followup_settings WHERE id = 'settings'");
  if (row === undefined) {
    return {
      ...DEFAULT_SETTINGS,
      updatedAt: null,
    };
  }
  return {
    enabled: Number(row.enabled) === 1,
    quietStart: String(row.quiet_start),
    quietEnd: String(row.quiet_end),
    reviewAt: String(row.review_at),
    reviewEnabled: Number(row.review_enabled) === 1,
    snoozeMinutes: Number(row.snooze_minutes),
    updatedAt: String(row.updated_at),
  };
}

/** Read the settings through the service. */
function getSettings(_payload, api) {
  return { settings: readSettings(api.db) };
}

/** Update selected settings; every omitted field keeps its stored value. */
function updateSettings(payload, api) {
  const before = readSettings(api.db);
  const enabled = optionalBoolean(payload.enabled, 'enabled') ?? before.enabled;
  const quietStart = optionalTime(payload.quietStart, 'quietStart') ?? before.quietStart;
  const quietEnd = optionalTime(payload.quietEnd, 'quietEnd') ?? before.quietEnd;
  const reviewAt = optionalTime(payload.reviewAt, 'reviewAt') ?? before.reviewAt;
  const reviewEnabled = optionalBoolean(payload.reviewEnabled, 'reviewEnabled') ?? before.reviewEnabled;
  const snoozeMinutes = optionalInteger(payload.snoozeMinutes, 'snoozeMinutes', { min: 1, max: 120 }) ?? before.snoozeMinutes;
  const fields = ['enabled', 'quietStart', 'quietEnd', 'reviewAt', 'reviewEnabled', 'snoozeMinutes'];
  if (fields.every(field => payload[field] === undefined)) {
    throw invalid('没有可更新的提醒设置', { fields });
  }
  const now = api.now().toISOString();
  api.db.run(
    `INSERT INTO study_followup_settings
       (id, enabled, quiet_start, quiet_end, review_at, review_enabled, snooze_minutes, updated_at)
     VALUES ('settings', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       quiet_start = excluded.quiet_start,
       quiet_end = excluded.quiet_end,
       review_at = excluded.review_at,
       review_enabled = excluded.review_enabled,
       snooze_minutes = excluded.snooze_minutes,
       updated_at = excluded.updated_at`,
    enabled ? 1 : 0,
    quietStart,
    quietEnd,
    reviewAt,
    reviewEnabled ? 1 : 0,
    snoozeMinutes,
    now,
  );
  const after = readSettings(api.db);
  api.change({ entity: 'followup_settings', entityId: 'settings', action: 'update', before, after });
  return { settings: after };
}

// ---------------------------------------------------------------------------
// Quiet hours and focus
// ---------------------------------------------------------------------------

/**
 * Resolve the current quiet window. Equal start and end mean no quiet hours.
 * @param {{ quietStart: string, quietEnd: string }} settings - Stored settings.
 * @param {Date} now - Current instant.
 * @returns {{ active: boolean, start: string, end: string, until: string | null }} Quiet state.
 */
function quietState(settings, now) {
  const startMinute = timeToMinutes(settings.quietStart);
  const endMinute = timeToMinutes(settings.quietEnd);
  if (startMinute === null || endMinute === null || startMinute === endMinute) {
    return { active: false, start: settings.quietStart, end: settings.quietEnd, until: null };
  }
  const minute = localClock(now).minutes;
  const overnight = startMinute > endMinute;
  const active = overnight
    ? (minute >= startMinute || minute < endMinute)
    : (minute >= startMinute && minute < endMinute);
  if (!active) return { active: false, start: settings.quietStart, end: settings.quietEnd, until: null };
  const until = new Date(now.getTime());
  until.setSeconds(0, 0);
  if (!overnight || minute < endMinute) {
    until.setHours(Math.floor(endMinute / 60), endMinute % 60, 0, 0);
  } else {
    until.setDate(until.getDate() + 1);
    until.setHours(Math.floor(endMinute / 60), endMinute % 60, 0, 0);
  }
  return { active: true, start: settings.quietStart, end: settings.quietEnd, until: until.toISOString() };
}

/**
 * Read the timer service for a running study session. A missing timer
 * namespace or a failed read simply means "not focused".
 * @param {Function} callStudy - `ctx.study.call` face.
 * @param {Date} now - Current instant.
 * @returns {Promise<{ active: boolean, sessionId: string | null, until: string | null }>} Focus state.
 */
async function focusState(callStudy, now) {
  let envelope;
  try {
    envelope = await callStudy('timer', 'status', {});
  } catch (error) {
    return { active: false, sessionId: null, until: null };
  }
  if (envelope?.ok !== true) return { active: false, sessionId: null, until: null };
  const session = envelope.value?.session;
  if (session === null || session === undefined) return { active: false, sessionId: null, until: null };
  if (session.phase !== 'running' || session.kind !== 'study') {
    return { active: false, sessionId: null, until: null };
  }
  const remaining = Number(session.remainingMs);
  const until = Number.isFinite(remaining) && remaining > 0
    ? new Date(now.getTime() + remaining).toISOString()
    : null;
  return { active: true, sessionId: String(session.id), until };
}

// ---------------------------------------------------------------------------
// Reminder reads
// ---------------------------------------------------------------------------

/**
 * Call one nested service method and turn a failure envelope into a thrown
 * service error, so the outer kernel reports the same code and message.
 */
async function requireCall(callStudy, ns, method, payload, options) {
  const envelope = await callStudy(ns, method, payload, options);
  if (envelope?.ok !== true) {
    throw new StudyError(envelope?.code ?? 'unavailable', envelope?.message ?? `${ns}.${method} 调用失败`, envelope?.details ?? {});
  }
  return envelope.value;
}

/** Read the latest progress record of one task from a `tasks.day` value. */
function taskProgressOf(dayValue, taskId) {
  const entry = dayValue.progress?.[taskId];
  return entry ?? null;
}

/** True when a task already reached a terminal state and must not be asked about. */
function terminalProgress(progress) {
  return progress !== null && (progress.status === 'done' || progress.status === 'cancelled');
}

/**
 * Build the merged reminder items that are due in the current period.
 * The result distinguishes unclaimed (`newItems`), already-shown
 * (`pendingItems`), and paused (`deferredItems`) work.
 * @param {object} api - Kernel method API.
 * @param {Function} callStudy - `ctx.study.call` face.
 * @returns {Promise<object>} Due state, settings, pause state, and review nudge.
 */
async function computeDue(api, callStudy) {
  const settings = readSettings(api.db);
  const now = api.now();
  const date = api.today();
  const minute = localClock(now).minutes;
  const period = periodOf(minute);
  const resume = resumeInfo(api.db, now);
  const quiet = quietState(settings, now);
  const focus = await focusState(callStudy, now);
  const disabled = !settings.enabled;
  const pausedReason = disabled ? 'disabled' : quiet.active ? 'quiet' : focus.active ? 'focus' : null;

  let newItems = [];
  let pendingItems = [];
  if (!disabled) {
    const dayValue = await requireCall(callStudy, 'tasks', 'day', { date });
    const groups = new Map();
    for (const block of dayValue.blocks) {
      if (block.fixed) continue;
      if (block.taskId === null) continue;
      if (block.task?.deleted === true) continue;
      if (block.endMinute > minute) continue;
      const list = groups.get(block.id) ?? [];
      list.push(block);
      groups.set(block.id, list);
    }
    for (const [blockId, blocks] of groups) {
      blocks.sort((left, right) => left.startMinute - right.startMinute || left.id.localeCompare(right.id));
      const first = blocks[0];
      const taskId = first.taskId;
      if (!periodStartsAfterResume(date, first.endMinute, resume)) continue;
      const progress = taskProgressOf(dayValue, taskId);
      const answeredSibling = api.db.get("SELECT key FROM study_followup_reminder WHERE task_id=? AND state='answered' AND outcome='done'", taskId);
      const blockReply = answeredSibling && progress?.status === 'done'
        && progress.note === `提醒快捷答复：${REPLIES.done.note}`;
      if ((terminalProgress(progress) && !blockReply) || (progress !== null && progress.confirmed === false)) continue;
      const key = `block:${blockId}`;
      const row = api.db.get('SELECT * FROM study_followup_reminder WHERE key = ?', key);
      if (row !== undefined) {
        if (row.state === 'answered' || row.state === 'expired') continue;
        if (String(row.asked_at) < resume.resumedIso) continue;
        if (row.state === 'snoozed') {
          const until = row.snooze_until === null ? null : String(row.snooze_until);
          if (until === null || until > now.toISOString()) continue;
          if (until < resume.resumedIso) continue;
        }
      }
      const item = reminderItem(key, taskId, first, blocks, date, period, minute, row);
      if (row === undefined) newItems.push(item);
      else pendingItems.push(item);
    }
  }

  newItems.sort((left, right) => left.start.localeCompare(right.start) || left.taskId.localeCompare(right.taskId));
  pendingItems.sort((left, right) => left.start.localeCompare(right.start) || left.taskId.localeCompare(right.taskId));

  const paused = pausedReason !== null;
  const deferredItems = paused && !disabled
    ? [...newItems, ...pendingItems].map(item => ({ ...item, deferredReason: pausedReason }))
    : [];

  return {
    settings,
    now,
    date,
    period,
    minute,
    resume,
    quiet,
    focus,
    disabled,
    pausedReason,
    newItems: paused ? [] : newItems,
    pendingItems: paused ? [] : pendingItems,
    deferredItems,
    pausedPendingCount: paused ? pendingItems.length : 0,
  };
}

/** Build one task/period reminder view from its period blocks and optional ledger row. */
function reminderItem(key, taskId, first, blocks, date, period, minute, row) {
  const endMinute = Math.max(...blocks.map(block => block.endMinute));
  return {
    key,
    taskId,
    blockId: first.id,
    title: blocks[0].task?.title === null || blocks[0].task?.title === undefined ? blocks[0].title : blocks[0].task.title,
    date,
    period,
    start: minutesToTime(first.startMinute),
    end: minutesToTime(endMinute),
    startMinute: first.startMinute,
    endMinute,
    minutes: blocks.reduce((sum, block) => sum + block.minutes, 0),
    blocks: blocks.map(block => ({
      id: block.id,
      start: block.start,
      end: block.end,
      minutes: block.minutes,
    })),
    overdueMinutes: Math.max(0, minute - endMinute),
    state: row === undefined ? 'new' : (row.state === 'snoozed' ? 'snoozed' : 'shown'),
    askedAt: row === undefined ? null : String(row.asked_at),
    snoozeUntil: row === undefined || row.snooze_until === null ? null : String(row.snooze_until),
  };
}

/** Latest review attempt for the date, or null. */
function latestReviewRow(db, date, goalId) {
  return db.get(
    'SELECT * FROM study_followup_review WHERE date = ? AND goal_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    date, resolveActiveGoal(db, goalId) ?? 'unassigned',
  );
}

/** Public view of one review attempt. */
function reviewView(row) {
  if (row === undefined) return null;
  return {
    id: String(row.id),
    goalId: row.goal_id,
    date: String(row.date),
    status: String(row.status),
    planId: row.plan_id === null ? null : String(row.plan_id),
    baseRevision: row.base_revision === null ? null : Number(row.base_revision),
    planRevision: row.plan_revision === null ? null : Number(row.plan_revision),
    moved: parseJson(row.moved_json, []),
    unscheduled: parseJson(row.unscheduled_json, []),
    kept: parseJson(row.kept_json, []),
    days: parseJson(row.days_json, []),
    summary: parseJson(row.summary_json, {}),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    actor: String(row.actor),
    createdAt: String(row.created_at),
  };
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StudyError('unavailable', '提醒数据损坏，无法读取', { reason: error.message });
  }
}

/**
 * Current reminders plus the evening-review nudge. This is a read: it never
 * claims or expires a row, so polling cannot spend an ask.
 */
async function due(_payload, api, callStudy) {
  const state = await computeDue(api, callStudy);
  const reviewRow = latestReviewRow(api.db, state.date, _payload.goalId);
  const reviewStatus = reviewRow === undefined ? 'pending' : String(reviewRow.status);
  const reviewMinute = timeToMinutes(state.settings.reviewAt);
  const reviewDue = state.settings.reviewEnabled
    && reviewMinute !== null
    && state.minute >= reviewMinute
    && reviewStatus !== 'committed'
    && reviewStatus !== 'nothing_to_do';
  return {
    now: state.now.toISOString(),
    date: state.date,
    time: clockText(state.now),
    period: state.period,
    enabled: state.settings.enabled,
    pausedReason: state.pausedReason,
    quiet: state.quiet,
    focus: state.focus,
    resumedAt: state.resume.resumedIso,
    newItems: state.newItems,
    pendingItems: state.pendingItems,
    deferredItems: state.deferredItems,
    pausedPendingCount: state.pausedPendingCount,
    settings: state.settings,
    review: {
      due: reviewDue,
      at: state.settings.reviewAt,
      enabled: state.settings.reviewEnabled,
      status: reviewStatus,
      last: reviewView(reviewRow),
    },
  };
}

// ---------------------------------------------------------------------------
// Reminder writes: claim, answer, snooze
// ---------------------------------------------------------------------------

/** Expire cards from earlier days or periods; they are never shown again. */
function expireEarlierRows(api, date, period, excludeKey = null) {
  const nowIso = api.now().toISOString();
  api.db.run(
    `UPDATE study_followup_reminder
        SET state = 'expired', updated_at = ?
      WHERE state IN ('shown', 'snoozed')
        AND (date < ? OR (date = ? AND period = 'legacy'))
        AND key <> ?`,
    nowIso,
    date,
    date,
    excludeKey ?? '',
  );
}

/**
 * Claim the unclaimed reminders of the current period. Claiming records the
 * one ask for that task and period; a claimed card is shown until answered,
 * snoozed, or the period ends.
 */
async function claim(payload, api, callStudy) {
  const state = await computeDue(api, callStudy);
  if (state.disabled || state.pausedReason !== null) {
    return { claimed: [], existing: [], reason: state.pausedReason ?? 'disabled', settings: state.settings };
  }
  const requested = payload.keys === undefined || payload.keys === null ? null : payload.keys;
  if (requested !== null) {
    if (!Array.isArray(requested)) throw invalid('keys 必须是字符串数组', { field: 'keys' });
    if (requested.length > MAX_KEYS) throw invalid(`一次最多确认 ${MAX_KEYS} 条提醒`, { field: 'keys', max: MAX_KEYS });
  }
  const requestedKeys = requested === null ? null : new Set(requested.map((key, index) => requireText(key, `keys[${index}]`, { max: 400 })));
  expireEarlierRows(api, state.date, state.period);
  const nowIso = api.now().toISOString();
  const claimed = [];
  const existing = [];
  for (const item of state.newItems) {
    if (requestedKeys !== null && !requestedKeys.has(item.key)) continue;
    const inserted = api.db.run(
      `INSERT INTO study_followup_reminder
         (key, block_id, goal_id, date, period, task_id, task_title, blocks_json, start, end, minutes, state, outcome,
          snooze_until, snooze_count, asked_at, answered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shown', NULL, NULL, 0, ?, NULL, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
      item.key,
      item.blockId,
      api.db.get('SELECT goal_id FROM study_task WHERE id=?', item.taskId)?.goal_id ?? 'unassigned',
      state.date,
      state.period,
      item.taskId,
      item.title,
      JSON.stringify(item.blocks),
      item.start,
      item.end,
      item.minutes,
      nowIso,
      nowIso,
      nowIso,
    );
    if (Number(inserted.changes) > 0) {
      claimed.push({ ...item, state: 'shown', askedAt: nowIso, snoozeUntil: null });
      api.change({ entity: 'followup_reminder', entityId: item.key, action: 'show', after: { taskId: item.taskId, title: item.title, minutes: item.minutes } });
    } else {
      const row = api.db.get('SELECT * FROM study_followup_reminder WHERE key = ?', item.key);
      if (row !== undefined) existing.push(reminderFromRow(row, state.minute));
    }
  }
  if (requestedKeys !== null) {
    for (const key of requestedKeys) {
      if (claimed.some(item => item.key === key) || existing.some(item => item.key === key)) continue;
      const row = api.db.get('SELECT * FROM study_followup_reminder WHERE key = ?', key);
      if (row !== undefined) existing.push(reminderFromRow(row, state.minute));
    }
  }
  return { claimed, existing, settings: state.settings };
}

/** Build a reminder view from a ledger row, without recomputing the block list. */
function reminderFromRow(row, minute) {
  const blocks = parseJson(row.blocks_json, []);
  return {
    key: String(row.key),
    blockId: row.block_id ?? blocks[0]?.id ?? null,
    taskId: String(row.task_id),
    title: String(row.task_title),
    date: String(row.date),
    period: String(row.period),
    start: row.start === null ? null : String(row.start),
    end: row.end === null ? null : String(row.end),
    startMinute: row.start === null ? null : timeToMinutes(String(row.start)),
    endMinute: row.end === null ? null : timeToMinutes(String(row.end)),
    minutes: Number(row.minutes),
    blocks,
    overdueMinutes: row.end === null ? 0 : Math.max(0, minute - timeToMinutes(String(row.end))),
    state: String(row.state),
    outcome: row.outcome === null ? null : String(row.outcome),
    snoozeCount: Number(row.snooze_count),
    askedAt: String(row.asked_at),
    snoozeUntil: row.snooze_until === null ? null : String(row.snooze_until),
  };
}

/** Load one ledger row by key or throw `not_found`. */
function reminderRowByKey(db, key) {
  const row = db.get('SELECT * FROM study_followup_reminder WHERE key = ?', key);
  if (row === undefined) throw new StudyError('not_found', `找不到提醒 ${key}`, { key });
  return row;
}

/** Answer one reminder with an explicit student quick reply. */
async function answer(payload, api, callStudy) {
  const key = requireText(payload.key, 'key', { max: 400 });
  const reply = oneOf(payload.reply, 'reply', Object.keys(REPLIES));
  expireEarlierRows(api, api.today(), periodOf(localClock(api.now()).minutes), key);
  const row = reminderRowByKey(api.db, key);
  if (String(row.state) === 'answered') {
    if (row.outcome !== reply) {
      throw new StudyError('conflict', `这条提醒已经答复为「${row.outcome}」，不能改成「${reply}」`, {
        key,
        outcome: row.outcome,
        reply,
      });
    }
    return { answered: true, duplicate: true, reminder: reminderFromRow(row, localClock(api.now()).minutes) };
  }
  if (String(row.state) === 'expired') {
    throw new StudyError('conflict', '这条提醒已经过期，不再记录本次答复', { key, state: 'expired' });
  }
  const plan = REPLIES[reply];
  const note = `提醒快捷答复：${plan.note}`;
  const progress = await requireCall(callStudy, 'tasks', 'recordProgress', {
    taskId: String(row.task_id),
    status: plan.status,
    date: String(row.date),
    note,
    confirmed: true,
  }, { actor: api.actor, requestId: `${api.requestId}:nested` });
  const nowIso = api.now().toISOString();
  api.db.run(
    `UPDATE study_followup_reminder
        SET state = 'answered', outcome = ?, answered_at = ?, updated_at = ?
      WHERE key = ?`,
    reply,
    nowIso,
    nowIso,
    key,
  );
  const fresh = reminderRowByKey(api.db, key);
  api.change({
    entity: 'followup_reminder',
    entityId: key,
    action: reply,
    before: { state: String(row.state) },
    after: { state: 'answered', outcome: reply, progress: progress.record },
    reason: note,
  });
  return { answered: true, duplicate: false, reminder: reminderFromRow(fresh, localClock(api.now()).minutes), progress };
}

/** Postpone one reminder for a few minutes without spending a second ask. */
function snooze(payload, api) {
  const key = requireText(payload.key, 'key', { max: 400 });
  const settings = readSettings(api.db);
  const minutes = optionalInteger(payload.minutes, 'minutes', { min: 1, max: 120 }) ?? settings.snoozeMinutes;
  expireEarlierRows(api, api.today(), periodOf(localClock(api.now()).minutes), key);
  const row = reminderRowByKey(api.db, key);
  if (String(row.state) === 'answered') {
    throw new StudyError('conflict', '这条提醒已经答复，不能再稍后', { key, outcome: row.outcome });
  }
  if (String(row.state) === 'expired') {
    throw new StudyError('conflict', '这条提醒已经过期，不能再稍后', { key, state: 'expired' });
  }
  const now = api.now();
  const until = new Date(now.getTime() + minutes * 60_000).toISOString();
  api.db.run(
    `UPDATE study_followup_reminder
        SET state = 'snoozed', snooze_until = ?, snooze_count = snooze_count + 1, updated_at = ?
      WHERE key = ?`,
    until,
    now.toISOString(),
    key,
  );
  const fresh = reminderRowByKey(api.db, key);
  api.change({
    entity: 'followup_reminder',
    entityId: key,
    action: 'snooze',
    after: { snoozeUntil: until, minutes },
    reason: `稍后 ${minutes} 分钟`,
  });
  return { reminder: reminderFromRow(fresh, localClock(now).minutes) };
}

// ---------------------------------------------------------------------------
// Evening review: read, propose, save
// ---------------------------------------------------------------------------

/**
 * Load the confirmed plan, its progress, and the guard state the review needs.
 * A pending draft or an unconfirmed plan is a terminal "blocked" result: the
 * review never acknowledges a draft on the student's behalf.
 */
async function loadReviewContext(api, payload, callStudy) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const detail = await requireCall(callStudy, 'plans', 'get', planId === null ? { goalId: payload.goalId } : { planId, goalId: payload.goalId });
  if (detail.plan === null) {
    return { status: 'no_plan', date: api.today(), planId: null, detail };
  }
  const targetPlanId = String(detail.plan.id);
  if (detail.applied === null) {
    return { status: 'blocked', reason: 'plan_not_confirmed', date: api.today(), planId: targetPlanId, detail };
  }
  if (detail.draft !== null) {
    return { status: 'blocked', reason: 'draft_pending', date: api.today(), planId: targetPlanId, detail };
  }
  const progress = await requireCall(callStudy, 'plans', 'progress', { planId: targetPlanId });
  const planTaskIds = new Set(detail.applied.data.items.map(item=>item.taskId));
  const externalBlocks=[];
  for(let offset=1;offset<=REVIEW_HORIZON_DAYS;offset++) {
    const day=await requireCall(callStudy,'tasks','day',{date:addDays(api.today(),offset),goalId:detail.plan.goalId});
    externalBlocks.push(...day.blocks.filter(block=>!planTaskIds.has(block.taskId)));
  }
  return {
    status: 'ready',
    date: api.today(),
    planId: targetPlanId,
    detail,
    data: detail.applied.data,
    externalBlocks,
    progress,
  };
}

/**
 * Build the reschedule proposal. Moves only remaining flexible work into the
 * next days within their declared capacity; everything that does not fit stays
 * unscheduled with a reason. Unrecorded and pending-confirmation items are
 * reported but never moved.
 */
function buildProposal(context) {
  const { data, detail, progress, date } = context;
  const byId = new Map(progress.items.map(item => [item.id, item.progress]));
  const remaining = [], kept = [], movable = new Set();
  for (const item of data.items) {
    const current = byId.get(item.id) ?? { status:'unrecorded', recorded:false, confirmed:false };
    if (current.confirmed && ['done','cancelled'].includes(current.status)) continue;
    if (item.date !== null && item.date > date && !(item.unscheduledMinutes > 0)) continue;
    if (!item.flexible) { kept.push(keptEntry(item,'fixed')); continue; }
    const minutes = remainingMinutesOf(item, current);
    if (minutes <= 0) continue;
    const tentative = !current.recorded || !current.confirmed;
    remaining.push({ item, current, minutes, tentative, overdueDays:item.date ? Math.max(0,dateToDayNumber(date)-dateToDayNumber(item.date)) : 0 });
    movable.add(item.id);
  }
  remaining.sort((a,b) => (a.item.date ?? '').localeCompare(b.item.date ?? '') || a.item.id.localeCompare(b.item.id));
  const horizonStart = addDays(date,1);
  const horizonEnd = [addDays(date,REVIEW_HORIZON_DAYS),detail.capacity?.goal?.deadline].filter(Boolean).sort()[0];
  const dayState = new Map();
  for (let day=horizonStart; day<=horizonEnd; day=addDays(day,1)) {
    const declared=data.availability.find(a=>a.date===day);
    const available=declared?.minutes ?? detail.capacity?.goal?.dailyMinutes ?? null;
    const future=data.items.filter(i=>!movable.has(i.id)).flatMap(i=>i.blocks ?? (i.date ? [{date:i.date,start:i.start,end:i.end,minutes:i.estimateMinutes}] : [])).filter(b=>b.date===day);
    future.push(...(context.externalBlocks??[]).filter(b=>b.date===day));
    const intervals=future.filter(b=>b.start&&b.end).map(b=>[timeToMinutes(b.start),timeToMinutes(b.end)]);
    const used=future.reduce((n,b)=>n+(b.start&&b.end ? timeToMinutes(b.end)-timeToMinutes(b.start) : b.minutes),0);
    dayState.set(day,{date:day,available,used,initial:used,intervals,source:declared?'declared':available===null?'unknown':'goal_daily_minutes'});
  }
  const moves=[],unscheduled=[];
  for (const entry of remaining) {
    let left=entry.minutes;
    for (const day of dayState.values()) {
      let capacity=day.available===null?0:Math.max(0,day.available-day.used);
      if (!capacity || !left) continue;
      // Fill real free intervals, splitting across gaps and days. Prefer the original start.
      const preferred=timeToMinutes(entry.item.start ?? '09:00') ?? 540;
      const starts=[preferred,0];
      for (const begin of starts) {
        let cursor=begin;
        while(left && capacity && cursor<1439) {
          const occupied=day.intervals.find(([a,b])=>a<=cursor&&b>cursor);
          if(occupied) {cursor=occupied[1];continue;}
          const next=day.intervals.filter(([a])=>a>cursor).reduce((n,[a])=>Math.min(n,a),1439);
          const minutes=Math.min(left,capacity,next-cursor);
          if(!minutes) break;
          moves.push({itemId:entry.item.id,taskId:entry.item.taskId,title:entry.item.title,fromDate:entry.item.date,toDate:day.date,date:day.date,start:minutesToTime(cursor),end:minutesToTime(cursor+minutes),minutes,timeKept:true,overdueDays:entry.overdueDays,
            tentative:entry.tentative,assumption:entry.tentative?'Unrecorded or pending confirmation; tentative remaining work':null,sourceProgressRevision:entry.current.id ?? entry.current.recordId ?? 0});
          day.intervals.push([cursor,cursor+minutes]); day.used+=minutes; left-=minutes;capacity-=minutes;cursor+=minutes;
        }
        if(!left||!capacity) break;
      }
    }
    if(left) unscheduled.push({itemId:entry.item.id,title:entry.item.title,fromDate:entry.item.date,minutes:left,reason:dayState.size===0?'no_target_days':everyDayUnknown(dayState)?'unknown_availability':'capacity',overdueDays:entry.overdueDays});
  }
  const summary={remainingItems:remaining.length,remainingMinutes:remaining.reduce((n,e)=>n+e.minutes,0),movedItems:new Set(moves.map(m=>m.itemId)).size,movedMinutes:moves.reduce((n,m)=>n+m.minutes,0),unscheduledItems:unscheduled.length,unscheduledMinutes:unscheduled.reduce((n,e)=>n+e.minutes,0),keptItems:kept.length,horizonStart,horizonEnd};
  return {status:remaining.length?'ready':'nothing_to_do',date,planId:context.planId,baseRevision:detail.plan.revision,appliedRevision:detail.applied.number,
    remaining:remaining.map(e=>({itemId:e.item.id,title:e.item.title,date:e.item.date,status:e.current.status,minutes:e.minutes,overdueDays:e.overdueDays})),
    proposal:{moves,unscheduled,kept,days:[...dayState.values()].map(d=>({date:d.date,availableMinutes:d.available,usedMinutes:d.initial,addedMinutes:d.used-d.initial,afterMinutes:d.available===null?null:d.available-d.used,source:d.source})),
      explanations:unscheduled.length?[`Capacity is insufficient or unknown; ${summary.unscheduledMinutes} minutes remain unscheduled for the next review.`]:[]},summary};
}

export function remainingMinutesOf(item, progress) {
  if (progress.confirmed && ['done','cancelled'].includes(progress.status)) return 0;
  const original = item.estimateMinutes;
  if (progress.confirmed === false) return original;
  if (progress.quantityTotal > 0 && progress.quantityDone !== null) {
    const left = progress.quantityTotal-progress.quantityDone;
    return left<=0 ? 0 : Math.max(1,Math.ceil(original*left/progress.quantityTotal));
  }
  return original;
}

/** Minutes from midnight of an item's start, with an all-day item sorting last. */
function startMinuteOf(item) {
  return item.start === null ? 1440 : (timeToMinutes(item.start) ?? 1440);
}

/** A kept item plus its machine-readable reason. */
function keptEntry(item, reason, { overdueDays = 0 } = {}) {
  return {
    itemId: item.id,
    title: item.title,
    date: item.date,
    reason,
    explanation: KEPT_REASONS[reason],
    overdueDays,
  };
}

/** True when every horizon day has unknown availability. */
function everyDayUnknown(dayState) {
  if (dayState.size === 0) return false;
  for (const state of dayState.values()) if (state.available !== null) return false;
  return true;
}

/**
 * Try one item on each horizon day: keep its original time when the slot is
 * free and the day's minute capacity fits, otherwise fall back to a day-level
 * arrangement. Returns the placement or null when no day has room.
 */
function placeItem(entry, dayState) {
  for (const day of dayState.values()) {
    if (day.available === null) continue;
    if (day.used + entry.minutes > day.available) continue;
    if (entry.item.start !== null && entry.item.end !== null) {
      const start = timeToMinutes(entry.item.start);
      const end = start === null ? null : start + entry.minutes;
      if (start !== null && end !== null && end <= 1440 && !overlaps(day.intervals, start, end)) {
        return { date: day.date, start: minutesToTime(start), end: minutesToTime(end) };
      }
    }
    return { date: day.date, start: null, end: null };
  }
  return null;
}

function overlaps(intervals, start, end) {
  return intervals.some(([otherStart, otherEnd]) => start < otherEnd && end > otherStart);
}

/** Build the full item list with the review's moves and unscheduled leftovers applied. */
function applyProposal(data, proposal) {
  return data.items.map(item => {
    const moves=proposal.moves.filter(m=>m.itemId===item.id);
    const dropped=proposal.unscheduled.find(m=>m.itemId===item.id);
    if (!moves.length && !dropped) return item;
    const first=moves[0];
    return {...item,date:first?.date??null,start:first?.start??null,end:first?.end??null,
      blocks:moves.map(m=>({date:m.date,start:m.start,end:m.end,tentative:m.tentative,assumption:m.assumption,sourceProgressRevision:m.sourceProgressRevision})),unscheduledMinutes:dropped?.minutes??0};
  });
}

/** Insert one review attempt and append its change-log entry. */
function insertReview(api, record) {
  const id = `review_${randomUUID()}`;
  const nowIso = api.now().toISOString();
  api.db.run(
    `INSERT INTO study_followup_review
       (id, goal_id, date, status, plan_id, base_revision, plan_revision, moved_json, unscheduled_json, kept_json,
        days_json, summary_json, error_code, error_message, actor, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    record.planId ? api.db.get('SELECT goal_id FROM study_plan WHERE id = ?', record.planId)?.goal_id ?? 'unassigned' : resolveActiveGoal(api.db) ?? 'unassigned',
    record.date,
    record.status,
    record.planId ?? null,
    record.baseRevision ?? null,
    record.planRevision ?? null,
    JSON.stringify(record.moved ?? []),
    JSON.stringify(record.unscheduled ?? []),
    JSON.stringify(record.kept ?? []),
    JSON.stringify(record.days ?? []),
    JSON.stringify(record.summary ?? {}),
    record.errorCode ?? null,
    record.errorMessage ?? null,
    api.actor,
    nowIso,
    nowIso,
  );
  api.change({
    entity: 'followup_review',
    entityId: id,
    action: record.status,
    after: {
      planId: record.planId ?? null,
      baseRevision: record.baseRevision ?? null,
      planRevision: record.planRevision ?? null,
      summary: record.summary ?? null,
      errorCode: record.errorCode ?? null,
    },
  });
  return reviewView(api.db.get('SELECT * FROM study_followup_review WHERE id = ?', id));
}

/** Preview the evening review without changing anything. */
async function reviewPreview(payload, api, callStudy) {
  const context = await loadReviewContext(api, payload, callStudy);
  const date = optionalDate(payload.date, 'date') ?? context.date;
  if (context.status !== 'ready') {
    return {
      status: context.status,
      reason: context.reason ?? null,
      date,
      planId: context.planId,
      baseRevision: context.detail.plan?.revision ?? null,
      proposal: null,
      summary: null,
    };
  }
  const proposal = buildProposal({ ...context, date });
  return proposal;
}

/**
 * Run the evening review. Only a successful `plans.revise` is a committed
 * review; a capacity or dependency failure keeps the attempt as
 * `needs_adjustment` and never reports success.
 */
async function review(payload, api, callStudy) {
  const context = await loadReviewContext(api, payload, callStudy);
  const date = optionalDate(payload.date, 'date') ?? context.date;
  const baseRevision = optionalInteger(payload.baseRevision, 'baseRevision', { min: 0 });

  if (context.status !== 'ready') {
    if (context.status === 'blocked') {
      const attempt = insertReview(api, {
        date,
        status: 'blocked',
        planId: context.planId,
        baseRevision,
        planRevision: context.detail.plan?.revision ?? null,
        errorCode: context.reason,
        errorMessage: context.reason === 'draft_pending' ? '计划还有未确认的草案，复盘没有保存' : '计划尚未确认，复盘没有保存',
      });
      return {
        committed: false,
        status: 'blocked',
        reason: context.reason,
        date,
        planId: context.planId,
        baseRevision,
        preview: null,
        summary: null,
        reviewId: attempt.id,
      };
    }
    return {
      committed: false,
      status: 'no_plan',
      reason: 'no_plan',
      date,
      planId: null,
      baseRevision,
      preview: null,
      summary: null,
      reviewId: null,
    };
  }

  const currentRevision = Number(context.detail.plan.revision);
  if (baseRevision !== null && baseRevision !== currentRevision) {
    const attempt = insertReview(api, {
      date,
      status: 'needs_adjustment',
      planId: context.planId,
      baseRevision,
      planRevision: currentRevision,
      errorCode: 'conflict',
      errorMessage: `计划已更新到修订 ${currentRevision}，本次复盘基于修订 ${baseRevision}，已保留待调整`,
    });
    return {
      committed: false,
      status: 'needs_adjustment',
      reason: 'plan_changed',
      code: 'conflict',
      message: `计划已更新到修订 ${currentRevision}，本次复盘基于修订 ${baseRevision}，已保留待调整`,
      date,
      planId: context.planId,
      baseRevision,
      planRevision: currentRevision,
      preview: null,
      summary: null,
      reviewId: attempt.id,
    };
  }

  const proposal = buildProposal({ ...context, date });
  if (proposal.status === 'nothing_to_do') {
    const attempt = insertReview(api, {
      date,
      status: 'nothing_to_do',
      planId: context.planId,
      baseRevision: currentRevision,
      planRevision: currentRevision,
      kept: proposal.proposal.kept,
      days: proposal.proposal.days,
      summary: proposal.summary,
    });
    return {
      committed: false,
      status: 'nothing_to_do',
      reason: 'nothing_to_do',
      date,
      planId: context.planId,
      baseRevision: currentRevision,
      planRevision: currentRevision,
      preview: proposal,
      summary: proposal.summary,
      reviewId: attempt.id,
    };
  }

  const items = applyProposal(context.data, proposal.proposal);
  const reason = optionalText(payload.reason, 'reason', { max: 500 }) ?? '晚间复盘：延续未完成的弹性任务';
  const revised = await callStudy('plans', 'revise', {
    planId: context.planId,
    baseRevision: currentRevision,
    expectedDraftRevision: 0,
    reason,
    title: context.data.title,
    goalId: context.data.goalId,
    stageGoals: context.data.stageGoals,
    weekGoals: context.data.weekGoals,
    availability: context.data.availability,
    constraints: context.data.constraints,
    assumptions: context.data.assumptions,
    items,
    trial: context.data.trial === true,
    reviewAt: context.data.reviewAt,
  }, { actor: api.actor, requestId: `${api.requestId}:nested` });

  if (revised?.ok !== true) {
    const code = revised?.code ?? 'unavailable';
    const message = revised?.message ?? '计划修订没有保存';
    const errorReason = revised?.details?.reason ?? 'plan_revise_failed';
    const attempt = insertReview(api, {
      date,
      status: 'needs_adjustment',
      planId: context.planId,
      baseRevision: currentRevision,
      planRevision: currentRevision,
      moved: proposal.proposal.moves,
      unscheduled: proposal.proposal.unscheduled,
      kept: proposal.proposal.kept,
      days: proposal.proposal.days,
      summary: proposal.summary,
      errorCode: code,
      errorMessage: errorReason === 'dependency_order'
        ? `任务顺序不允许这次调整：${message}`
        : message,
    });
    return {
      committed: false,
      status: 'needs_adjustment',
      reason: errorReason,
      code,
      message: revised?.details?.reason === 'dependency_order'
        ? `任务顺序不允许这次调整：${message}`
        : message,
      date,
      planId: context.planId,
      baseRevision: currentRevision,
      planRevision: currentRevision,
      preview: proposal,
      summary: proposal.summary,
      reviewId: attempt.id,
    };
  }

  const planRevision = Number(revised.value.plan.revision);
  const attempt = insertReview(api, {
    date,
    status: 'committed',
    planId: context.planId,
    baseRevision: currentRevision,
    planRevision,
    moved: proposal.proposal.moves,
    unscheduled: proposal.proposal.unscheduled,
    kept: proposal.proposal.kept,
    days: proposal.proposal.days,
    summary: proposal.summary,
  });
  return {
    committed: true,
    status: 'committed',
    reason: null,
    date,
    planId: context.planId,
    baseRevision: currentRevision,
    planRevision,
    preview: proposal,
    summary: proposal.summary,
    reviewId: attempt.id,
  };
}

/** Read the latest review attempt for one date. */
function reviewStatus(payload, api) {
  const date = optionalDate(payload.date, 'date') ?? api.today();
  return { review: reviewView(latestReviewRow(api.db, date, payload.goalId)) };
}

async function recovery(_payload, api, callStudy) {
  const progress = await requireCall(callStudy, 'tasks', 'progress', {});
  return { message:'Background checks resumed; they stop when the app closes. Evening changes need confirmation.',
    scheduling:{status:'degraded',reason:'DSH Schedule delivers prompts to Sessions, without deterministic service callbacks. Host checks every 15 seconds while the app is running.'},
    lastReview:reviewView(api.db.get('SELECT * FROM study_followup_review WHERE goal_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1',resolveActiveGoal(api.db)??'unassigned')),
    pending:api.db.all("SELECT key,task_title,state FROM study_followup_reminder WHERE date=? AND goal_id=? AND state IN ('shown','snoozed')",api.today(),resolveActiveGoal(api.db)??'unassigned'),
    pendingConfirmation:(progress.items??[]).filter(item=>item.progress?.confirmed===false),
    reviewDecision:'manual_confirmation' };
}
