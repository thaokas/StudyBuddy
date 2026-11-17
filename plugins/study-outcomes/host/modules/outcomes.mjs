import { resolveActiveGoal } from '../../../../packages/study-model/facts.mjs';
/**
 * Outcomes module: trustworthy daily, weekly, and monthly completion
 * statistics built from the student's own records.
 *
 * The module owns no tables. Every number is either (a) the append-only
 * progress history (`study_task_progress`, `study_plan_progress`), (b) the
 * once-per-day task baseline captured in `day_snapshot`, (c) the reconstructed
 * state of a day's time blocks from the append-only `change_log`, or (d) an
 * immutable plan revision (`study_plan_revision`). Nothing is copied into a
 * second fact store, so a statistic can always be cross-checked against the
 * task/plan detail that produced it.
 *
 * Three calibers are reported side by side:
 *
 * - **original**: work that existed when the day started. For tasks this is
 *   the day snapshot taken at the day's first open (falling back to the
 *   midnight state rebuilt from `change_log`); for plan items it is the
 *   revision that was applied before local midnight. Later revisions and
 *   cancellations never shrink this denominator.
 * - **adjusted**: work in the current plan for the period. Tasks are the
 *   non-fixed blocks currently on the period's days; plan items come from the
 *   latest revision applied by the period's end. Cancelled items stay in the
 *   denominator: a cancellation changes the reported cancellation share, not
 *   the completion rate.
 * - **cancelled**: the explicitly confirmed cancellations and their share of
 *   each plan. This is deliberately a share, not a completion rate; the UI
 *   must label it as such.
 *
 * "Pending confirmation" is not a completion, "unrecorded" is not "not
 * studied", and an empty period reports a null rate instead of a fabricated
 * 100%. Work with a record but no schedule/plan item is listed as unplanned
 * and kept out of the rates. Fixed course/rest blocks never enter any count.
 *
 * Queries are read-only. The only write this module causes is the once-per-day
 * snapshot the kernel already owns: `apply` installs a snapshot provider that
 * records the day's scheduled task baseline, and the kernel writes it on the
 * day's first service call.
 */
import { StudyError, isPlainObject } from '../../../../packages/study-contracts/index.mjs';

/** Module id; matches the `outcomes` service namespace. */
export const id = 'outcomes';

/** Statistics read the task, plan, and material facts; their schemas must exist first. */
export const deps = ['tasks', 'plans', 'materials'];

/** No tables: the module recomputes from existing append-only facts. */
export const schema = [];
export const readContracts = [
  { owner: 'study-facts', table: 'study_goal', columns: ['id', 'active'], version: 1, purpose: 'Active goal scope' },
  ...['study_task', 'study_task_progress', 'study_time_block', 'study_plan', 'study_plan_revision', 'study_plan_progress', 'study_plan_task']
    .map(table => ({ owner: 'study-facts', table, columns: ['*'], version: 1, purpose: 'Read-only statistics, reconciliation and snapshot baseline' })),
  { owner: 'study-facts', table: 'study_material', columns: ['id', 'title'], version: 1, purpose: 'Material labels' },
];

/** Schema version for a schema-less module (never recorded). */
export const schemaVersion = 1;

/** Version of the `day_snapshot.plan_json.outcomes` payload this build writes. */
export const SNAPSHOT_VERSION = 1;

const DAY_MS = 86_400_000;
const MAX_PERIOD_DAYS = 31;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Register the `outcomes` reader and install the day-snapshot baseline
 * provider. No Agent tool is registered: T14 consumes the service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study`.
 * @param {{ database: object, setDaySnapshotProvider?: Function }} [kernel] - Kernel handle.
 */
export function apply(ctx, kernel) {
  ctx.effect(() => ctx.study.register('outcomes', {
    methods: {
      day: dayOutcome,
      week: weekOutcome,
      month: monthOutcome,
    },
    writes: [],
  }), 'study: outcomes namespace');

  if (kernel !== undefined && typeof kernel.setDaySnapshotProvider === 'function') {
    ctx.effect(() => kernel.setDaySnapshotProvider(({ date, at }) => ({
      outcomes: buildDaySnapshot(kernel.database, date, at),
    })), 'study: outcomes day baseline');
  }
}

// ---------------------------------------------------------------------------
// Local date helpers (same calendar rules as the tasks module)
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

/** Move a local date by whole days. */
function addDays(text, delta) {
  return dayNumberToDate(dateToDayNumber(text) + delta);
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
function weekdayOf(text) {
  const jsDay = new Date(dateToDayNumber(text) * DAY_MS).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/** Monday of the week containing the date. */
function weekStartOf(text) {
  return addDays(text, 1 - weekdayOf(text));
}

/** First day of the calendar month containing the date. */
function monthStartOf(text) {
  return `${text.slice(0, 7)}-01`;
}

/** Last day of the calendar month containing the date. */
function monthEndOf(text) {
  const [year, month] = text.split('-').map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${text.slice(0, 7)}-${String(day).padStart(2, '0')}`;
}

/** Every local date from `from` to `to`, inclusive. */
function enumerateDates(from, to) {
  const dates = [];
  for (let current = from; current <= to; current = addDays(current, 1)) {
    dates.push(current);
    if (dates.length > MAX_PERIOD_DAYS) break;
  }
  return dates;
}

/** ISO instant of local midnight at the start of the date. */
function startOfLocalDay(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

/** Replace a `YYYY-MM-DD` tail; used for month/week range text only. */
function validDateText(text) {
  if (typeof text !== 'string') return false;
  const match = DATE_PATTERN.exec(text);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function requireDate(value, field) {
  if (typeof value !== 'string' || !validDateText(value.trim())) {
    throw invalid(`${field} 必须是有效日期 YYYY-MM-DD`, { field });
  }
  return value.trim();
}

function optionalDate(value, field) {
  if (value === undefined || value === null) return null;
  return requireDate(value, field);
}

function invalid(message, details = {}) {
  return new StudyError('invalid', message, details);
}

function unavailable(message, details = {}) {
  return new StudyError('unavailable', message, details);
}

/** Round a rate the way the tasks module does (4 decimals, no floating tail). */
function rateOf(completed, planned) {
  return planned === 0 ? null : Math.round((completed / planned) * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/** One local day. */
function dayOutcome(payload, api) {
  const date = optionalDate(payload.date, 'date') ?? api.today();
  return buildOutcome(api, 'day', date, date, payload.goalId);
}

/** The Monday-to-Sunday week containing the requested date. */
function weekOutcome(payload, api) {
  const anchor = optionalDate(payload.date, 'date') ?? api.today();
  const start = weekStartOf(anchor);
  return buildOutcome(api, 'week', start, addDays(start, 6), payload.goalId);
}

/** The calendar month containing the requested date. */
function monthOutcome(payload, api) {
  const anchor = optionalDate(payload.date, 'date') ?? api.today();
  return buildOutcome(api, 'month', monthStartOf(anchor), monthEndOf(anchor), payload.goalId);
}

// ---------------------------------------------------------------------------
// Day snapshot provider
// ---------------------------------------------------------------------------

/**
 * Build the compact baseline the kernel stores once per local day: which
 * non-fixed blocks were on the day, grouped by task, at the day's first open.
 * Plan items are not copied here; revisions are the authority for those.
 * @param {{ all: Function, get: Function }} db - Study database handle.
 * @param {string} date - Local date being captured.
 * @param {string} at - Capture instant (ISO).
 * @returns {object} `outcomes` payload for `day_snapshot.plan_json`.
 */
export function buildDaySnapshot(db, date, at) {
  const blocks = db.all(
    `SELECT start_minute, end_minute, fixed, task_id
       FROM study_time_block
      WHERE date = ?
      ORDER BY start_minute ASC, end_minute ASC, rowid ASC`,
    date,
  );
  const taskById = new Map();
  const order = [];
  let studyBlocks = 0;
  let fixedBlocks = 0;
  let untrackedBlocks = 0;
  let studyMinutes = 0;
  let fixedMinutes = 0;
  for (const block of blocks) {
    const minutes = Number(block.end_minute) - Number(block.start_minute);
    if (Number(block.fixed) === 1) {
      fixedBlocks += 1;
      fixedMinutes += minutes;
      continue;
    }
    studyBlocks += 1;
    studyMinutes += minutes;
    if (block.task_id === null) {
      untrackedBlocks += 1;
      continue;
    }
    const taskId = String(block.task_id);
    let entry = taskById.get(taskId);
    if (entry === undefined) {
      const row = db.get('SELECT title, subject, deleted_at FROM study_task WHERE id = ?', taskId);
      entry = {
        id: taskId,
        title: row === undefined || row.title === null ? null : String(row.title),
        subject: row === undefined || row.subject === null ? null : String(row.subject),
        deleted: row === undefined ? true : row.deleted_at !== null,
        minutes: 0,
      };
      taskById.set(taskId, entry);
      order.push(entry);
    }
    entry.minutes += minutes;
  }
  return {
    version: SNAPSHOT_VERSION,
    date,
    capturedAt: at,
    tasks: order,
    untrackedTaskBlockCount: untrackedBlocks,
    counts: {
      studyBlocks,
      fixedBlocks,
      studyTasks: order.length,
      studyMinutes,
      fixedMinutes,
    },
  };
}

// ---------------------------------------------------------------------------
// Outcome construction
// ---------------------------------------------------------------------------

/**
 * Compute one period's outcome document.
 * @param {object} api - Kernel call context (`db`, `today`, `now`).
 * @param {'day'|'week'|'month'} scope - Period kind.
 * @param {string} from - First local date.
 * @param {string} to - Last local date.
 * @returns {object} Statistics document (see the module comment).
 */
function buildOutcome(api, scope, from, to, requestedGoal) {
  const goalId = resolveActiveGoal(api.db, requestedGoal);
  const dates = enumerateDates(from, to);
  if (dates.length === 0 || dates.length > MAX_PERIOD_DAYS) {
    throw invalid(`统计周期必须在 1-${MAX_PERIOD_DAYS} 天之间`, { field: 'date', from, to });
  }
  const db = api.db;
  const nowIso = api.now().toISOString();
  const pastDates = dates.filter(date => date < api.today());

  const snapshots = readDaySnapshots(db, from, to);
  // Select only the columns the statistics read. The append-only progress
  // tables hold one row per record, so `SELECT *` materialization dominates
  // the month query's SQL time on a large history.
  const taskRows = db.all(
    `SELECT id, title, subject, material_ref, deleted_at, retired_at, material_id, scheduled_date
       FROM study_task
      WHERE goal_id IS ?
      ORDER BY created_at ASC, rowid ASC`,
    goalId,
  );
  const taskById = new Map(taskRows.map(row => [String(row.id), taskView(row)]));
  const taskRowById = new Map(taskRows.map(row => [String(row.id), row]));
  const blockRows = db.all(
    `SELECT date, fixed, task_id, goal_id
       FROM study_time_block
      WHERE date >= ? AND date <= ?
      ORDER BY date ASC, start_minute ASC, end_minute ASC, rowid ASC`,
    from,
    to,
  );
  const taskProgressRows = db.all(
    `SELECT id, task_id, date, status, quantity_done, quantity_total, note, confirmed, goal_id
       FROM study_task_progress
      WHERE date >= ? AND date <= ?
      ORDER BY id ASC`,
    from,
    to,
  );
  // A period only needs the per-day totals from the plan history, not its rows.
  const planProgressCounts = countPlanProgressByDate(db, from, to);

  const revisionStore = readRevisions(db);
  const status = buildStatusIndexes(taskProgressRows.filter(row => row.goal_id === goalId), []);
  const units = new Map();
  const dayMeta = new Map(dates.map(date => [date, {
    taskSource: 'none',
    planSource: 'none',
    snapshotAt: null,
    revisionNumbers: new Set(),
  }]));
  const planRevisions = new Set();

  // ---- Original: task baseline per day -------------------------------------
  const fallbackDates = [];
  for (const date of dates) {
    const snapshot = snapshots.get(date);
    if (snapshot !== undefined && snapshot.outcome !== null) {
      dayMeta.get(date).taskSource = 'day_snapshot';
      dayMeta.get(date).snapshotAt = snapshot.createdAt;
      for (const entry of snapshot.outcome.tasks) {
        if (!taskById.has(entry.id)) continue;
        addOriginalTask(units, taskById, {
          taskId: entry.id,
          title: entry.title,
          subject: entry.subject,
          date,
          source: 'day_snapshot',
        });
      }
      continue;
    }
    fallbackDates.push(date);
  }
  // Rebuild both block views — the day-start original baseline and the day-end
  // adjusted view — in one backward change-log walk. The monthly path used to
  // load the current block rows and replay history once per view.
  const blockTargets = [];
  for (const date of fallbackDates) {
    blockTargets.push({ key: `start\u0000${date}`, date, instant: startOfLocalDay(date) });
  }
  for (const date of pastDates) {
    blockTargets.push({ key: `end\u0000${date}`, date, instant: startOfLocalDay(addDays(date, 1)) });
  }
  const blockStates = blockTargets.length === 0 ? new Map() : reconstructBlocks(db, blockTargets);
  if (fallbackDates.length > 0) {
    for (const date of fallbackDates) {
      const blocks = blockStates.get(`start\u0000${date}`) ?? [];
      dayMeta.get(date).taskSource = 'change_log';
      for (const block of blocks) {
        if (block.fixed || block.taskId === null || !taskById.has(block.taskId)) continue;
        addOriginalTask(units, taskById, {
          taskId: block.taskId,
          title: taskById.get(block.taskId)?.title ?? null,
          subject: taskById.get(block.taskId)?.subject ?? null,
          date,
          source: 'change_log',
        });
      }
    }
  }

  // ---- Original: plan baseline per day -------------------------------------
  for (const date of dates) {
    const instant = startOfLocalDay(date);
    for (const plan of revisionStore.plans.filter(plan => plan.goalId === goalId)) {
      const baseline = revisionStore.before(plan.id, instant);
      if (baseline === undefined) continue;
      dayMeta.get(date).planSource = 'plan_revision';
      dayMeta.get(date).revisionNumbers.add(Number(baseline.number));
      planRevisions.add(Number(baseline.number));
      for (const entry of revisionStore.itemsOf(baseline)) {
        if (entry.date !== date) continue;
        addPlanUnit(units, plan, entry, {
          original: true,
          date,
          source: 'plan_revision',
          revision: revisionStore,
        });
      }
    }
  }

  // ---- Adjusted: current blocks and latest revision per plan ---------------
  for (let position = pastDates.length - 1; position >= 0; position -= 1) {
    const date = pastDates[position];
    const blocks = blockStates.get(`end\u0000${date}`) ?? [];
    for (const block of blocks) {
      if (block.fixed || !taskById.has(block.taskId)) continue;
      const task = taskById.get(block.taskId);
      addTaskUnit(units, { taskId: block.taskId, title: task.title, subject: task.subject });
      const unit = units.get(taskKey(block.taskId));
      unit.adjusted = true; unit.adjustedDate = date; unit.adjustedSource = 'change_log';
    }
  }
  for (const task of taskRows) {
    if (task.deleted_at || task.retired_at || !task.scheduled_date || task.scheduled_date < from || task.scheduled_date > to) continue;
    if (db.get('SELECT id FROM study_time_block WHERE task_id = ? LIMIT 1', task.id)) continue;
    addTaskUnit(units, { taskId: task.id, title: task.title, subject: task.subject, materialRef: task.material_ref });
    const unit = units.get(taskKey(task.id));
    unit.adjusted = true; unit.adjustedDate = task.scheduled_date; unit.adjustedSource = 'task_date';
  }
  for (const row of blockRows.filter(row => row.goal_id === goalId && row.date >= api.today())) {
    if (Number(row.fixed) === 1) continue;
    const taskId = row.task_id === null ? null : String(row.task_id);
    if (taskId === null) continue;
    const task = taskById.get(taskId);
    addTaskUnit(units, {
      taskId,
      title: task?.title ?? null,
      subject: task?.subject ?? null,
      materialRef: task?.materialRef ?? null,
      deleted: task === undefined || task.deletedAt !== null,
    });
    const unit = units.get(taskKey(taskId));
    if (unit.adjusted !== true) {
      unit.adjusted = true;
      unit.adjustedDate = String(row.date);
      unit.adjustedSource = 'time_block';
    }
  }
  const endExclusive = startOfLocalDay(addDays(to, 1));
  for (const plan of revisionStore.plans.filter(plan => plan.goalId === goalId)) {
    const adjusted = revisionStore.before(plan.id, endExclusive, { inclusiveCap: nowIso });
    if (adjusted === undefined) continue;
    planRevisions.add(Number(adjusted.number));
    for (const entry of revisionStore.itemsOf(adjusted)) {
      if (entry.date === null || entry.date < from || entry.date > to) continue;
      if (entry.taskId) {
        if (entry.date < api.today() && !entry.start && !entry.blocks?.length) {
          addTaskUnit(units, { taskId: entry.taskId, title: entry.title, subject: entry.subject });
          const unit = units.get(taskKey(entry.taskId));
          unit.adjusted = true; unit.adjustedDate = entry.date; unit.adjustedSource = 'plan_revision';
        }
        continue;
      }
      addPlanUnit(units, plan, entry, {
        adjusted: true,
        date: entry.date,
        source: 'plan_revision',
        revision: revisionStore,
      });
    }
  }

  // ---- Progress that has no plan unit yet ----------------------------------
  for (const [key, record] of status.period) {
    if (units.has(key)) continue;
    const [kind, ...parts] = key.split('\u0000');
    if (kind === 'task') {
      const taskId = parts[0];
      const task = taskById.get(taskId);
      addTaskUnit(units, {
        taskId,
        title: task?.title ?? null,
        subject: task?.subject ?? null,
        materialRef: task?.materialRef ?? null,
        deleted: task === undefined || task.deletedAt !== null,
      });
    } else if (kind === 'plan' && parts.length >= 2) {
      const [planId, itemId] = parts;
      const plan = revisionStore.planById.get(planId);
      const entry = revisionStore.itemIndex.get(`${planId}\u0000${itemId}`) ?? null;
      addPlanUnit(units, plan ?? { id: planId }, entry, {
        fallbackItemId: itemId,
        revision: revisionStore,
      });
    }
  }

  // ---- Attach the latest period record and build the item list -------------
  const items = [];
  const materialCache = new Map();
  // One bulk read replaces one `study_plan_task` query per task unit; the table
  // holds at most one row per plan item, so the full scan is tiny.
  const planLinksByTask = new Map();
  for (const link of db.all('SELECT task_id, plan_id, item_id FROM study_plan_task')) {
    const taskId = String(link.task_id);
    if (!planLinksByTask.has(taskId)) planLinksByTask.set(taskId, link);
  }
  for (const unit of units.values()) {
    if (unit.taskId) {
      const taskId = String(unit.taskId);
      const link = planLinksByTask.get(taskId);
      const task = taskRowById.get(taskId);
      if (link) { unit.planId = link.plan_id; unit.itemId = link.item_id; }
      unit.materialId ??= task?.material_id ?? null;
    }
    const record = status.period.get(unit.key) ?? null;
    if (record === null && !unit.original && !unit.adjusted) continue;
    const item = {
      key: unit.key,
      kind: unit.kind,
      ref: unit.kind === 'task' ? unit.taskId : unit.itemId,
      taskId: unit.taskId ?? null,
      planId: unit.planId ?? null,
      itemId: unit.itemId ?? null,
      title: unit.title ?? null,
      subject: unit.subject ?? null,
      materialId: unit.materialId ?? null,
      materialTitle: null,
      materialRef: unit.materialRef ?? null,
      deleted: unit.deleted === true,
      original: unit.original === true,
      originalDate: unit.originalDate ?? null,
      originalSource: unit.originalSource ?? null,
      adjusted: unit.adjusted === true,
      adjustedDate: unit.adjustedDate ?? null,
      adjustedSource: unit.adjustedSource ?? null,
      status: record === null ? 'unrecorded' : record.status,
      confirmed: record === null ? null : record.confirmed,
      pending: record === null ? false : record.confirmed === false,
      recordId: record === null ? null : record.recordId,
      recordDate: record === null ? null : record.date,
      quantityDone: record === null ? null : record.quantityDone,
      quantityTotal: record === null ? null : record.quantityTotal,
      note: record === null ? null : record.note,
    };
    if (item.materialId !== null) {
      const material = materialInfo(db, item.materialId, materialCache);
      item.materialTitle = material.title;
      item.materialDeleted = material.deleted;
    }
    items.push(item);
  }
  items.sort(compareItems);

  // ---- Summaries -----------------------------------------------------------
  const originalUnits = items.filter(item => item.original);
  const adjustedUnits = items.filter(item => item.adjusted);
  const original = summarize(originalUnits);
  const adjusted = summarize(adjustedUnits);
  const bySource = {
    tasks: { original: summarize(originalUnits.filter(item => item.kind === 'task')), adjusted: summarize(adjustedUnits.filter(item => item.kind === 'task')) },
    planItems: { original: summarize(originalUnits.filter(item => item.kind === 'plan')), adjusted: summarize(adjustedUnits.filter(item => item.kind === 'plan')) },
  };
  const recordedUnplanned = items.filter(item => !item.original && !item.adjusted && item.status !== 'unrecorded');
  const completion = {
    original,
    adjusted,
    cancelled: {
      originalCount: original.cancelled,
      adjustedCount: adjusted.cancelled,
      originalShare: rateOf(original.cancelled, original.planned),
      adjustedShare: rateOf(adjusted.cancelled, adjusted.planned),
    },
    bySource,
  };
  const counts = {
    totalUnits: items.length,
    original: original.planned,
    adjusted: adjusted.planned,
    recorded: items.filter(item => item.status !== 'unrecorded').length,
    unrecorded: items.filter(item => (item.original || item.adjusted) && item.status === 'unrecorded').length,
    completed: adjusted.completed,
    cancelled: adjusted.cancelled,
    pending: adjusted.pending,
    unplanned: recordedUnplanned.length,
  };

  // ---- Materials advanced in the period ------------------------------------
  const advanced = items.filter(item => item.status !== 'unrecorded'
    && item.confirmed === true
    && (item.status === 'done' || item.status === 'partial')
    && (item.materialId !== null || item.materialRef !== null));
  const materialMap = new Map();
  const taskReferences = [];
  for (const item of advanced) {
    if (item.materialId !== null) {
      let entry = materialMap.get(item.materialId);
      if (entry === undefined) {
        entry = {
          materialId: item.materialId,
          title: item.materialTitle,
          deleted: item.materialDeleted === true,
          itemIds: [],
          planIds: [],
          recordDates: [],
        };
        materialMap.set(item.materialId, entry);
      }
      if (!entry.itemIds.includes(item.itemId)) entry.itemIds.push(item.itemId);
      if (!entry.planIds.includes(item.planId)) entry.planIds.push(item.planId);
      if (item.recordDate !== null && !entry.recordDates.includes(item.recordDate)) entry.recordDates.push(item.recordDate);
    } else if (item.materialRef !== null) {
      taskReferences.push({
        taskId: item.taskId,
        title: item.title,
        materialRef: item.materialRef,
        status: item.status,
        recordDate: item.recordDate,
      });
    }
  }
  const materials = {
    advancedItemCount: advanced.length,
    distinctMaterialCount: materialMap.size,
    items: [...materialMap.values()]
      .map(entry => ({ ...entry, itemIds: entry.itemIds.sort(), recordDates: entry.recordDates.sort() }))
      .sort((left, right) => compareText(left.title ?? left.materialId, right.title ?? right.materialId)),
    taskReferenceCount: taskReferences.length,
    taskReferences,
  };

  // ---- Per-day rows --------------------------------------------------------
  const recordCounts = countRecordsByDate(taskProgressRows, planProgressCounts, dates);
  // Bucket the planned units once: scanning the full item list for every day
  // is the repeated work that made the month query's day rows expensive.
  const originalByDate = new Map(dates.map(date => [date, []]));
  const adjustedByDate = new Map(dates.map(date => [date, []]));
  const plannedKeysByDate = new Map(dates.map(date => [date, new Set()]));
  for (const item of originalUnits) {
    const bucket = originalByDate.get(item.originalDate);
    if (bucket === undefined) continue;
    bucket.push(item);
    plannedKeysByDate.get(item.originalDate).add(item.key);
  }
  for (const item of adjustedUnits) {
    const bucket = adjustedByDate.get(item.adjustedDate);
    if (bucket === undefined) continue;
    bucket.push(item);
    plannedKeysByDate.get(item.adjustedDate).add(item.key);
  }
  const days = dates.map(date => {
    const meta = dayMeta.get(date);
    const originalPlanned = originalByDate.get(date);
    const adjustedPlanned = adjustedByDate.get(date);
    const dayKeys = plannedKeysByDate.get(date);
    let originalCompleted = 0;
    for (const item of originalPlanned) {
      const record = status.day.get(`${item.key}\u0000${date}`);
      if (record !== undefined && record.status === 'done' && record.confirmed) originalCompleted += 1;
    }
    let adjustedCompleted = 0;
    for (const item of adjustedPlanned) {
      const record = status.day.get(`${item.key}\u0000${date}`);
      if (record !== undefined && record.status === 'done' && record.confirmed) adjustedCompleted += 1;
    }
    let cancelled = 0;
    for (const key of dayKeys) {
      const record = status.day.get(`${key}\u0000${date}`);
      if (record !== undefined && record.status === 'cancelled' && record.confirmed) cancelled += 1;
    }
    let materialAdvances = 0;
    for (const item of advanced) {
      const record = status.day.get(`${item.key}\u0000${date}`);
      if (record !== undefined && (record.status === 'done' || record.status === 'partial') && record.confirmed) materialAdvances += 1;
    }
    // Name the source that actually contributed planned units. A plan-only day
    // is not "day_snapshot" just because the kernel wrote an empty task
    // snapshot at first open.
    const hasOriginalTask = originalPlanned.some(item => item.kind === 'task' && item.originalSource !== 'plan_revision');
    const baselineSource = hasOriginalTask
      ? meta.taskSource
      : (meta.planSource !== 'none'
        ? 'plan_revision'
        : (meta.taskSource === 'day_snapshot' ? 'day_snapshot' : 'none'));
    return {
      date,
      weekday: weekdayOf(date),
      originalPlanned: originalPlanned.length,
      adjustedPlanned: adjustedPlanned.length,
      originalCompleted,
      adjustedCompleted,
      cancelled,
      records: recordCounts.get(date)?.records ?? 0,
      completedRecords: recordCounts.get(date)?.completed ?? 0,
      materialAdvances,
      baselineSource,
      sources: { tasks: meta.taskSource, plan: meta.planSource },
      snapshotAt: meta.snapshotAt,
    };
  });

  // ---- State, notice, and baseline evidence -------------------------------
  const state = outcomeState(items, original, adjusted, recordedUnplanned);
  const plannedCount = new Set([...originalUnits, ...adjustedUnits].map(item => item.key)).size;
  const notice = noticeFor(state, plannedCount, recordedUnplanned.length);
  const baseline = {
    daySnapshotDates: dates.filter(date => dayMeta.get(date).taskSource === 'day_snapshot'),
    changeLogDates: dates.filter(date => dayMeta.get(date).taskSource === 'change_log'),
    planRevisionDates: dates.filter(date => dayMeta.get(date).planSource === 'plan_revision'),
    planRevisions: planRevisions.size,
  };

  return {
    scope,
    from,
    to,
    today: api.today(),
    generatedAt: nowIso,
    empty: items.length === 0,
    state,
    notice,
    completion,
    counts,
    materials,
    days,
    items,
    baseline,
  };
}

/**
 * Classify what the period can honestly say.
 * @returns {'empty'|'no_evidence'|'unplanned_only'|'ready'} State key.
 */
function outcomeState(items, original, adjusted, recordedUnplanned) {
  if (items.length === 0) return 'empty';
  if (original.planned === 0 && adjusted.planned === 0) return 'unplanned_only';
  const planned = items.filter(item => item.original || item.adjusted);
  return planned.every(item => item.status === 'unrecorded') ? 'no_evidence' : 'ready';
}

/** One user-safe sentence for the Agent/tool surface; the page maps `state` itself. */
function noticeFor(state, plannedCount, unplannedCount) {
  if (state === 'empty') return '这段时间没有计划或进度记录。';
  if (state === 'no_evidence') {
    return `有 ${plannedCount} 项计划还没有任何进度记录；未记录不等于未学习，完成率只按已确认完成计算。`;
  }
  if (state === 'unplanned_only') {
    return `有 ${unplannedCount} 条进度记录没有对应的时间块或计划条目，未计入完成率。`;
  }
  return null;
}

/** Count plan-progress records per local date in SQL; the rows themselves are never needed. */
function countPlanProgressByDate(db, from, to) {
  const rows = db.all(
    `SELECT date,
            COUNT(*) AS records,
            SUM(CASE WHEN status = 'done' AND confirmed = 1 THEN 1 ELSE 0 END) AS completed
       FROM study_plan_progress
      WHERE date >= ? AND date <= ?
      GROUP BY date`,
    from,
    to,
  );
  const counts = new Map();
  for (const row of rows) {
    counts.set(String(row.date), { records: Number(row.records), completed: Number(row.completed) });
  }
  return counts;
}

/** Count progress records per local date, plus the confirmed completions. */
function countRecordsByDate(taskRows, planCounts, dates) {
  const wanted = new Set(dates);
  const counts = new Map(dates.map(date => [date, { records: 0, completed: 0 }]));
  for (const record of taskRows) {
    const date = String(record.date);
    if (!wanted.has(date)) continue;
    const bucket = counts.get(date);
    bucket.records += 1;
    if (String(record.status) === 'done' && Number(record.confirmed) === 1) bucket.completed += 1;
  }
  for (const [date, plan] of planCounts) {
    const bucket = counts.get(date);
    if (bucket === undefined) continue;
    bucket.records += plan.records;
    bucket.completed += plan.completed;
  }
  return counts;
}

/** Completion counts for one caliber; cancelled and pending stay out of `completed`. */
function summarize(items) {
  let completed = 0;
  let cancelled = 0;
  let pending = 0;
  let unrecorded = 0;
  let recorded = 0;
  for (const item of items) {
    if (item.status === 'unrecorded') {
      unrecorded += 1;
      continue;
    }
    recorded += 1;
    if (item.confirmed === false) pending += 1;
    if (item.status === 'done' && item.confirmed === true) completed += 1;
    if (item.status === 'cancelled' && item.confirmed === true) cancelled += 1;
  }
  return {
    planned: items.length,
    completed,
    cancelled,
    pending,
    unrecorded,
    recorded,
    rate: rateOf(completed, items.length),
  };
}

/** Stable order: planned date, then kind, then title/id. */
function compareItems(left, right) {
  const leftDate = left.adjustedDate ?? left.originalDate ?? left.recordDate ?? '';
  const rightDate = right.adjustedDate ?? right.originalDate ?? right.recordDate ?? '';
  return compareText(leftDate, rightDate)
    || compareText(left.kind, right.kind)
    || compareText(left.title ?? left.key, right.title ?? right.key)
    || compareText(left.key, right.key);
}

/** Code-unit text comparison; deterministic and much cheaper than localeCompare in a hot sort. */
function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : (a > b ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Unit assembly
// ---------------------------------------------------------------------------

function taskKey(taskId) {
  return `task\u0000${taskId}`;
}

function planKey(planId, itemId) {
  return `plan\u0000${planId}\u0000${itemId}`;
}

/** One row of `study_task` as the statistics need it. */
function taskView(row) {
  return {
    id: String(row.id),
    title: String(row.title),
    subject: row.subject === null ? null : String(row.subject),
    materialRef: row.material_ref === null ? null : String(row.material_ref),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

/** Ensure one task unit exists without overwriting a stronger title. */
function addTaskUnit(units, fields) {
  const key = taskKey(fields.taskId);
  let unit = units.get(key);
  if (unit === undefined) {
    unit = {
      key,
      kind: 'task',
      taskId: fields.taskId,
      title: fields.title ?? null,
      subject: fields.subject ?? null,
      materialRef: fields.materialRef ?? null,
      deleted: fields.deleted === true,
      original: false,
      originalDate: null,
      originalSource: null,
      adjusted: false,
      adjustedDate: null,
      adjustedSource: null,
    };
    units.set(key, unit);
  } else {
    if (unit.title === null && fields.title !== null && fields.title !== undefined) unit.title = fields.title;
    if (unit.subject === null && fields.subject !== null && fields.subject !== undefined) unit.subject = fields.subject;
    if (unit.materialRef === null && fields.materialRef !== null && fields.materialRef !== undefined) unit.materialRef = fields.materialRef;
  }
  return unit;
}

/**
 * Add one task baseline unit. The earliest planned date wins; a later day's
 * baseline cannot relabel a task that was already planned earlier in the
 * period, which is what keeps a reschedule from counting twice.
 */
function addOriginalTask(units, taskById, { taskId, title, subject, date, source }) {
  const task = taskById.get(taskId);
  const unit = addTaskUnit(units, {
    taskId,
    title: title ?? task?.title ?? null,
    subject: subject ?? task?.subject ?? null,
    materialRef: task?.materialRef ?? null,
    deleted: task === undefined || task.deletedAt !== null,
  });
  if (unit.original !== true) {
    unit.original = true;
    unit.originalDate = date;
    unit.originalSource = source;
  }
}

/** Ensure one plan-item unit exists, using the revision metadata when present. */
function addPlanUnit(units, plan, entry, { original = false, adjusted = false, date = null, source = null, fallbackItemId = null, revision }) {
  const planId = plan?.id === undefined || plan.id === null ? null : String(plan.id);
  const itemId = entry?.id === undefined || entry.id === null ? fallbackItemId : String(entry.id);
  if (planId === null || itemId === null) return null;
  if (entry?.taskId) {
    addTaskUnit(units, { taskId: entry.taskId, title: entry.title, subject: entry.subject, materialRef: entry.materialId });
    const unit = units.get(taskKey(entry.taskId));
    unit.planId = planId; unit.itemId = itemId; unit.materialId = entry.materialId;
    if (original && !unit.original) { unit.original = true; unit.originalDate = date; unit.originalSource = source; }
    // Execution blocks decide the adjusted schedule, including manual moves.
    return unit;
  }
  const key = planKey(planId, itemId);
  let unit = units.get(key);
  if (unit === undefined) {
    unit = {
      key,
      kind: 'plan',
      planId,
      itemId,
      title: entry?.title === undefined || entry.title === null ? null : String(entry.title),
      subject: entry?.subject === undefined || entry.subject === null ? null : String(entry.subject),
      materialId: entry?.materialId === undefined || entry.materialId === null ? null : String(entry.materialId),
      materialRef: null,
      deleted: false,
      original: false,
      originalDate: null,
      originalSource: null,
      adjusted: false,
      adjustedDate: null,
      adjustedSource: null,
    };
    units.set(key, unit);
  } else {
    if (unit.title === null && entry?.title !== undefined && entry.title !== null) unit.title = String(entry.title);
    if (unit.subject === null && entry?.subject !== undefined && entry.subject !== null) unit.subject = String(entry.subject);
    if (unit.materialId === null && entry?.materialId !== undefined && entry.materialId !== null) {
      unit.materialId = String(entry.materialId);
    }
  }
  if (original && unit.original !== true) {
    unit.original = true;
    unit.originalDate = date;
    unit.originalSource = source;
  }
  if (adjusted && unit.adjusted !== true) {
    unit.adjusted = true;
    unit.adjustedDate = date;
    unit.adjustedSource = source;
  }
  // Resolve the title from revision history if a progress-only record created
  // the unit before any revision loop reached it.
  if (unit.title === null && revision !== undefined) {
    const found = revision.itemIndex.get(`${planId}\u0000${itemId}`);
    if (found !== undefined) {
      unit.title = found.title ?? null;
      unit.subject = found.subject ?? null;
      unit.materialId = found.materialId ?? unit.materialId;
    }
  }
  return unit;
}

// ---------------------------------------------------------------------------
// Progress status indexes
// ---------------------------------------------------------------------------

/**
 * Build both views of the progress history:
 * - `period`: latest record per unit inside the window (drives the period item status)
 * - `day`: latest record per unit and date inside the window (drives a day row)
 * @param {Array<object>} taskRows - `study_task_progress` rows in id order.
 * @param {Array<object>} planRows - `study_plan_progress` rows in id order.
 * @returns {{ period: Map<string, object>, day: Map<string, object> }} Indexes.
 */
function buildStatusIndexes(taskRows, planRows) {
  const period = new Map();
  const day = new Map();
  for (const row of taskRows) {
    const record = taskRecordView(row);
    const key = taskKey(record.taskId);
    period.set(key, record);
    day.set(`${key}\u0000${record.date}`, record);
  }
  for (const row of planRows) {
    const record = planRecordView(row);
    const key = planKey(record.planId, record.itemId);
    period.set(key, record);
    day.set(`${key}\u0000${record.date}`, record);
  }
  return { period, day };
}

function taskRecordView(row) {
  return {
    recordId: Number(row.id),
    taskId: String(row.task_id),
    date: String(row.date),
    status: String(row.status),
    quantityDone: row.quantity_done === null ? null : Number(row.quantity_done),
    quantityTotal: row.quantity_total === null ? null : Number(row.quantity_total),
    note: row.note === null ? null : String(row.note),
    confirmed: Number(row.confirmed) === 1,
  };
}

function planRecordView(row) {
  return {
    recordId: Number(row.id),
    planId: String(row.plan_id),
    itemId: String(row.item_id),
    date: String(row.date),
    status: String(row.status),
    quantityDone: row.quantity_done === null ? null : Number(row.quantity_done),
    quantityTotal: row.quantity_total === null ? null : Number(row.quantity_total),
    note: row.note === null ? null : String(row.note),
    confirmed: Number(row.confirmed) === 1,
  };
}

/** One material's display title; a deleted material keeps its title with a flag. */
function materialInfo(db, materialId, cache) {
  const cached = cache?.get(materialId);
  if (cached !== undefined) return cached;
  const row = db.get('SELECT title, deleted_at FROM study_material WHERE id = ?', materialId);
  const info = row === undefined
    ? { title: null, deleted: true }
    : { title: String(row.title), deleted: row.deleted_at !== null };
  cache?.set(materialId, info);
  return info;
}

// ---------------------------------------------------------------------------
// Plan revisions
// ---------------------------------------------------------------------------

/**
 * Read every plan head and revision, with a binary search for "the revision
 * applied before instant". Revision snapshots are parsed lazily: only the
 * baseline and adjusted revisions of each plan need their item list.
 */
function readRevisions(db) {
  const planRows = db.all('SELECT id, title, goal_id FROM study_plan ORDER BY created_at ASC, rowid ASC');
  const planById = new Map(planRows.map(row => [String(row.id), { id: String(row.id), title: String(row.title), goalId: row.goal_id }]));
  // Load metadata only: a revision snapshot can be large, and a period needs
  // at most one baseline revision per day plus one adjusted revision per plan.
  // The JSON is fetched on demand, so thousands of old revisions cost nothing.
  const revisionRows = db.all(
    `SELECT id, plan_id, number, applied_at
       FROM study_plan_revision
      ORDER BY plan_id ASC, number ASC`,
  );
  const byPlan = new Map();
  for (const row of revisionRows) {
    const planId = String(row.plan_id);
    let list = byPlan.get(planId);
    if (list === undefined) {
      list = [];
      byPlan.set(planId, list);
    }
    list.push(row);
  }
  const parsed = new Map();
  const itemIndex = new Map();

  /** @returns {Array<object>} Snapshot items of one revision. */
  function itemsOf(row) {
    const cached = parsed.get(String(row.id));
    if (cached !== undefined) return cached;
    const stored = db.get('SELECT snapshot_json FROM study_plan_revision WHERE id = ?', String(row.id));
    if (stored === undefined) {
      throw unavailable('计划修订记录缺失，无法统计成果', {
        revisionId: String(row.id),
        planId: String(row.plan_id),
      });
    }
    let data;
    try {
      data = JSON.parse(String(stored.snapshot_json));
    } catch (error) {
      throw unavailable('计划修订快照损坏，无法统计成果', {
        revisionId: String(row.id),
        planId: String(row.plan_id),
        reason: error.message,
      });
    }
    if (!isPlainObject(data) || !Array.isArray(data.items)) {
      throw unavailable('计划修订快照缺少 items，无法统计成果', {
        revisionId: String(row.id),
        planId: String(row.plan_id),
      });
    }
    const items = data.items.filter(entry => isPlainObject(entry) && typeof entry.id === 'string').map(entry => ({ ...entry, taskId: entry.taskId ?? db.get('SELECT task_id FROM study_plan_task WHERE plan_id = ? AND item_id = ?', row.plan_id, entry.id)?.task_id }));
    parsed.set(String(row.id), items);
    for (const entry of items) {
      const key = `${String(row.plan_id)}\u0000${entry.id}`;
      const previous = itemIndex.get(key);
      // Keep the newest revision's metadata for removed-item titles.
      if (previous === undefined || Number(row.number) >= previous.number) {
        itemIndex.set(key, { ...entry, number: Number(row.number) });
      }
    }
    return items;
  }

  /**
   * Latest revision applied strictly before an instant, optionally capped to now.
   * @param {string} planId - Plan id.
   * @param {string} instant - ISO exclusive bound.
   * @param {{ inclusiveCap?: string }} [options] - Also require `applied_at <= cap`.
   */
  function before(planId, instant, options = {}) {
    const list = byPlan.get(planId);
    if (list === undefined || list.length === 0) return undefined;
    let low = 0;
    let high = list.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const appliedAt = String(list[middle].applied_at);
      if (appliedAt < instant && (options.inclusiveCap === undefined || appliedAt <= options.inclusiveCap)) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found === -1 ? undefined : list[found];
  }

  return {
    plans: planRows.map(row => planById.get(String(row.id))),
    planById,
    itemIndex,
    itemsOf,
    before,
  };
}

// ---------------------------------------------------------------------------
// Day snapshot reading
// ---------------------------------------------------------------------------

/**
 * Read the day snapshots in the period. A missing row, a kernel-era snapshot
 * without an `outcomes` block (legacy), or a snapshot without tasks means the
 * day's task baseline must be rebuilt from `change_log`; a snapshot whose
 * `outcomes` block exists but is malformed is corruption and fails loudly
 * instead of silently rewriting history.
 * @returns {Map<string, { createdAt: string, outcome: object | null }>} Parsed snapshots.
 */
function readDaySnapshots(db, from, to) {
  const rows = db.all(
    'SELECT date, plan_json, created_at FROM day_snapshot WHERE date >= ? AND date <= ? ORDER BY date ASC',
    from,
    to,
  );
  const snapshots = new Map();
  for (const row of rows) {
    const date = String(row.date);
    let plan;
    try {
      plan = JSON.parse(String(row.plan_json));
    } catch (error) {
      throw unavailable('当天快照数据损坏，无法统计成果', { date, reason: error.message });
    }
    if (!isPlainObject(plan)) {
      throw unavailable('当天快照不是对象，无法统计成果', { date });
    }
    const outcome = normalizeSnapshotOutcome(plan.outcomes, date);
    snapshots.set(date, { createdAt: String(row.created_at), outcome });
  }
  return snapshots;
}

/** Validate one stored `outcomes` snapshot block; `undefined` is a legacy snapshot. */
function normalizeSnapshotOutcome(value, date) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)
    || value.version !== SNAPSHOT_VERSION
    || value.date !== date
    || !Array.isArray(value.tasks)) {
    throw unavailable('当天快照的成果基线格式不受支持，无法统计成果', { date, version: value?.version ?? null });
  }
  const tasks = [];
  for (const entry of value.tasks) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') {
      throw unavailable('当天快照的任务基线不完整，无法统计成果', { date });
    }
    tasks.push({
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : null,
      subject: typeof entry.subject === 'string' ? entry.subject : null,
      minutes: Number.isFinite(entry.minutes) ? Number(entry.minutes) : 0,
      deleted: entry.deleted === true,
    });
  }
  return { tasks, counts: isPlainObject(value.counts) ? value.counts : {} };
}

// ---------------------------------------------------------------------------
// Change-log replay for the task baseline
// ---------------------------------------------------------------------------

/**
 * Rebuild the non-fixed blocks that were on each target instant, by walking the
 * append-only time-block history backwards from the current rows. Blocks are
 * the only mutable/task-planning fact: tasks are soft-deleted, so their rows
 * are always available. All requested instants share one backward walk, so a
 * month that needs both the day-start baseline and the day-end adjusted view
 * loads the history and replays it once.
 * @param {{ all: Function, get: Function }} db - Study database handle.
 * @param {Array<{ key: string, date: string, instant: string }>} targets - Instants to capture, keyed by what the caller reads them with.
 * @returns {Map<string, Array<{ id: string, date: string, fixed: boolean, taskId: string | null }>>} Blocks per target key.
 */
function reconstructBlocks(db, targets) {
  const sortedTargets = [...targets].sort((left, right) => right.instant.localeCompare(left.instant));
  const earliest = sortedTargets[sortedTargets.length - 1].instant;
  const events = db.all(
    `SELECT id, at, entity_id, action, before_json
       FROM change_log
      WHERE entity = 'time_block' AND at >= ?
      ORDER BY id DESC`,
    earliest,
  );
  const state = new Map();
  for (const row of db.all('SELECT id, date, fixed, task_id FROM study_time_block')) {
    state.set(String(row.id), rawBlock(row));
  }
  const captured = new Map();
  let index = 0;
  for (const target of sortedTargets) {
    while (index < events.length && String(events[index].at) >= target.instant) {
      inverseBlockEvent(state, events[index]);
      index += 1;
    }
    const onDate = [];
    for (const block of state.values()) {
      if (block.date === target.date) onDate.push(block);
    }
    onDate.sort((left, right) => left.id.localeCompare(right.id));
    captured.set(target.key, onDate);
  }
  return captured;
}

/** Apply one inverse time-block event to the current-state map. */
function inverseBlockEvent(state, event) {
  const id = String(event.entity_id);
  const action = String(event.action);
  if (action === 'create') {
    state.delete(id);
    return;
  }
  if (action === 'delete' || action === 'update' || action === 'move') {
    let before;
    try {
      before = event.before_json === null ? null : JSON.parse(String(event.before_json));
    } catch (error) {
      throw unavailable('时间块历史损坏，无法重建当天计划', {
        eventId: Number(event.id),
        blockId: id,
        reason: error.message,
      });
    }
    if (before === null || !isPlainObject(before)) {
      state.delete(id);
      return;
    }
    state.set(id, rawBlock(before));
    return;
  }
  throw unavailable('时间块历史包含未知操作，无法重建当天计划', { eventId: Number(event.id), action });
}

/** Normalize either a stored row or a change-log block view. */
function rawBlock(source) {
  const fixed = source.fixed === true ? true : Number(source.fixed) === 1;
  if (source.task_id !== undefined) {
    return {
      id: String(source.id),
      date: String(source.date),
      fixed,
      taskId: source.task_id === null ? null : String(source.task_id),
    };
  }
  return {
    id: String(source.id),
    date: String(source.date),
    fixed,
    taskId: source.taskId === null || source.taskId === undefined ? null : String(source.taskId),
  };
}
