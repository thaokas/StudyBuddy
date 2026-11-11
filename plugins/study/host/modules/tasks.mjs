import { resolveActiveGoal } from '../facts.mjs';
import { toolRequestId } from '../operation.mjs';
/**
 * Tasks module: the stable study task, its time blocks, and the today/week
 * views behind the workbench page.
 *
 * A task describes *what* to do (subject, material location, completion
 * criteria, estimated minutes, prerequisites). A time block describes *when*
 * to do it and may be fixed (a course, meal, or rest) or flexible. The two stay
 * separate: one task can be executed in many blocks, and a block keeps its own
 * id when its date or time changes. Task ids are generated once and never
 * derived from a title or a position, so a display change cannot rename the
 * task identity.
 *
 * Fixed blocks are scheduled but are never study work: the summary reports
 * `study` and `fixed` separately, so course time cannot inflate the study
 * totals. Deleting a task is a soft delete; blocks that already referenced it
 * keep their schedule and say the task was deleted instead of silently losing
 * the association. A task that is still a prerequisite of an active task
 * cannot be deleted until that dependency is removed.
 *
 * A dragged block moves as one unit: `moveBlock` changes only that block's
 * date and times, never its id, its task link, or another block. A move that
 * lands on an existing block of the same goal is a `conflict` with the
 * overlapping blocks listed, and only the explicit `allowOverlap: true` keeps
 * it, so an overlap is never saved silently. Each goal owns an independent
 * schedule (only the active goal is shown), so a block of another goal never
 * conflicts with this one.
 *
 * Task progress is append-only: every record is a full statement of the
 * state at that moment, and the latest record is the current state. The five
 * states are not_started, in_progress, partial, done, and cancelled. A record
 * with `confirmed: false` is "pending confirmation" — its own marker, neither
 * complete nor incomplete. No record means "unrecorded", never "not studied".
 * Cancelled tasks stay out of the completion rate, and an identical repeat
 * (same state, quantities, note, and confirmation) is not appended twice.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { StudyError } from '../registry.mjs';

/** Module id; matches the `tasks` service namespace. */
export const id = 'tasks';

/** Tasks and blocks depend on no other module. */
export const deps = [];

/**
 * Schema version recorded in `module_schema`. The progress table is an
 * additive table: an older build that opens the same file keeps working and
 * simply never reads it, while a newer build creates it idempotently (see
 * `ensureProgressSchema`). v1 has no migration runner, so bumping the version
 * would block every database created before T06; bump it only for a change
 * that is not backward compatible.
 */
export const schemaVersion = 1;

/**
 * Additive DDL for the T06 progress table. It is declared in `schema` for new
 * databases and applied on open for an existing T05 database, which was
 * stamped before this table existed and therefore skips the module's schema
 * statements. Every statement is idempotent.
 */
const PROGRESS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS study_task_progress (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id        TEXT NOT NULL,
    date           TEXT NOT NULL,
    status         TEXT NOT NULL,
    quantity_done  INTEGER,
    quantity_total INTEGER,
    note           TEXT,
    confirmed      INTEGER NOT NULL DEFAULT 1,
    actor          TEXT NOT NULL,
    at             TEXT NOT NULL,
    CHECK (status IN ('not_started', 'in_progress', 'partial', 'done', 'cancelled')),
    CHECK (confirmed IN (0, 1)),
    CHECK (quantity_done IS NULL OR quantity_done >= 0),
    CHECK (quantity_total IS NULL OR quantity_total >= 0),
    CHECK (quantity_done IS NULL OR quantity_total IS NULL OR quantity_done <= quantity_total)
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_task_progress_task ON study_task_progress (task_id, id)',
  `CREATE TRIGGER IF NOT EXISTS study_task_progress_no_update
   BEFORE UPDATE ON study_task_progress BEGIN
     SELECT RAISE(ABORT, 'study_task_progress is append-only');
   END`,
  `CREATE TRIGGER IF NOT EXISTS study_task_progress_no_delete
   BEFORE DELETE ON study_task_progress BEGIN
     SELECT RAISE(ABORT, 'study_task_progress is append-only');
   END`,
];

/** Tables owned by this module. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS study_task (
    id                  TEXT PRIMARY KEY,
    title               TEXT NOT NULL,
    subject             TEXT,
    material_ref        TEXT,
    completion_criteria TEXT,
    estimated_minutes   INTEGER,
    prerequisites_json  TEXT NOT NULL DEFAULT '[]',
    project_id          TEXT,
    project_title       TEXT,
    deleted_at          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_task_active ON study_task (deleted_at, created_at)',
  `CREATE TABLE IF NOT EXISTS study_time_block (
    id           TEXT PRIMARY KEY,
    date         TEXT NOT NULL,
    start_minute INTEGER NOT NULL,
    end_minute   INTEGER NOT NULL,
    fixed        INTEGER NOT NULL DEFAULT 0,
    task_id      TEXT,
    title        TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    CHECK (start_minute >= 0 AND start_minute < 1440),
    CHECK (end_minute > start_minute AND end_minute <= 1440)
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_time_block_date ON study_time_block (date, start_minute)',
  ...PROGRESS_SCHEMA,
];

const WRITE_METHODS = [
  'createTask',
  'updateTask',
  'deleteTask',
  'createBlock',
  'updateBlock',
  'deleteBlock',
  'moveBlock',
  'recordProgress',
];

const PROGRESS_STATUSES = ['not_started', 'in_progress', 'partial', 'done', 'cancelled'];
const MAX_PREREQUISITES = 50;
const MAX_TEXT = 200;
const MAX_QUANTITY = 1_000_000;
const DAY_MS = 86_400_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Create the additive progress schema on a database opened before T06. A fresh
 * database already has it because its module schema ran; the check keeps this
 * a no-op on every later open.
 * @param {{ get: Function, exec: Function } | undefined} database - Study database handle.
 */
function ensureProgressSchema(database) {
  if (database === undefined || database === null) return;
  const existing = database.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'study_task_progress'",
  );
  if (existing !== undefined) return;
  for (const statement of PROGRESS_SCHEMA) database.exec(statement);
}

/**
 * Additive columns that carry a plan's project grouping onto the execution
 * task. A database created before this build is stamped with the module schema
 * already, so the module's DDL does not run again; adding the columns here
 * keeps an existing file usable without a version bump.
 * @param {{ get: Function, all: Function, exec: Function } | undefined} database - Study database handle.
 */
function ensureTaskProjectColumns(database) {
  if (database === undefined || database === null) return;
  const known = new Set(database.all('PRAGMA table_info(study_task)').map(column => String(column.name)));
  for (const [name, definition] of [['project_id', 'TEXT'], ['project_title', 'TEXT']]) {
    if (!known.has(name)) database.exec(`ALTER TABLE study_task ADD COLUMN ${name} ${definition}`);
  }
}

/**
 * Register the `tasks` service methods.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study`.
 * @param {{ database?: { get: Function, exec: Function } }} [kernel] - Kernel handle.
 */
export function apply(ctx, kernel) {
  ensureProgressSchema(kernel?.database);
  ensureTaskProjectColumns(kernel?.database);
  ctx.effect(() => ctx.study.register('tasks', {
    methods: {
      createTask,
      updateTask,
      deleteTask,
      getTask,
      listTasks,
      createBlock,
      updateBlock,
      deleteBlock,
      moveBlock,
      recordProgress,
      progress,
      day,
      week,
    },
    writes: WRITE_METHODS,
  }), 'study: tasks namespace');
  const { defineTool } = createRequire(import.meta.url)('../../../../source/deepseek-harness/packages/core/tools/lib/index.js');
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_tasks',
    description: '工作台任务与执行块的唯一事实。day/week 返回的任务带 scheduledDate（计划分配的日期）和 projectTitle（计划项目）；具体哪天做由计划决定，当天几点做由时间块决定。'
      + 'day/week/list/create/update/createBlock/moveBlock/recordProgress 与界面调用同一服务；修改时间必须 moveBlock。',
    parameters: {
      action: { type: 'string', required: true, enum: ['day', 'week', 'list', 'create', 'update', 'createBlock', 'moveBlock', 'recordProgress'] },
      payload: { type: 'json', description: '现有 tasks 服务字段：day/week {date?}; create {title,estimatedMinutes?}; update {id,...}; createBlock {date,start,end,taskId}; moveBlock {id,date,start,end}; recordProgress {taskId,status,quantityDone?,quantityTotal?,confirmed?}。' },
      requestId: { type: 'string', description: '写操作幂等键' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const method = ({ list: 'listTasks', create: 'createTask', update: 'updateTask' })[args.action] ?? args.action;
      const result = await ctx.study.call('tasks', method, args.payload ?? {}, { actor: 'agent', requestId: WRITE_METHODS.includes(method) ? toolRequestId(args, exec) : undefined });
      if (!result.ok) throw new Error(result.message);
      return result.value;
    },
  })), 'study: study_tasks tool');
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

/** Build an `invalid` service failure with a machine-readable field name. */
function invalid(message, details = {}) {
  return new StudyError('invalid', message, details);
}

function hasOwn(object, key) {
  return Object.hasOwn(object, key);
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

function optionalInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value)) throw invalid(`${field} 必须是整数`, { field });
  if (value < min || value > max) throw invalid(`${field} 必须在 ${min} 到 ${max} 之间`, { field, min, max });
  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw invalid(`${field} 必须是 true 或 false`, { field });
  return value;
}

/** Require one value from a fixed enumeration and report the allowed set. */
function requireOneOf(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`${field} 必须是 ${allowed.join(' / ')} 之一`, { field, allowed: [...allowed] });
  }
  return value;
}

function optionalDate(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(`${field} 必须是 YYYY-MM-DD`, { field });
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) throw invalid(`${field} 必须是 YYYY-MM-DD`, { field });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw invalid(`${field} 不是有效日期：${text}`, { field });
  }
  return text;
}

/** Read one JSON array column, treating a corrupt value as an unavailable service. */
function parseJsonArray(value, label) {
  if (typeof value !== 'string' || value.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new StudyError('unavailable', `${label}数据损坏，无法读取`, { reason: error.message });
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new StudyError('unavailable', `${label}数据损坏，无法读取`, { reason: 'not_a_string_array' });
  }
  return parsed;
}

/**
 * Validate and normalize a prerequisite id list.
 * @param {unknown} value - Caller payload (`null`/`undefined` mean no prerequisites).
 * @param {string | null} selfId - Task being updated, rejected as its own prerequisite.
 * @returns {string[]} Unique ids in caller order.
 */
function normalizePrerequisiteIds(value, selfId) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid('prerequisites 必须是任务 id 数组', { field: 'prerequisites' });
  if (value.length > MAX_PREREQUISITES) {
    throw invalid(`前置任务最多 ${MAX_PREREQUISITES} 个`, { field: 'prerequisites', max: MAX_PREREQUISITES });
  }
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    const prerequisiteId = requireText(raw, 'prerequisites[]', { max: 64 });
    if (seen.has(prerequisiteId)) {
      throw invalid(`前置任务重复：${prerequisiteId}`, { field: 'prerequisites', taskId: prerequisiteId });
    }
    if (prerequisiteId === selfId) {
      throw invalid('任务不能以自己为前置任务', { field: 'prerequisites', reason: 'dependency_cycle', taskId: prerequisiteId });
    }
    seen.add(prerequisiteId);
    ids.push(prerequisiteId);
  }
  return ids;
}

/**
 * Assert that every prerequisite exists, is not deleted, and that adding these
 * edges cannot create a cycle back to the edited task.
 * @param {object} db - Study database handle.
 * @param {string[]} ids - Normalized prerequisite ids.
 * @param {string | null} selfId - Task being updated, or null on create.
 */
function assertPrerequisites(db, ids, selfId) {
  for (const prerequisiteId of ids) {
    const row = db.get('SELECT id, title, deleted_at FROM study_task WHERE id = ?', prerequisiteId);
    if (row === undefined) {
      throw new StudyError('not_found', `找不到前置任务 ${prerequisiteId}`, { field: 'prerequisites', taskId: prerequisiteId });
    }
    if (row.deleted_at !== null) {
      throw new StudyError('not_found', `前置任务 ${prerequisiteId} 已删除`, {
        field: 'prerequisites',
        taskId: prerequisiteId,
        deletedAt: String(row.deleted_at),
      });
    }
  }
  const visited = new Set();
  const stack = [...ids];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === selfId) {
      throw invalid('前置任务关系会形成循环', { field: 'prerequisites', reason: 'dependency_cycle' });
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const row = db.get('SELECT prerequisites_json FROM study_task WHERE id = ?', current);
    if (row === undefined) continue;
    for (const next of parseJsonArray(row.prerequisites_json, '任务前置')) stack.push(next);
  }
}

/**
 * Read one active task row or throw `not_found`.
 * @param {object} db - Study database handle.
 * @param {string} taskId - Task id.
 * @returns {Record<string, unknown>} Stored row.
 */
function activeTaskRow(db, taskId) {
  const row = db.get('SELECT * FROM study_task WHERE id = ?', taskId);
  if (row === undefined) throw new StudyError('not_found', `找不到任务 ${taskId}`, { taskId });
  if (row.deleted_at !== null) {
    throw new StudyError('not_found', `任务 ${taskId} 已删除`, { taskId, deletedAt: String(row.deleted_at) });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Task persistence and views
// ---------------------------------------------------------------------------

/** Public view of one task row, including resolved prerequisite titles. */
function taskView(db, row) {
  const prerequisiteIds = parseJsonArray(row.prerequisites_json, '任务前置');
  return {
    id: String(row.id),
    goalId: row.goal_id ?? null,
    title: String(row.title),
    subject: row.subject === null ? null : String(row.subject),
    materialRef: row.material_ref === null ? null : String(row.material_ref),
    completionCriteria: row.completion_criteria === null ? null : String(row.completion_criteria),
    estimatedMinutes: row.estimated_minutes === null ? null : Number(row.estimated_minutes),
    planItem: db.get('SELECT plan_id AS planId, item_id AS itemId FROM study_plan_task WHERE task_id = ?', row.id) ?? null,
    scheduledDate: row.scheduled_date === null || row.scheduled_date === undefined ? null : String(row.scheduled_date),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    projectTitle: row.project_title === null || row.project_title === undefined ? null : String(row.project_title),
    materialId: row.material_id ?? null,
    prerequisiteIds,
    prerequisites: prerequisiteIds.map(prerequisiteId => {
      const prerequisite = db.get('SELECT id, title, deleted_at FROM study_task WHERE id = ?', prerequisiteId);
      if (prerequisite === undefined) {
        return { id: prerequisiteId, title: null, deleted: true };
      }
      return {
        id: String(prerequisite.id),
        title: String(prerequisite.title),
        deleted: prerequisite.deleted_at !== null,
      };
    }),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** All active tasks in creation order. */
function activeTasks(db, goalId) {
  return db
    .all('SELECT * FROM study_task WHERE deleted_at IS NULL AND goal_id IS ? ORDER BY created_at ASC, rowid ASC', (resolveActiveGoal(db, goalId) ?? 'unassigned'))
    .map(row => taskView(db, row));
}

/** Create one task with a generated, permanent id. */
function createTask(payload, api) {
  const title = requireText(payload.title, 'title');
  const subject = optionalText(payload.subject, 'subject', { max: 80 });
  const materialRef = optionalText(payload.materialRef, 'materialRef', { max: 300 });
  const completionCriteria = optionalText(payload.completionCriteria, 'completionCriteria', { max: 500 });
  const estimatedMinutes = optionalInteger(payload.estimatedMinutes, 'estimatedMinutes', { min: 0, max: 100_000 });
  const prerequisiteIds = normalizePrerequisiteIds(payload.prerequisites, null);
  assertPrerequisites(api.db, prerequisiteIds, null);

  const taskId = `task_${randomUUID()}`;
  const now = api.now().toISOString();
  api.db.run(
    `INSERT INTO study_task
       (id, title, subject, material_ref, completion_criteria, estimated_minutes, prerequisites_json, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    taskId, title, subject, materialRef, completionCriteria, estimatedMinutes, JSON.stringify(prerequisiteIds), now, now,
  );
  api.db.run('UPDATE study_task SET goal_id = ? WHERE id = ?', resolveActiveGoal(api.db, payload.goalId) ?? 'unassigned', taskId);
  const task = taskView(api.db, api.db.get('SELECT * FROM study_task WHERE id = ?', taskId));
  api.change({ entity: 'task', entityId: taskId, action: 'create', after: task });
  return { task };
}

/**
 * Update selected fields of one task. Omitted fields keep their stored value;
 * `null` clears an optional field. The task id and creation time never change.
 */
function updateTask(payload, api) {
  const taskId = requireText(payload.id, 'id', { max: 64 });
  const row = activeTaskRow(api.db, taskId);
  const before = taskView(api.db, row);

  const title = hasOwn(payload, 'title') ? requireText(payload.title, 'title') : before.title;
  const subject = hasOwn(payload, 'subject') ? optionalText(payload.subject, 'subject', { max: 80 }) : before.subject;
  const materialRef = hasOwn(payload, 'materialRef')
    ? optionalText(payload.materialRef, 'materialRef', { max: 300 })
    : before.materialRef;
  const completionCriteria = hasOwn(payload, 'completionCriteria')
    ? optionalText(payload.completionCriteria, 'completionCriteria', { max: 500 })
    : before.completionCriteria;
  const estimatedMinutes = hasOwn(payload, 'estimatedMinutes')
    ? optionalInteger(payload.estimatedMinutes, 'estimatedMinutes', { min: 0, max: 100_000 })
    : before.estimatedMinutes;
  const prerequisiteIds = hasOwn(payload, 'prerequisites')
    ? normalizePrerequisiteIds(payload.prerequisites, taskId)
    : before.prerequisiteIds;
  assertPrerequisites(api.db, prerequisiteIds, taskId);

  const now = api.now().toISOString();
  api.db.run(
    `UPDATE study_task
        SET title = ?, subject = ?, material_ref = ?, completion_criteria = ?, estimated_minutes = ?,
            prerequisites_json = ?, updated_at = ?
      WHERE id = ?`,
    title, subject, materialRef, completionCriteria, estimatedMinutes, JSON.stringify(prerequisiteIds), now, taskId,
  );
  const task = taskView(api.db, api.db.get('SELECT * FROM study_task WHERE id = ?', taskId));
  api.change({ entity: 'task', entityId: taskId, action: 'update', before, after: task });
  return { task };
}

/**
 * Soft-delete one task. A task that is still a prerequisite of an active task
 * is refused with the dependents listed, because deleting it would leave a
 * dangling dependency. Existing time blocks stay and show the deletion.
 */
function deleteTask(payload, api) {
  const taskId = requireText(payload.id, 'id', { max: 64 });
  const row = activeTaskRow(api.db, taskId);
  const before = taskView(api.db, row);

  const dependents = api.db
    .all('SELECT id, title, prerequisites_json FROM study_task WHERE deleted_at IS NULL AND id <> ? ORDER BY created_at ASC, rowid ASC', taskId)
    .filter(candidate => parseJsonArray(candidate.prerequisites_json, '任务前置').includes(taskId))
    .map(candidate => ({ id: String(candidate.id), title: String(candidate.title) }));
  if (dependents.length > 0) {
    const names = dependents.slice(0, 5).map(item => `「${item.title}」`).join('、');
    throw new StudyError('conflict', `还有 ${dependents.length} 个任务以它为前置：${names}。请先移除这些前置关系。`, {
      taskId,
      dependents,
    });
  }

  const now = api.now().toISOString();
  api.db.run('UPDATE study_task SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, taskId);
  const task = taskView(api.db, api.db.get('SELECT * FROM study_task WHERE id = ?', taskId));
  api.change({ entity: 'task', entityId: taskId, action: 'delete', before, after: task });
  return { task };
}

/** Read one task, including a deleted one so history stays inspectable. */
function getTask(payload, api) {
  const taskId = requireText(payload.id, 'id', { max: 64 });
  const row = api.db.get('SELECT * FROM study_task WHERE id = ?', taskId);
  if (row === undefined) throw new StudyError('not_found', `找不到任务 ${taskId}`, { taskId });
  return { task: taskView(api.db, row) };
}

/** List tasks in creation order; deleted rows are hidden unless requested. */
function listTasks(payload, api) {
  const includeDeleted = optionalBoolean(payload.includeDeleted, 'includeDeleted') ?? false;
  const rows = includeDeleted
    ? api.db.all('SELECT * FROM study_task ORDER BY created_at ASC, rowid ASC')
    : api.db.all('SELECT * FROM study_task WHERE deleted_at IS NULL AND goal_id IS ? ORDER BY created_at ASC, rowid ASC', resolveActiveGoal(api.db, payload.goalId) ?? 'unassigned');
  return { tasks: rows.map(row => taskView(api.db, row)) };
}

// ---------------------------------------------------------------------------
// Local date and clock arithmetic
// ---------------------------------------------------------------------------

/** Days since 1970-01-01 for a validated `YYYY-MM-DD` date. */
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

/** ISO weekday: Monday = 1 … Sunday = 7. */
function weekdayOf(text) {
  const jsDay = new Date(dateToDayNumber(text) * DAY_MS).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/** Move a date by whole days without touching the local time zone. */
function addDays(text, delta) {
  return dayNumberToDate(dateToDayNumber(text) + delta);
}

/** Monday of the week that contains the date. */
function weekStartOf(text) {
  return addDays(text, 1 - weekdayOf(text));
}

/** Parse `HH:mm` into minutes from midnight; `24:00` is allowed only as an end. */
function timeToMinutes(value, field, { allow24 = false } = {}) {
  if (typeof value !== 'string') throw invalid(`${field} 必须是 HH:mm`, { field });
  const text = value.trim();
  if (allow24 && text === '24:00') return 1440;
  const match = TIME_PATTERN.exec(text);
  if (match === null) throw invalid(`${field} 必须是 HH:mm${allow24 ? '（结束可为 24:00）' : ''}`, { field });
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Format minutes from midnight as `HH:mm`, with 1440 as `24:00`. */
function minutesToTime(minutes) {
  if (minutes === 1440) return '24:00';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Reject a block that ends before or at its start (no midnight wrap in v1). */
function assertTimeRange(startMinute, endMinute) {
  if (endMinute <= startMinute) {
    throw invalid('结束时间必须晚于开始时间；跨夜请拆成两个时间块', {
      field: 'end',
      start: minutesToTime(startMinute),
      end: minutesToTime(endMinute),
    });
  }
}

// ---------------------------------------------------------------------------
// Time blocks
// ---------------------------------------------------------------------------

/** Public view of one time block, with the linked task resolved or marked deleted. */
function blockView(db, row) {
  const startMinute = Number(row.start_minute);
  const endMinute = Number(row.end_minute);
  const taskId = row.task_id === null ? null : String(row.task_id);
  let task = null;
  if (taskId !== null) {
    const taskRow = db.get('SELECT id, title, subject, deleted_at FROM study_task WHERE id = ?', taskId);
    task = taskRow === undefined
      ? { id: taskId, title: null, subject: null, deleted: true }
      : {
        id: String(taskRow.id),
        title: String(taskRow.title),
        subject: taskRow.subject === null ? null : String(taskRow.subject),
        deleted: taskRow.deleted_at !== null,
      };
  }
  let metadata = {};
  try { metadata=JSON.parse(row.note)??{}; } catch {}
  return {
    tentative:metadata.tentative===true,
    assumption:metadata.assumption??null,
    sourceProgressRevision:metadata.sourceProgressRevision??null,
    id: String(row.id),
    goalId: row.goal_id ?? null,
    date: String(row.date),
    start: minutesToTime(startMinute),
    end: minutesToTime(endMinute),
    startMinute,
    endMinute,
    minutes: endMinute - startMinute,
    fixed: Number(row.fixed) === 1,
    taskId,
    title: row.title === null ? null : String(row.title),
    note: row.note === null ? null : String(row.note),
    task,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Blocks of the same goal on the same day whose time range intersects the
 * candidate range. Touching ranges (`10:00–11:00` and `11:00–12:00`) do not
 * overlap. A goal owns its own schedule, so blocks of another goal are never
 * conflicts: only the active goal's day is displayed at a time.
 * @param {object} db - Study database handle.
 * @param {{ goalId: string, date: string, startMinute: number, endMinute: number, excludeId?: string | null }} range
 *   Candidate range; `excludeId` skips the block being moved.
 * @returns {Array<Record<string, unknown>>} Stored rows in start order.
 */
function overlappingRows(db, { goalId, date, startMinute, endMinute, excludeId = null }) {
  return db.all(
    `SELECT * FROM study_time_block
      WHERE goal_id = ? AND date = ? AND id <> ? AND start_minute < ? AND end_minute > ?
      ORDER BY start_minute ASC, end_minute ASC, rowid ASC`,
    goalId,
    date,
    excludeId ?? '',
    endMinute,
    startMinute,
  );
}

/** Compact conflict entry for an overlap failure; enough to show the student what was hit. */
function overlapEntry(db, row) {
  const block = blockView(db, row);
  return {
    id: block.id,
    start: block.start,
    end: block.end,
    fixed: block.fixed,
    taskId: block.taskId,
    title: block.title ?? block.task?.title ?? null,
  };
}

/**
 * Reject a block range that overlaps existing blocks of the same goal unless
 * the caller explicitly keeps the overlap. The failure lists every conflicting
 * block so the UI can show the collision before saving.
 * @param {object} db - Study database handle.
 * @param {{ goalId: string, date: string, startMinute: number, endMinute: number, excludeId?: string | null, allowOverlap?: boolean }} options
 *   Candidate range, its goal scope, and the explicit keep flag.
 * @returns {Array<object>} Conflicts; empty when allowed or clear.
 */
function assertNoOverlap(db, { goalId, date, startMinute, endMinute, excludeId = null, allowOverlap = false }) {
  const rows = overlappingRows(db, { goalId, date, startMinute, endMinute, excludeId });
  if (rows.length === 0 || allowOverlap) return [];
  const conflicts = rows.map(row => overlapEntry(db, row));
  const sample = conflicts
    .slice(0, 3)
    .map(entry => `${entry.start}–${entry.end}${entry.title === null ? '' : `「${entry.title}」`}`)
    .join('、');
  throw new StudyError('conflict', `这个时间与 ${conflicts.length} 个时间块重叠：${sample}。确认保留请重试并设置 allowOverlap: true。`, {
    reason: 'overlap',
    date,
    conflicts,
  });
}

/** Create one block on a date; the date defaults to the host's local today. */
function createBlock(payload, api) {
  const date = optionalDate(payload.date, 'date') ?? api.today();
  const startMinute = timeToMinutes(payload.start, 'start');
  const endMinute = timeToMinutes(payload.end, 'end', { allow24: true });
  assertTimeRange(startMinute, endMinute);
  const fixed = optionalBoolean(payload.fixed, 'fixed') ?? false;
  const taskId = optionalText(payload.taskId, 'taskId', { max: 64 });
  const taskRow = taskId === null ? null : activeTaskRow(api.db, taskId);
  const title = optionalText(payload.title, 'title');
  const note = optionalText(payload.note, 'note', { max: 500 });
  if (taskId === null && title === null) {
    throw invalid('时间块需要关联任务或填写标题', { field: 'taskId' });
  }
  // A block always belongs to exactly one goal: its task's goal, or the
  // explicit/active goal for a title-only block. The overlap check uses that
  // same goal, so another goal's schedule never blocks this one.
  const goalId = taskRow === null
    ? (resolveActiveGoal(api.db, payload.goalId) ?? 'unassigned')
    : String(taskRow.goal_id ?? 'unassigned');
  const allowOverlap = optionalBoolean(payload.allowOverlap, 'allowOverlap') ?? false;
  assertNoOverlap(api.db, { goalId, date, startMinute, endMinute, allowOverlap });

  const blockId = `block_${randomUUID()}`;
  const now = api.now().toISOString();
  api.db.run(
    `INSERT INTO study_time_block
       (id, date, start_minute, end_minute, fixed, task_id, title, note, created_at, updated_at, goal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    blockId, date, startMinute, endMinute, fixed ? 1 : 0, taskId, title, note, now, now, goalId,
  );
  const block = blockView(api.db, api.db.get('SELECT * FROM study_time_block WHERE id = ?', blockId));
  api.change({ entity: 'time_block', entityId: blockId, action: 'create', after: block });
  return { block };
}

/**
 * Update selected fields of one block. Omitted fields keep their stored value;
 * `null` clears an optional field. The block id never changes.
 */
function updateBlock(payload, api) {
  const blockId = requireText(payload.id, 'id', { max: 64 });
  const row = api.db.get('SELECT * FROM study_time_block WHERE id = ?', blockId);
  if (row === undefined) throw new StudyError('not_found', `找不到时间块 ${blockId}`, { blockId });
  const before = blockView(api.db, row);

  let date = before.date;
  if (hasOwn(payload, 'date')) {
    const requestedDate = optionalDate(payload.date, 'date');
    if (requestedDate === null) throw invalid('date 不能为空', { field: 'date' });
    date = requestedDate;
  }
  const startMinute = hasOwn(payload, 'start')
    ? timeToMinutes(payload.start, 'start')
    : before.startMinute;
  const endMinute = hasOwn(payload, 'end')
    ? timeToMinutes(payload.end, 'end', { allow24: true })
    : before.endMinute;
  assertTimeRange(startMinute, endMinute);
  const fixed = hasOwn(payload, 'fixed') ? optionalBoolean(payload.fixed, 'fixed') ?? false : before.fixed;
  const taskId = hasOwn(payload, 'taskId')
    ? optionalText(payload.taskId, 'taskId', { max: 64 })
    : before.taskId;
  const taskRow = hasOwn(payload, 'taskId') && taskId !== null ? activeTaskRow(api.db, taskId) : null;
  const title = hasOwn(payload, 'title') ? optionalText(payload.title, 'title') : before.title;
  const note = hasOwn(payload, 'note') ? optionalText(payload.note, 'note', { max: 500 }) : before.note;
  if (taskId === null && title === null) {
    throw invalid('时间块需要关联任务或填写标题', { field: 'taskId' });
  }
  // Re-linking a block to another goal's task moves the block with it; an
  // edit that keeps the task keeps the block's existing goal scope.
  const goalId = taskRow === null
    ? (before.goalId ?? 'unassigned')
    : String(taskRow.goal_id ?? 'unassigned');
  const allowOverlap = optionalBoolean(payload.allowOverlap, 'allowOverlap') ?? false;
  assertNoOverlap(api.db, {
    goalId, date, startMinute, endMinute, excludeId: blockId, allowOverlap,
  });

  const now = api.now().toISOString();
  api.db.run(
    `UPDATE study_time_block
        SET date = ?, start_minute = ?, end_minute = ?, fixed = ?, task_id = ?, title = ?, note = ?,
            goal_id = ?, updated_at = ?
      WHERE id = ?`,
    date, startMinute, endMinute, fixed ? 1 : 0, taskId, title, note, goalId, now, blockId,
  );
  const block = blockView(api.db, api.db.get('SELECT * FROM study_time_block WHERE id = ?', blockId));
  api.change({ entity: 'time_block', entityId: blockId, action: 'update', before, after: block });
  return { block };
}

/**
 * Move one block to another date and/or time. Unlike `updateBlock`, this
 * method cannot change the linked task, its title, or its note: a drag only
 * reschedules the selected block, so the task identity and history are out of
 * reach. An unchanged target is a no-op and writes nothing, which keeps a
 * repeated click or drop from appending a second history entry.
 */
function moveBlock(payload, api) {
  const blockId = requireText(payload.id, 'id', { max: 64 });
  const row = api.db.get('SELECT * FROM study_time_block WHERE id = ?', blockId);
  if (row === undefined) throw new StudyError('not_found', `找不到时间块 ${blockId}`, { blockId });
  const before = blockView(api.db, row);

  let date = before.date;
  if (hasOwn(payload, 'date')) {
    const requestedDate = optionalDate(payload.date, 'date');
    if (requestedDate === null) throw invalid('date 不能为空', { field: 'date' });
    date = requestedDate;
  }
  const startMinute = hasOwn(payload, 'start')
    ? timeToMinutes(payload.start, 'start')
    : before.startMinute;
  const endMinute = hasOwn(payload, 'end')
    ? timeToMinutes(payload.end, 'end', { allow24: true })
    : before.endMinute;
  assertTimeRange(startMinute, endMinute);

  if (date === before.date && startMinute === before.startMinute && endMinute === before.endMinute) {
    return { block: before, moved: false };
  }

  const allowOverlap = optionalBoolean(payload.allowOverlap, 'allowOverlap') ?? false;
  assertNoOverlap(api.db, {
    goalId: before.goalId ?? 'unassigned',
    date, startMinute, endMinute, excludeId: blockId, allowOverlap,
  });

  const now = api.now().toISOString();
  api.db.run(
    'UPDATE study_time_block SET date = ?, start_minute = ?, end_minute = ?, updated_at = ? WHERE id = ?',
    date, startMinute, endMinute, now, blockId,
  );
  const block = blockView(api.db, api.db.get('SELECT * FROM study_time_block WHERE id = ?', blockId));
  api.change({
    entity: 'time_block',
    entityId: blockId,
    action: 'move',
    before,
    after: block,
    reason: optionalText(payload.reason, 'reason', { max: 500 }) ?? '拖拽移动',
  });
  return { block, moved: true };
}

/** Hard-delete one block; the append-only change log keeps its last state. */
function deleteBlock(payload, api) {
  const blockId = requireText(payload.id, 'id', { max: 64 });
  const row = api.db.get('SELECT * FROM study_time_block WHERE id = ?', blockId);
  if (row === undefined) throw new StudyError('not_found', `找不到时间块 ${blockId}`, { blockId });
  const before = blockView(api.db, row);
  api.db.run('DELETE FROM study_time_block WHERE id = ?', blockId);
  api.change({ entity: 'time_block', entityId: blockId, action: 'delete', before });
  return { id: blockId, deleted: true };
}

// ---------------------------------------------------------------------------
// Task progress
// ---------------------------------------------------------------------------

/** Public view of one append-only progress record. */
function progressView(row) {
  return {
    recordId: Number(row.id),
    taskId: String(row.task_id),
    date: String(row.date),
    status: String(row.status),
    quantityDone: row.quantity_done === null ? null : Number(row.quantity_done),
    quantityTotal: row.quantity_total === null ? null : Number(row.quantity_total),
    note: row.note === null ? null : String(row.note),
    confirmed: Number(row.confirmed) === 1,
    actor: String(row.actor),
    at: String(row.at),
  };
}

/** Latest progress record of one task, or `undefined` when nothing was recorded. */
function progressRowOf(db, taskId) {
  return db.get(
    'SELECT * FROM study_task_progress WHERE task_id = ? ORDER BY id DESC LIMIT 1',
    taskId,
  );
}

/**
 * Latest record per task for the given ids. Reading oldest-to-newest and
 * overwriting the map entry makes the last row win without a correlated
 * subquery.
 * @param {object} db - Study database handle.
 * @param {string[]} taskIds - Active task ids to include.
 * @returns {Map<string, object>} Task id to progress view.
 */
function latestProgressMap(db, taskIds) {
  const map = new Map();
  if (taskIds.length === 0) return map;
  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = db.all(
    `SELECT * FROM study_task_progress WHERE task_id IN (${placeholders}) ORDER BY id ASC`,
    ...taskIds,
  );
  for (const row of rows) map.set(String(row.task_id), progressView(row));
  return map;
}

/**
 * The completion rule shown to the student: cancelled tasks leave the
 * denominator, a pending record is not complete, and no record is counted as
 * unrecorded rather than as "not studied". When nothing is counted the rate is
 * `null` instead of a fabricated 100%.
 * @param {Array<object>} tasks - Active task views.
 * @param {Map<string, object>} progressMap - Latest record per task.
 * @returns {object} Counts plus the completion summary.
 */
function completionSummary(tasks, progressMap) {
  const counts = {
    unrecorded: 0,
    notStarted: 0,
    inProgress: 0,
    partial: 0,
    done: 0,
    cancelled: 0,
    pendingConfirmation: 0,
  };
  let completed = 0;
  for (const task of tasks) {
    const current = progressMap.get(task.id);
    if (current === undefined) {
      counts.unrecorded += 1;
      continue;
    }
    if (current.status === 'not_started') counts.notStarted += 1;
    else if (current.status === 'in_progress') counts.inProgress += 1;
    else if (current.status === 'partial') counts.partial += 1;
    else if (current.status === 'done') counts.done += 1;
    else if (current.status === 'cancelled') counts.cancelled += 1;
    if (!current.confirmed) counts.pendingConfirmation += 1;
    if (current.status === 'done' && current.confirmed) completed += 1;
  }
  const taskCount = tasks.length;
  const countedTasks = taskCount - counts.cancelled;
  return {
    taskCount,
    counts,
    completion: {
      countedTasks,
      completedTasks: completed,
      cancelledTasks: counts.cancelled,
      pendingTasks: counts.pendingConfirmation,
      unrecordedTasks: counts.unrecorded,
      rate: countedTasks === 0 ? null : Math.round((completed / countedTasks) * 10000) / 10000,
    },
  };
}

/** Completion summary over all active tasks. */
function completionOfActive(api) {
  const tasks = activeTasks(api.db);
  return completionSummary(tasks, latestProgressMap(api.db, tasks.map(task => task.id)));
}

/**
 * Record one task state. Repeated identical submissions (same state,
 * quantities, note, and confirmation) return the existing record instead of
 * appending another row, so a double click cannot inflate the history. Any
 * field change — including a new note or a confirmation — is a new record.
 */
export function recordProgress(payload, api) {
  const taskId = requireText(payload.taskId, 'taskId', { max: 64 });
  const taskRow = activeTaskRow(api.db, taskId);
  const status = requireOneOf(payload.status, 'status', PROGRESS_STATUSES);
  const date = optionalDate(payload.date, 'date') ?? api.today();
  const quantityDone = optionalInteger(payload.quantityDone, 'quantityDone', { min: 0, max: MAX_QUANTITY });
  const quantityTotal = optionalInteger(payload.quantityTotal, 'quantityTotal', { min: 0, max: MAX_QUANTITY });
  if (quantityDone !== null && quantityTotal !== null && quantityDone > quantityTotal) {
    throw invalid('quantityDone 不能大于 quantityTotal', {
      field: 'quantityDone', quantityDone, quantityTotal,
    });
  }
  if (status === 'done' && quantityDone !== null && quantityTotal !== null && quantityDone < quantityTotal) {
    throw invalid('状态为完成时，已完成数量不能少于总数量', {
      field: 'quantityDone', reason: 'quantity_below_total', quantityDone, quantityTotal,
    });
  }
  const note = optionalText(payload.note, 'note', { max: 500 });
  const confirmed = optionalBoolean(payload.confirmed, 'confirmed') ?? true;

  const previousRow = progressRowOf(api.db, taskId);
  const previous = previousRow === undefined ? null : progressView(previousRow);
  if (previous !== null
    && previous.date === date
    && previous.status === status
    && previous.quantityDone === quantityDone
    && previous.quantityTotal === quantityTotal
    && previous.note === note
    && previous.confirmed === confirmed) {
    return { record: previous, created: false, completion: completionOfActive(api) };
  }

  const at = api.now().toISOString();
  const inserted = api.db.run(
    `INSERT INTO study_task_progress
       (task_id, date, status, quantity_done, quantity_total, note, confirmed, actor, at, goal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    taskId, date, status, quantityDone, quantityTotal, note, confirmed ? 1 : 0, api.actor, at, taskRow.goal_id,
  );
  const record = progressView(api.db.get('SELECT * FROM study_task_progress WHERE id = ?', inserted.lastInsertRowid));
  if (confirmed && (status === 'done' || status === 'cancelled')) {
    // Tentative future work is an assumption, and ends with confirmation.
    for (const block of api.db.all('SELECT id, note, date FROM study_time_block WHERE task_id = ?', taskId)) {
      if (block.date < api.today()) continue;
      try { if (JSON.parse(block.note)?.tentative) api.db.run('DELETE FROM study_time_block WHERE id = ?', block.id); } catch {}
    }
  }
  api.change({
    entity: 'task_progress',
    entityId: taskId,
    action: status,
    before: previous,
    after: record,
    reason: note,
  });
  return { record, created: true, completion: completionOfActive(api) };
}

/**
 * Read the latest progress per active task plus the optional append-only
 * history. `from`/`to` filter the history only; "latest" is always the latest
 * record regardless of the window, because a state is not a daily aggregate.
 */
function progress(payload, api) {
  const taskId = optionalText(payload.taskId, 'taskId', { max: 64 });
  const from = optionalDate(payload.from, 'from');
  const to = optionalDate(payload.to, 'to');
  if (from !== null && to !== null && from > to) throw invalid('from 不能晚于 to', { field: 'from' });

  const tasks = activeTasks(api.db, payload.goalId);
  let selected = tasks;
  if (taskId !== null) {
    selected = tasks.filter(task => task.id === taskId);
    if (selected.length === 0) {
      const raw = api.db.get('SELECT id, deleted_at FROM study_task WHERE id = ?', taskId);
      if (raw === undefined) throw new StudyError('not_found', `找不到任务 ${taskId}`, { taskId });
      throw new StudyError('not_found', `任务 ${taskId} 已删除`, { taskId, deletedAt: String(raw.deleted_at) });
    }
  }

  const ids = selected.map(task => task.id);
  const latest = latestProgressMap(api.db, ids);
  const records = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = api.db.all(
      `SELECT * FROM study_task_progress WHERE task_id IN (${placeholders}) ORDER BY id ASC`,
      ...ids,
    );
    for (const row of rows) {
      const date = String(row.date);
      if (from !== null && date < from) continue;
      if (to !== null && date > to) continue;
      records.push(progressView(row));
    }
  }

  return {
    items: selected.map(task => ({
      taskId: task.id,
      title: task.title,
      progress: latest.get(task.id) ?? null,
    })),
    unrecorded: selected.filter(task => !latest.has(task.id)).map(task => task.id),
    completion: completionSummary(selected, latest),
    records: records.slice(-500),
  };
}

// ---------------------------------------------------------------------------
// Aggregation and views
// ---------------------------------------------------------------------------

/**
 * Split blocks into the study and fixed buckets. Fixed course/rest minutes and
 * their task ids never reach the study totals.
 * @param {Array<object>} blocks - Block views.
 * @returns {{ study: { blockCount: number, minuteCount: number, taskCount: number }, fixed: { blockCount: number, minuteCount: number, taskCount: number } }}
 *   Counts and minutes per bucket.
 */
function summarizeBlocks(blocks) {
  const studyTaskIds = new Set();
  const fixedTaskIds = new Set();
  let studyBlockCount = 0;
  let studyMinuteCount = 0;
  let fixedBlockCount = 0;
  let fixedMinuteCount = 0;
  for (const block of blocks) {
    if (block.fixed) {
      fixedBlockCount += 1;
      fixedMinuteCount += block.minutes;
      if (block.taskId !== null) fixedTaskIds.add(block.taskId);
    } else {
      studyBlockCount += 1;
      studyMinuteCount += block.minutes;
      if (block.taskId !== null) studyTaskIds.add(block.taskId);
    }
  }
  return {
    study: { blockCount: studyBlockCount, minuteCount: studyMinuteCount, taskCount: studyTaskIds.size },
    fixed: { blockCount: fixedBlockCount, minuteCount: fixedMinuteCount, taskCount: fixedTaskIds.size },
  };
}

/** Active task ids that no block in the visible range schedules. */
function unscheduledTaskIds(tasks, blocks) {
  const scheduled = new Set(blocks.map(block => block.taskId).filter(taskId => taskId !== null));
  return tasks.filter(task => !scheduled.has(task.id)).map(task => task.id);
}

/** Read one local day: its blocks, all active tasks, and the study/fixed summary. */
function day(payload, api) {
  const date = optionalDate(payload.date, 'date') ?? api.today();
  const tasks = activeTasks(api.db, payload.goalId);
  const rows = api.db.all(
    'SELECT * FROM study_time_block WHERE date = ? ORDER BY start_minute ASC, end_minute ASC, rowid ASC',
    date,
  );
  const blocks = rows.filter(row => row.goal_id === (resolveActiveGoal(api.db, payload.goalId) ?? 'unassigned')).map(row => blockView(api.db, row));
  const weekStart = weekStartOf(date);
  const progressByTask = latestProgressMap(api.db, tasks.map(task => task.id));
  return {
    date,
    weekday: weekdayOf(date),
    weekStart,
    weekEnd: addDays(weekStart, 6),
    blocks,
    tasks,
    unscheduledTaskIds: unscheduledTaskIds(tasks, blocks),
    summary: summarizeBlocks(blocks),
    progress: Object.fromEntries(progressByTask),
    completion: completionSummary(tasks, progressByTask),
  };
}

/** Read the Monday-to-Sunday week that contains the date. */
function week(payload, api) {
  const anchor = optionalDate(payload.date, 'date') ?? api.today();
  const startDate = weekStartOf(anchor);
  const endDate = addDays(startDate, 6);
  const tasks = activeTasks(api.db, payload.goalId);
  const rows = api.db.all(
    `SELECT * FROM study_time_block
      WHERE date >= ? AND date <= ?
      ORDER BY date ASC, start_minute ASC, end_minute ASC, rowid ASC`,
    startDate,
    endDate,
  );
  const blocksByDate = new Map();
  for (let index = 0; index < 7; index += 1) blocksByDate.set(addDays(startDate, index), []);
  for (const row of rows) {
    if (row.goal_id !== (resolveActiveGoal(api.db, payload.goalId) ?? 'unassigned')) continue;
    const blocks = blocksByDate.get(String(row.date));
    if (blocks !== undefined) blocks.push(blockView(api.db, row));
  }
  const days = [...blocksByDate].map(([date, blocks]) => ({
    date,
    weekday: weekdayOf(date),
    blocks,
    summary: summarizeBlocks(blocks),
  }));
  const allBlocks = days.flatMap(entry => entry.blocks);
  const progressByTask = latestProgressMap(api.db, tasks.map(task => task.id));
  return {
    startDate,
    endDate,
    days,
    tasks,
    unscheduledTaskIds: unscheduledTaskIds(tasks, allBlocks),
    summary: summarizeBlocks(allBlocks),
    progress: Object.fromEntries(progressByTask),
    completion: completionSummary(tasks, progressByTask),
  };
}
