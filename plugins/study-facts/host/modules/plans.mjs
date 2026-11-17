import { verifyLocatorEvidence, refreshLocatorEvidence, rollingView, estimateSuggestions } from '../plan-policy.mjs';
import { resolveActiveGoal } from '../../../../packages/study-model/facts.mjs';
import { toolRequestId } from '../../../../packages/study-contracts/index.mjs';
import { materializePlan as materialize, livePlanData as liveData } from '../../../../packages/study-model/facts.mjs';
import { recordProgress as taskRecordProgress } from './tasks.mjs';
/**
 * Plans module: the only authority for study plans, their drafts, confirmed
 * revisions, capacity checks, and the progress recorded against plan items.
 *
 * A plan is a versioned document. A draft replaces whatever the student or the
 * Agent is currently proposing and never changes today's confirmed plan; a
 * confirmation or revision appends one immutable revision with a reason; an
 * undo appends a new revision that restores the previous snapshot. Stale drafts
 * carry the plan revision they were based on, so an old draft cannot overwrite
 * a newer revision or a manual change.
 *
 * Progress lives in an append-only table: an undo never deletes or rewrites a
 * learning record, and a cancelled item stays out of the completion counts.
 * "Unrecorded" is its own state; the module never treats an unchecked item as
 * proof that the student did not study.
 *
 * Capacity compares the minutes an item needs with the minutes the student
 * declared available for its date (falling back to the goal's daily budget when
 * the plan names a goal). Work that does not fit is kept in the plan as an
 * unscheduled item and reported as a conflict; the plan must be confirmed as
 * trial (`trial: true`) when the student keeps an over-capacity or overlapping
 * arrangement. The module never invents a free slot and never drops work to
 * make a plan look complete.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate } from '../../../../packages/study-contracts/index.mjs';
import { StudyError, isPlainObject } from '../../../../packages/study-contracts/index.mjs';

/** Module id; matches the `plans` service namespace. */
export const id = 'plans';

/** Plans read the goal table that the materials module owns. */
export const deps = ['materials', 'tasks'];

/** Schema version recorded in `module_schema`; bump when the DDL below changes. */
export const schemaVersion = 1;

/** Tables owned by this module. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS study_plan (
    id          TEXT PRIMARY KEY,
    goal_id     TEXT,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL,
    revision    INTEGER NOT NULL DEFAULT 0,
    revision_id TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_plan_goal ON study_plan (goal_id, updated_at)',
  `CREATE TABLE IF NOT EXISTS study_plan_revision (
    id            TEXT PRIMARY KEY,
    plan_id       TEXT NOT NULL,
    number        INTEGER NOT NULL,
    status        TEXT NOT NULL,
    action        TEXT NOT NULL,
    reason        TEXT,
    actor         TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    diff_json     TEXT NOT NULL DEFAULT '{}',
    undone_by     INTEGER,
    created_at    TEXT NOT NULL,
    applied_at    TEXT NOT NULL,
    UNIQUE (plan_id, number)
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_plan_revision_plan ON study_plan_revision (plan_id, number)',
  `CREATE TABLE IF NOT EXISTS study_plan_draft (
    plan_id       TEXT PRIMARY KEY,
    id            TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    reason        TEXT,
    actor         TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS study_plan_progress (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id        TEXT NOT NULL,
    revision       INTEGER NOT NULL,
    item_id        TEXT NOT NULL,
    date           TEXT NOT NULL,
    status         TEXT NOT NULL,
    quantity_done  INTEGER,
    quantity_total INTEGER,
    note           TEXT,
    confirmed      INTEGER NOT NULL,
    actor          TEXT NOT NULL,
    at             TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_plan_progress_item ON study_plan_progress (plan_id, item_id, id)',
  `CREATE TRIGGER IF NOT EXISTS study_plan_progress_no_update
   BEFORE UPDATE ON study_plan_progress BEGIN
     SELECT RAISE(ABORT, 'study_plan_progress is append-only');
   END`,
  `CREATE TRIGGER IF NOT EXISTS study_plan_progress_no_delete
   BEFORE DELETE ON study_plan_progress BEGIN
     SELECT RAISE(ABORT, 'study_plan_progress is append-only');
   END`,
];

const WRITE_METHODS = ['saveDraft', 'discardDraft', 'confirm', 'revise', 'undo', 'recordProgress', 'refine'];

const PLAN_STATUSES = ['draft', 'active', 'trial'];
const PROGRESS_STATUSES = ['not_started', 'in_progress', 'partial', 'done', 'cancelled'];
const ITEM_SOURCES = ['student', 'agent', 'system'];
const PROJECT_KINDS = ['workbook', 'chapter', 'course', 'review', 'other'];
const UNVERIFIED_LOCATORS = ['page', 'chapter', 'exercise'];
const ITEM_FIELDS = [
  'title', 'subject', 'materialId', 'locator', 'estimateMinutes', 'workload', 'date',
  'start', 'end', 'flexible', 'completion', 'dependencies', 'note', 'source', 'projectId',
];

const MAX_ITEMS = 500;
const MAX_PROJECTS = 50;
const MAX_STAGE_GOALS = 100;
const MAX_WEEK_GOALS = 100;
const MAX_AVAILABILITY_DAYS = 366;
const MAX_STRING_LIST = 100;
const MAX_STRING_LIST_ENTRY = 300;
const MAX_ITEM_TITLE = 200;
const MAX_MINUTES = 1440;
const MAX_QUANTITY = 1_000_000;
const MAX_REVISIONS_RETURNED = 100;

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { defineTool } = requireFromSource(join(sourceDirectory, 'packages/core/tools/lib/index.js'));

/**
 * Register the `plans` service and its two Agent tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study` and `tools`.
 */
export function apply(ctx, kernel) {
  ctx.effect(() => ctx.study.register('plans', {
    methods: {
      list: listPlans,
      get: getPlan,
      revisions: listRevisions,
      today: todayView,
      week: weekView,
      progress: readProgress,
      saveDraft,
      discardDraft,
      confirm: confirmPlan,
      revise: revisePlan,
      refine: refinePlan,
      undo: undoRevision,
      recordProgress,
    },
    writes: WRITE_METHODS,
  }), 'study: plans namespace');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_plan',
    description: '学习计划：读取今日/本周安排，提交计划草案，确认或应用修订，撤销最近一次修订。'
      + '计划由多个项目组成（如练习册、章节学习），每个任务归属一个项目并带执行日期 date；当天几点执行不在计划里，由学生在工作台用时间块安排。'
      + '正式计划按修订号保存；草案不会改变今天的正式安排。提交草案或修订时要带上 baseRevision（正式修订号，新建草案为 0），'
      + '过期草案会被拒绝并返回最新版本。容量按学生声明的可用时间（或目标的每日预算）检查：排不下的工作保留为未安排条目，'
      + '超出可用时间或时间重叠时必须显式用 trial: true 确认试行，不能假装已经排得下。撤销只回退安排，不删除任何学习记录。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['today', 'week', 'get', 'draft', 'confirm', 'revise', 'undo', 'refine'],
        description: 'today/week 读安排；get 读完整计划与草案；draft 提交草案；confirm 确认草案；revise 应用修订；refine 只细化指定日期；undo 撤销最近一次修订。',
      },
      planId: { type: 'string', description: '计划 ID；today/week/get/confirm/revise/undo 省略时使用最近更新的计划；draft 省略时新建计划，编辑已有草案要带上 planId。' },
      date: { type: 'string', description: 'today/week 的日期 YYYY-MM-DD，默认今天；week 返回该日期所在周（周一到周日）。' },
      expectedDraftRevision: { type: 'number', description: 'Draft CAS version: 0 for new, otherwise read draftRevision.' },
      goalId: { type: 'string', description: 'Defaults to active goal.' },
      baseRevision: { type: 'number', description: '草案/修订/撤销所基于的正式修订号；新建草案为 0。与最新版本不一致时会拒绝并返回最新版本。' },
      reason: { type: 'string', description: '修订原因；revise 必填，confirm/undo 可选。' },
      draftId: { type: 'string', description: '有未确认草案时，表示已读取该草案；revise/undo 必须带上，否则会返回 conflict 与最新版本。' },
      trial: { type: 'boolean', description: '试行标记；容量不足或时间重叠时必须显式设为 true 才能确认或应用修订。' },
      reviewAt: { type: 'string', description: '试行计划的复盘日期 YYYY-MM-DD；默认 7 天后或考试期限（取较早者）。' },
      plan: {
        type: 'json',
        description: '完整计划内容：{ title?, goalId?, horizonDays?（默认7，1–90天）, projects?, stageGoals?, weekGoals?, availability?, constraints?, assumptions?, items }。'
          + 'projects 每项：{ id?, title, kind?（workbook/chapter/course/review/other）, materialId?, target?, note? }。'
          + 'items 每项：{ id?, projectId, title, subject?, materialId?, locator?{chapter?,page?,exercise?,unverified?,verification?}, estimateMinutes, workload?{study,practice,correction,rest}, date, start?, end?, flexible?, completion?, dependencies?, note?, source? }。分类工作量总分钟用于容量；定位没有证据时标待核实。'
          + 'refine 的 items 只包含指定日期的完整任务列表，带 baseRevision 和 requestId；不覆盖其他日期与手工草案。'
          + 'date 是计划分配给这个任务的执行日期（YYYY-MM-DD）；日常安排不要写 start/end，学生在工作台排当天具体时段。date 为 null 表示尚未排期。'
          + 'availability 每项 { date, minutes }。',
      },
      requestId: { type: 'string', description: '幂等标识；同一 requestId 的相同调用只生效一次。' },
      expectedRevision: { type: 'number', description: '整库修订号；与当前不一致时拒绝过期提交。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const options = { actor: 'agent' };
      if (WRITE_METHODS.includes(TOOL_WRITE_METHODS[args.action])) {
        options.requestId = toolRequestId(args, exec);
        if (args.expectedRevision !== undefined) options.expectedRevision = args.expectedRevision;
      }
      const call = (method, payload) => ctx.study.call('plans', method, payload, options);
      let result;
      switch (args.action) {
        case 'today':
          result = await call('today', { planId: args.planId, date: args.date, goalId: args.goalId });
          break;
        case 'week':
          result = await call('week', { planId: args.planId, date: args.date, goalId: args.goalId });
          break;
        case 'get':
          result = await call('get', { planId: args.planId, goalId: args.goalId });
          break;
        case 'draft':
          result = await call('saveDraft', planWritePayload(args));
          break;
        case 'confirm':
          result = await call('confirm', {
            planId: args.planId,
            baseRevision: args.baseRevision,
            expectedDraftRevision: args.expectedDraftRevision,
            trial: args.trial,
            reviewAt: args.reviewAt,
            reason: args.reason,
          });
          break;
        case 'refine':
          result = await call('refine', { ...planWritePayload(args), date: args.date });
          break;
        case 'revise':
          result = await call('revise', planWritePayload(args));
          break;
        case 'undo':
          result = await call('undo', {
            planId: args.planId,
            baseRevision: args.baseRevision,
            expectedDraftRevision: args.expectedDraftRevision,
            draftId: args.draftId,
            reason: args.reason,
          });
          break;
        default:
          throw new Error(`study_plan 不支持 action=${JSON.stringify(args.action)}`);
      }
      if (result.ok !== true) throw toolFailure('学习计划操作', result);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '学习计划' }),
  })), 'study: study_plan tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_progress',
    description: '学习进度：读取计划任务的当前进度与统计，或记录学生对某个任务执行结果的反馈。'
      + '状态未开始时用 not_started；没有记录不等于未学习，不要根据未勾选推断学生没学。'
      + '完成后用 done，部分完成用 partial 并可带已完成数量，主动取消用 cancelled（取消不计入完成率）。'
      + 'confirmed=false 表示进度尚待确认。每条记录只追加，不覆盖历史。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['read', 'record'],
        description: 'read 读取进度；record 记录一条学生反馈。',
      },
      planId: { type: 'string', description: '计划 ID；省略时使用最近更新的计划。' },
      itemId: { type: 'string', description: 'record：计划任务 ID；read：只看这个任务。' },
      date: { type: 'string', description: 'record：学习发生的日期 YYYY-MM-DD，默认今天。' },
      status: { type: 'string', enum: [...PROGRESS_STATUSES], description: 'record：not_started / in_progress / partial / done / cancelled。' },
      quantityDone: { type: 'number', description: 'record：已完成数量（整数）。' },
      quantityTotal: { type: 'number', description: 'record：总数量（整数）。' },
      note: { type: 'string', description: 'record：学生反馈原文或简短说明，不要改写。' },
      confirmed: { type: 'boolean', description: 'record：进度是否已核实；默认 true，推测或待确认时传 false。' },
      from: { type: 'string', description: 'read：起始日期 YYYY-MM-DD。' },
      to: { type: 'string', description: 'read：结束日期 YYYY-MM-DD。' },
      history: { type: 'boolean', description: 'read：true 时同时返回原始反馈记录。' },
      requestId: { type: 'string', description: '幂等标识；同一 requestId 的相同调用只生效一次。' },
      expectedRevision: { type: 'number', description: '整库修订号；与当前不一致时拒绝过期提交。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const options = { actor: 'agent' };
      if (args.action === 'record') {
        options.requestId = toolRequestId(args, exec);
        if (args.expectedRevision !== undefined) options.expectedRevision = args.expectedRevision;
      }
      const call = (method, payload) => ctx.study.call('plans', method, payload, options);
      let result;
      if (args.action === 'read') {
        result = await call('progress', {
          planId: args.planId,
          itemId: args.itemId,
          from: args.from,
          to: args.to,
          history: args.history,
        });
      } else if (args.action === 'record') {
        result = await call('recordProgress', {
          planId: args.planId,
          itemId: args.itemId,
          date: args.date,
          status: args.status,
          quantityDone: args.quantityDone,
          quantityTotal: args.quantityTotal,
          note: args.note,
          confirmed: args.confirmed,
        });
      } else {
        throw new Error(`study_progress 不支持 action=${JSON.stringify(args.action)}`);
      }
      if (result.ok !== true) throw toolFailure('学习进度操作', result);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '学习进度' }),
  })), 'study: study_progress tool');
}

/** Map tool actions to the service write method they call. */
const TOOL_WRITE_METHODS = Object.freeze({ draft: 'saveDraft', confirm: 'confirm', revise: 'revise', undo: 'undo', refine: 'refine' });

/** Build a model-facing failure that keeps the service code, message, and the actionable context. */
function toolFailure(label, result) {
  const details = result.details ?? {};
  const hints = [];
  for (const key of ['reason', 'field', 'revision', 'baseRevision', 'draftId', 'planId', 'itemId']) {
    if (details[key] !== undefined && details[key] !== null && details[key] !== '') hints.push(`${key}=${details[key]}`);
  }
  if (details.latest?.plan?.revision !== undefined) hints.push(`latestRevision=${details.latest.plan.revision}`);
  if (details.latest?.draft?.id !== undefined) hints.push(`pendingDraft=${details.latest.draft.id}`);
  if (Array.isArray(details.capacity?.conflicts)) {
    for (const conflict of details.capacity.conflicts.slice(0, 3)) hints.push(conflict.message);
  }
  const suffix = hints.length === 0 ? '' : `（${hints.join('；')}）`;
  return new Error(`${label}失败（${result.code}）：${result.message}${suffix}`);
}

/** Build the service payload for `draft`/`revise` from the tool's `plan` JSON. */
function planWritePayload(args) {
  if (!isPlainObject(args.plan)) {
    throw new Error('study_plan 的 draft/revise 需要 plan 对象');
  }
  const payload = { ...args.plan };
  if (args.expectedDraftRevision !== undefined) payload.expectedDraftRevision = args.expectedDraftRevision;
  if (args.goalId !== undefined) payload.goalId = args.goalId;
  if (args.planId !== undefined) payload.planId = args.planId;
  if (args.baseRevision !== undefined) payload.baseRevision = args.baseRevision;
  if (args.reason !== undefined) payload.reason = args.reason;
  if (args.draftId !== undefined) payload.draftId = args.draftId;
  if (args.trial !== undefined) payload.trial = args.trial;
  if (args.reviewAt !== undefined) payload.reviewAt = args.reviewAt;
  return payload;
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function invalid(message, details = {}) {
  return new StudyError('invalid', message, details);
}

function requireText(value, field, { min = 1, max = 200 } = {}) {
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

function requireInteger(value, field, options) {
  if (value === undefined || value === null) throw invalid(`${field} 不能为空`, { field });
  return optionalInteger(value, field, options);
}

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw invalid(`${field} 必须是 true 或 false`, { field });
  return value;
}

function requireBoolean(value, field) {
  if (value === undefined || value === null) throw invalid(`${field} 不能为空`, { field });
  return optionalBoolean(value, field);
}

function oneOf(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`${field} 只能是 ${allowed.join('、')} 之一`, { field, allowed });
  }
  return value;
}

function optionalOneOf(value, field, allowed) {
  if (value === undefined || value === null) return null;
  return oneOf(value, field, allowed);
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

function requireDate(value, field) {
  const text = requireText(value, field, { max: 10 });
  if (!validDateText(text)) throw invalid(`${field} 必须是有效日期 YYYY-MM-DD`, { field });
  return text;
}

function optionalDate(value, field) {
  if (value === undefined || value === null) return null;
  return requireDate(value, field);
}

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function optionalTime(value, field) {
  if (value === undefined || value === null) return null;
  const text = requireText(value, field, { max: 5 });
  if (!TIME_PATTERN.test(text)) throw invalid(`${field} 必须是 HH:MM 格式的时间`, { field });
  return text;
}

function minutesOfTime(text) {
  const [hours, minutes] = text.split(':').map(Number);
  return hours * 60 + minutes;
}

function requireBaseRevision(payload, planRevision) {
  const value = payload.baseRevision;
  if (value === undefined || value === null) {
    throw invalid('提交计划变更需要 baseRevision（新建草案为 0，修订为当前正式修订号）', { field: 'baseRevision' });
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid('baseRevision 必须是非负整数', { field: 'baseRevision' });
  }
  if (value !== planRevision) {
    throw new StudyError('conflict', `计划已更新到修订 ${planRevision}，本次提交基于修订 ${value}，已过期；请基于最新版本重新提交`, {
      baseRevision: value,
      revision: planRevision,
    });
  }
  return value;
}

function parseJsonColumn(value, fallback, label) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StudyError('unavailable', `${label}数据损坏，无法读取`, { reason: error.message });
  }
}

function stringList(value, field, inherited) {
  if (value === undefined) return [...(inherited ?? [])];
  if (!Array.isArray(value)) throw invalid(`${field} 必须是字符串数组`, { field });
  if (value.length > MAX_STRING_LIST) throw invalid(`${field} 最多 ${MAX_STRING_LIST} 条`, { field, max: MAX_STRING_LIST });
  return value.map((entry, index) => requireText(entry, `${field}[${index}]`, { max: MAX_STRING_LIST_ENTRY }));
}

// ---------------------------------------------------------------------------
// Plan content: normalization and validation
// ---------------------------------------------------------------------------

/** Read one goal for validation and capacity fallback; a missing goal is `not_found`. */
function goalOf(db, goalId) {
  if (typeof goalId !== 'string' || goalId.length === 0) throw invalid('goalId 必须是字符串', { field: 'goalId' });
  const row = db.get('SELECT id, exam, deadline, daily_minutes FROM study_goal WHERE id = ?', goalId);
  if (row === undefined) throw new StudyError('not_found', `找不到目标 ${goalId}`, { goalId });
  return {
    id: String(row.id),
    exam: String(row.exam),
    deadline: row.deadline === null ? null : String(row.deadline),
    dailyMinutes: row.daily_minutes === null ? null : Number(row.daily_minutes),
  };
}

/**
 * Resolve a material reference for a write. An active material always passes.
 * A soft-deleted material passes only when the same plan item or project
 * already referenced it in the applied revision or an open draft: that
 * reference is historical, reads already downgrade its locator to unverified,
 * and refusing it would block refining or revising the whole plan.
 */
function requireMaterial(db, materialId, { retained = false } = {}) {
  const row = db.get('SELECT id, title, deleted_at FROM study_material WHERE id = ?', materialId);
  if (row === undefined) throw new StudyError('not_found', `找不到资料 ${materialId}`, { materialId });
  if (row.deleted_at === null || retained) return { id: String(row.id), title: String(row.title) };
  throw new StudyError('not_found', `资料 ${materialId} 已删除`, { materialId, deletedAt: String(row.deleted_at) });
}

function normalizeLocator(value, field) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw invalid(`${field} 必须是对象`, { field });
  const allowed = new Set(['chapter', 'page', 'exercise', 'unverified', 'verification', 'evidence', 'assumption']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`${field} 不支持字段 ${key}`, { field, key });
  }
  const chapter = optionalText(value.chapter, `${field}.chapter`, { max: 200 });
  const page = optionalInteger(value.page, `${field}.page`, { min: 1, max: 100000 });
  const exercise = optionalText(value.exercise, `${field}.exercise`, { max: 40 });
  let unverified = [];
  if (value.unverified !== undefined && value.unverified !== null) {
    if (!Array.isArray(value.unverified)) throw invalid(`${field}.unverified 必须是字符串数组`, { field: `${field}.unverified` });
    for (const entry of value.unverified) {
      oneOf(entry, `${field}.unverified`, UNVERIFIED_LOCATORS);
      if (!unverified.includes(entry)) unverified.push(entry);
    }
  }
  const present = { chapter: chapter !== null, page: page !== null, exercise: exercise !== null };
  if (!present.chapter && !present.page && !present.exercise && unverified.length === 0) return null;
  return { chapter, page, exercise, unverified, ...(value.verification ? { verification: value.verification } : {}), ...(value.evidence ? { evidence: value.evidence } : {}), ...(value.assumption ? { assumption: requireText(value.assumption, `${field}.assumption`, { max: 500 }) } : {}) };
}

/** Stable id for a content-derived item, so re-submitting the same draft keeps progress attached. */
function generatedId(prefix, value, used) {
  let id = prefix + hashText(canonicalJson(value)).slice(0, 16);
  if (used.has(id)) {
    let suffix = 2;
    while (used.has(`${id}-${suffix}`)) suffix += 1;
    id = `${id}-${suffix}`;
  }
  used.add(id);
  return id;
}

function hashText(text) {
  // A short digest recognizes the same item across drafts while keeping ids readable.
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function normalizeStageGoals(value, inherited) {
  if (value === undefined) return [...(inherited ?? [])];
  if (!Array.isArray(value)) throw invalid('stageGoals 必须是数组', { field: 'stageGoals' });
  if (value.length > MAX_STAGE_GOALS) throw invalid(`stageGoals 最多 ${MAX_STAGE_GOALS} 条`, { field: 'stageGoals', max: MAX_STAGE_GOALS });
  const used = new Set();
  return value.map((entry, index) => {
    const field = `stageGoals[${index}]`;
    if (!isPlainObject(entry)) throw invalid(`${field} 必须是对象`, { field });
    const title = requireText(entry.title, `${field}.title`, { max: MAX_ITEM_TITLE });
    const dueDate = optionalDate(entry.dueDate, `${field}.dueDate`);
    const target = optionalText(entry.target, `${field}.target`, { max: 300 });
    const note = optionalText(entry.note, `${field}.note`, { max: 500 });
    const goalId = entry.id === undefined || entry.id === null
      ? generatedId('stage_', { title, dueDate, target }, used)
      : requireText(entry.id, `${field}.id`, { max: 64 });
    if (entry.id !== undefined && entry.id !== null) {
      if (used.has(goalId)) throw invalid(`${field}.id 重复：${goalId}`, { field: `${field}.id` });
      used.add(goalId);
    }
    return { id: goalId, title, dueDate, target, note };
  });
}

function normalizeWeekGoals(value, inherited) {
  if (value === undefined) return [...(inherited ?? [])];
  if (!Array.isArray(value)) throw invalid('weekGoals 必须是数组', { field: 'weekGoals' });
  if (value.length > MAX_WEEK_GOALS) throw invalid(`weekGoals 最多 ${MAX_WEEK_GOALS} 条`, { field: 'weekGoals', max: MAX_WEEK_GOALS });
  const used = new Set();
  const seenWeeks = new Map();
  return value.map((entry, index) => {
    const field = `weekGoals[${index}]`;
    if (!isPlainObject(entry)) throw invalid(`${field} 必须是对象`, { field });
    const weekStart = weekStartOfDate(requireDate(entry.weekStart, `${field}.weekStart`));
    if (seenWeeks.has(weekStart)) {
      throw invalid(`${field}.weekStart 与第 ${seenWeeks.get(weekStart) + 1} 条属于同一周（${weekStart}）`, { field: `${field}.weekStart` });
    }
    seenWeeks.set(weekStart, index);
    const title = requireText(entry.title, `${field}.title`, { max: MAX_ITEM_TITLE });
    const target = optionalText(entry.target, `${field}.target`, { max: 300 });
    const note = optionalText(entry.note, `${field}.note`, { max: 500 });
    const goalId = entry.id === undefined || entry.id === null
      ? generatedId('week_', { weekStart, title, target }, used)
      : requireText(entry.id, `${field}.id`, { max: 64 });
    if (entry.id !== undefined && entry.id !== null) {
      if (used.has(goalId)) throw invalid(`${field}.id 重复：${goalId}`, { field: `${field}.id` });
      used.add(goalId);
    }
    return { id: goalId, weekStart, title, target, note };
  });
}

/** A plan's project owns a group of tasks; it never schedules anything itself. */
function normalizeProjects(value, inherited, db, priorProjects = []) {
  if (value === undefined) return (inherited ?? []).map(project => ({ ...project }));
  if (!Array.isArray(value)) throw invalid('projects 必须是数组', { field: 'projects' });
  if (value.length > MAX_PROJECTS) throw invalid(`projects 最多 ${MAX_PROJECTS} 个`, { field: 'projects', max: MAX_PROJECTS });
  const used = new Set();
  return value.map((entry, index) => {
    const field = `projects[${index}]`;
    if (!isPlainObject(entry)) throw invalid(`${field} 必须是对象`, { field });
    const title = requireText(entry.title, `${field}.title`, { max: MAX_ITEM_TITLE });
    const kind = optionalOneOf(entry.kind, `${field}.kind`, PROJECT_KINDS) ?? 'other';
    const materialId = optionalText(entry.materialId, `${field}.materialId`, { max: 64 });
    const retained = priorProjects.some(old => old.id === entry.id && old.materialId === materialId);
    if (materialId !== null) requireMaterial(db, materialId, { retained });
    const target = optionalText(entry.target, `${field}.target`, { max: 300 });
    const note = optionalText(entry.note, `${field}.note`, { max: 500 });
    const explicitId = entry.id === undefined || entry.id === null
      ? null
      : requireText(entry.id, `${field}.id`, { max: 64 });
    if (explicitId !== null) {
      if (used.has(explicitId)) throw invalid(`${field}.id 重复：${explicitId}`, { field: `${field}.id` });
      used.add(explicitId);
    }
    const id = explicitId ?? generatedId('proj_', { title, kind, materialId, target }, used);
    return { id, title, kind, materialId, target, note };
  });
}

function normalizeAvailability(value, inherited) {
  if (value === undefined) return [...(inherited ?? [])];
  if (!Array.isArray(value)) throw invalid('availability 必须是数组', { field: 'availability' });
  if (value.length > MAX_AVAILABILITY_DAYS) {
    throw invalid(`availability 最多 ${MAX_AVAILABILITY_DAYS} 天`, { field: 'availability', max: MAX_AVAILABILITY_DAYS });
  }
  const seen = new Set();
  const entries = value.map((entry, index) => {
    const field = `availability[${index}]`;
    if (!isPlainObject(entry)) throw invalid(`${field} 必须是对象`, { field });
    const date = requireDate(entry.date, `${field}.date`);
    if (seen.has(date)) throw invalid(`${field}.date 重复：${date}`, { field: `${field}.date` });
    seen.add(date);
    const minutes = requireInteger(entry.minutes, `${field}.minutes`, { min: 0, max: MAX_MINUTES });
    const note = optionalText(entry.note, `${field}.note`, { max: 200 });
    return { date, minutes, note };
  });
  return entries.sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeItems(value, api, priorItems = []) {
  if (!Array.isArray(value)) throw invalid('items 必须是数组', { field: 'items' });
  if (value.length > MAX_ITEMS) throw invalid(`items 最多 ${MAX_ITEMS} 项`, { field: 'items', max: MAX_ITEMS });
  const used = new Set();
  const items = value.map((entry, index) => normalizeItem(entry, index, used, api, priorItems));
  resolveDependencies(items);
  return items;
}

function normalizeItem(entry, index, used, api, priorItems = []) {
  const field = `items[${index}]`;
  if (!isPlainObject(entry)) throw invalid(`${field} 必须是对象`, { field });
  const title = requireText(entry.title, `${field}.title`, { max: MAX_ITEM_TITLE });
  const subject = optionalText(entry.subject, `${field}.subject`, { max: 60 });
  const materialId = optionalText(entry.materialId, `${field}.materialId`, { max: 64 });
  const retained = priorItems.some(old => old.id === entry.id && old.materialId === materialId);
  if (materialId !== null) requireMaterial(api.db, materialId, { retained });
  const projectId = optionalText(entry.projectId, `${field}.projectId`, { max: 64 });
  const locator = verifyLocatorEvidence(api.db, materialId, normalizeLocator(entry.locator, `${field}.locator`), { actor: api.actor });
  const originalEstimate = requireInteger(entry.estimateMinutes, `${field}.estimateMinutes`, { min: 1, max: MAX_MINUTES });
  if (entry.workload !== undefined && !isPlainObject(entry.workload)) throw invalid(`${field}.workload 必须是对象`, { field: `${field}.workload` });
  const workload = entry.workload === undefined ? { study: originalEstimate, practice: 0, correction: 0, rest: 0 }
    : Object.fromEntries(['study', 'practice', 'correction', 'rest'].map(key => [key,
      optionalInteger(entry.workload[key], `${field}.workload.${key}`, { min: 0, max: MAX_MINUTES }) ?? 0]));
  const estimateMinutes = Object.values(workload).reduce((sum, value) => sum + value, 0);
  if (estimateMinutes < 1 || estimateMinutes > MAX_MINUTES) throw invalid(`${field}.workload 总分钟必须为 1–1440`, { field: `${field}.workload` });
  const date = optionalDate(entry.date, `${field}.date`);
  const start = optionalTime(entry.start, `${field}.start`);
  const end = optionalTime(entry.end, `${field}.end`);
  if (start !== null && end === null) throw invalid(`${field}.end 不能为空：开始时间需要结束时间`, { field: `${field}.end` });
  if (start === null && end !== null) throw invalid(`${field}.start 不能为空：结束时间需要开始时间`, { field: `${field}.start` });
  if (start !== null && minutesOfTime(end) <= minutesOfTime(start)) {
    throw invalid(`${field}.end 必须晚于开始时间`, { field: `${field}.end` });
  }
  if (date === null && start !== null) {
    throw invalid(`${field}.start 只有在安排了日期时才能填写`, { field: `${field}.start` });
  }
  const flexible = optionalBoolean(entry.flexible, `${field}.flexible`) ?? true;
  const completion = optionalText(entry.completion, `${field}.completion`, { max: 300 });
  const note = optionalText(entry.note, `${field}.note`, { max: 500 });
  const source = entry.source === undefined || entry.source === null
    ? defaultItemSource(api.actor)
    : oneOf(entry.source, `${field}.source`, ITEM_SOURCES);
  let dependencies = [];
  if (entry.dependencies !== undefined && entry.dependencies !== null) {
    if (!Array.isArray(entry.dependencies)) throw invalid(`${field}.dependencies 必须是字符串数组`, { field: `${field}.dependencies` });
    for (const dependency of entry.dependencies) {
      const text = requireText(dependency, `${field}.dependencies`, { max: 200 });
      if (!dependencies.includes(text)) dependencies.push(text);
    }
  }
  const explicitId = entry.id === undefined || entry.id === null
    ? null
    : requireText(entry.id, `${field}.id`, { max: 64 });
  if (explicitId !== null && used.has(explicitId)) throw invalid(`${field}.id 重复：${explicitId}`, { field: `${field}.id` });
  const itemId = explicitId ?? `item_${randomUUID()}`;
  used.add(itemId);
  return {
    id: itemId, title, subject, materialId, locator, estimateMinutes, date, start, end,
    ...(entry.workload === undefined ? {} : { workload }),
    flexible, completion, dependencies, projectId, note, source,
    ...(entry.blocks === undefined ? {} : { blocks: normalizeBlocks(entry.blocks, field) }),
    unscheduledMinutes: optionalInteger(entry.unscheduledMinutes, `${field}.unscheduledMinutes`, { min: 0 }) ?? 0,
  };
}

function normalizeBlocks(blocks, field) {
  if (!Array.isArray(blocks)) throw invalid(`${field}.blocks must be an array`);
  return blocks.map(block => {
    const date = requireDate(block.date, 'block.date');
    const start = optionalTime(block.start, 'block.start');
    const end = optionalTime(block.end, 'block.end');
    if (!start || !end || minutesOfTime(end) <= minutesOfTime(start)) throw invalid('Execution blocks need valid start/end times');
    return { id: optionalText(block.id, 'block.id', { max:64 }) ?? undefined, date, start, end,
      tentative: optionalBoolean(block.tentative, 'tentative') ?? false,
      assumption: optionalText(block.assumption, 'assumption', {max:300}),
      sourceProgressRevision: optionalInteger(block.sourceProgressRevision, 'sourceProgressRevision', {min:0}) };
  });
}

function defaultItemSource(actor) {
  if (actor === 'ui') return 'student';
  if (actor === 'agent') return 'agent';
  return 'system';
}

/** Resolve dependencies written as ids or unique titles, then reject duplicates and cycles. */
function resolveDependencies(items) {
  const byId = new Map(items.map(entry => [entry.id, entry]));
  const byTitle = new Map();
  for (const entry of items) {
    const matches = byTitle.get(entry.title) ?? [];
    matches.push(entry);
    byTitle.set(entry.title, matches);
  }
  items.forEach((entry, index) => {
    const field = `items[${index}].dependencies`;
    if (!Array.isArray(entry.dependencies)) return;
    const resolved = [];
    for (const raw of entry.dependencies) {
      let targetId = null;
      if (byId.has(raw)) {
        targetId = raw;
      } else {
        const matches = byTitle.get(raw) ?? [];
        if (matches.length > 1) {
          throw invalid(`${field} 中的「${raw}」对应多个任务（${matches.map(match => match.id).join('、')}），请改写成任务 id`, {
            field,
            reason: 'dependency_ambiguous',
            candidates: matches.map(match => match.id),
          });
        }
        if (matches.length === 1) targetId = matches[0].id;
      }
      if (targetId === null) throw invalid(`${field} 引用了不存在的任务「${raw}」`, { field, reason: 'dependency_missing', dependency: raw });
      if (resolved.includes(targetId)) continue;
      resolved.push(targetId);
    }
    entry.dependencies = resolved;
  });

  for (const entry of items) {
    if (entry.dependencies.includes(entry.id)) {
      throw invalid(`任务「${entry.title}」依赖自己`, { field: 'items', reason: 'dependency_self', itemId: entry.id });
    }
  }

  const state = new Map();
  const visit = (entry, chain) => {
    const status = state.get(entry.id);
    if (status === 'done') return;
    if (status === 'visiting') {
      throw invalid(`任务依赖成环：${[...chain, entry.id].join(' -> ')}`, { field: 'items', reason: 'dependency_cycle', itemIds: [...chain, entry.id] });
    }
    state.set(entry.id, 'visiting');
    for (const dependencyId of entry.dependencies) visit(byId.get(dependencyId), [...chain, entry.id]);
    state.set(entry.id, 'done');
  };
  for (const entry of items) visit(entry, []);
}

/** Normalize one complete plan document, inheriting omitted sections from the prior draft or applied revision. */
function normalizePlanContent(payload, api, { applied, draft, planRow }) {
  const goalId = payload.goalId === undefined
    ? inheritValue(draft, applied, 'goalId', planRow?.goal_id ?? resolveActiveGoal(api.db) ?? 'unassigned')
    : (payload.goalId === null ? null : requireText(payload.goalId, 'goalId', { max: 64 }));
  const goal = goalId === null || goalId === 'unassigned' ? null : goalOf(api.db, goalId);

  let title;
  if (payload.title !== undefined) title = requireText(payload.title, 'title', { max: MAX_ITEM_TITLE });
  else if (draft?.title) title = draft.title;
  else if (applied?.title) title = applied.title;
  else if (planRow !== undefined && planRow !== null) title = String(planRow.title);
  else if (goal !== null) title = `${goal.exam} 学习计划`.slice(0, MAX_ITEM_TITLE);
  else throw invalid('新计划需要 title（或先建立备考目标以生成默认标题）', { field: 'title' });

  const trial = payload.trial === undefined
    ? (draft?.trial ?? applied?.trial ?? false)
    : requireBoolean(payload.trial, 'trial');
  const reviewAt = payload.reviewAt === undefined
    ? inheritValue(draft, applied, 'reviewAt', null)
    : optionalDate(payload.reviewAt, 'reviewAt');

  if ((draft?.items.length || applied?.items.length) && payload.items.some(item => !item.id)) throw invalid('Existing plan items require stable id', { field: 'items.id' });
  if (planRow && goalId !== planRow.goal_id) throw invalid('Explicit goal transfer is required', { field: 'goalId' });
  const priorProjects = [...(draft?.projects ?? []), ...(applied?.projects ?? [])];
  const priorItems = [...(draft?.items ?? []), ...(applied?.items ?? [])];
  const projects = normalizeProjects(payload.projects, draft?.projects ?? applied?.projects, api.db, priorProjects);
  const items = normalizeItems(payload.items, api, priorItems);
  for (const item of items) {
    const previous = applied?.items.find(old => old.id === item.id);
    // A confirmed item that already bound a material keeps the explicit
    // replacement rule. Binding a material for the first time is allowed:
    // that is what lets a replaced (retired) task point at its new book so
    // the locator can be verified again.
    if (previous && previous.materialId !== item.materialId && previous.materialId !== null) {
      throw invalid('更换已确认任务的资料需要显式替代任务，原任务与进度将保留', {
        field: 'items.materialId', reason: 'replacement_required', itemId: item.id, action: 'tasks.replaceTask',
      });
    }
  }
  const projectIds = new Set(projects.map(project => project.id));
  for (const [index, item] of items.entries()) {
    if (item.projectId === null || projectIds.has(item.projectId)) continue;
    throw invalid(`任务「${item.title}」引用了不存在的项目 ${item.projectId}`, {
      field: `items[${index}].projectId`,
      projectId: item.projectId,
    });
  }
  return {
    title,
    goalId,
    trial,
    reviewAt,
    projects,
    horizonDays: payload.horizonDays === undefined ? (draft?.horizonDays ?? applied?.horizonDays ?? 7)
      : requireInteger(payload.horizonDays, 'horizonDays', { min: 1, max: 90 }),
    refinedDates: [...(draft?.refinedDates ?? applied?.refinedDates ?? [])],
    stageGoals: normalizeStageGoals(payload.stageGoals, draft?.stageGoals ?? applied?.stageGoals),
    weekGoals: normalizeWeekGoals(payload.weekGoals, draft?.weekGoals ?? applied?.weekGoals),
    availability: normalizeAvailability(payload.availability, draft?.availability ?? applied?.availability),
    constraints: stringList(payload.constraints, 'constraints', draft?.constraints ?? applied?.constraints),
    assumptions: stringList(payload.assumptions, 'assumptions', draft?.assumptions ?? applied?.assumptions),
    items,
  };
}

/** Read the newest explicitly stored value, keeping `null` distinct from "not set". */
function inheritValue(draft, applied, key, fallback) {
  if (draft !== null && draft !== undefined && draft[key] !== undefined) return draft[key];
  if (applied !== null && applied !== undefined && applied[key] !== undefined) return applied[key];
  return fallback;
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/**
 * Compare scheduled study minutes with the student's available minutes and
 * report every conflict without moving or dropping work.
 * @param {object} db - Database handle.
 * @param {object} data - Normalized plan document.
 * @param {string} today - Local date used as the report date.
 * @returns {object} Capacity report with days, unscheduled work, conflicts, and verdict.
 */
function analyzePlan(db, data, today, planId = null) {
  // Keep the plan items intact for totals and unscheduled remainders: expanding
  // a split item into one row per block must not hide the minutes that did not
  // fit anywhere. Execution totals below still use the expanded rows.
  const planItems = data.items;
  data = { ...data, items: planItems.flatMap(item => {
    if (!item.blocks?.length) return [item];
    const blockMinutes = item.blocks.map(block => minutesOfTime(block.end) - minutesOfTime(block.start));
    const progress = planId ? db.get(`SELECT p.status, p.confirmed, p.quantity_done, p.quantity_total
      FROM study_task_progress p JOIN study_plan_task l ON l.task_id = p.task_id
      WHERE l.plan_id = ? AND l.item_id = ? ORDER BY p.id DESC LIMIT 1`, planId, item.id) : null;
    let remainingMinutes = item.estimateMinutes;
    if (Number(progress?.confirmed) === 1) {
      if (progress.status === 'done') remainingMinutes = 0;
      else if (progress.status === 'partial' && Number(progress.quantity_total) > 0 && progress.quantity_done !== null) {
        remainingMinutes = Math.ceil(item.estimateMinutes * Math.max(0, 1 - Number(progress.quantity_done) / Number(progress.quantity_total)));
      }
    }
    const missing = Math.max(0, remainingMinutes - (item.unscheduledMinutes ?? 0) - blockMinutes.reduce((sum, minutes) => sum + minutes, 0));
    return item.blocks.map((block, index) => ({ ...item, ...block, id: item.id,
      estimateMinutes: blockMinutes[index] + (index === item.blocks.length - 1 ? missing : 0) }));
  }) };
  const goalRow = data.goalId === null ? undefined : db.get('SELECT id, deadline, daily_minutes FROM study_goal WHERE id = ?', data.goalId);
  const goalMinutes = goalRow === undefined || goalRow.daily_minutes === null ? null : Number(goalRow.daily_minutes);
  const goal = goalRow === undefined
    ? null
    : {
      id: String(goalRow.id),
      dailyMinutes: goalMinutes,
      deadline: goalRow.deadline === null ? null : String(goalRow.deadline),
    };
  const availability = new Map(data.availability.map(entry => [entry.date, entry]));
  const dates = new Set(availability.keys());
  for (const item of data.items) if (item.date !== null) dates.add(item.date);
  const byId = new Map(data.items.map(item => [item.id, item]));
  const conflicts = [];
  const risks = [];
  let availableTotal = 0;
  let scheduledTotal = 0;
  let shortfallTotal = 0;
  let unknownDays = 0;

  const days = [...dates].sort().map(date => {
    const declared = availability.get(date);
    const declaredMinutes = declared === undefined ? goalMinutes : declared.minutes;
    // Fixed blocks belong to the same calendar, including globally unassigned meals/rest.
    const fixedBlocks = db.all('SELECT id, start_minute, end_minute, title FROM study_time_block b WHERE date = ? AND fixed = 1 AND (goal_id IS ? OR goal_id = ?) AND NOT EXISTS (SELECT 1 FROM study_plan_task l WHERE l.task_id = b.task_id AND l.plan_id = ?)', date, data.goalId, 'unassigned', planId);
    const intervals = fixedBlocks.map(block => [Number(block.start_minute), Number(block.end_minute)]).sort((a,b) => a[0]-b[0]);
    let fixedMinutes = 0, occupiedEnd = -1;
    for (const [start, end] of intervals) { fixedMinutes += Math.max(0, end - Math.max(start, occupiedEnd)); occupiedEnd = Math.max(occupiedEnd, end); }
    const availableMinutes = declaredMinutes === null ? null : Math.max(0, declaredMinutes - fixedMinutes);
    const availabilitySource = declared !== undefined ? 'declared' : goalMinutes === null ? 'unknown' : 'goal_daily_minutes';
    const items = data.items.filter(item => item.date === date);
    const scheduledMinutes = items.reduce((sum, item) => sum + item.estimateMinutes, 0);
    if (availableMinutes !== null) availableTotal += availableMinutes;
    scheduledTotal += scheduledMinutes;
    const overlaps = overlapsOf(items);
    for (const item of items) {
      if (goal?.deadline && date > goal.deadline) conflicts.push({ code: 'deadline_exceeded', date, deadline: goal.deadline, itemIds: [item.id],
        stageGoalIds: (data.stageGoals ?? []).filter(stage => !stage.dueDate || stage.dueDate <= date).map(stage => stage.id),
        message: `${date} 的「${item.title}」超过目标期限 ${goal.deadline}，阶段进度存在风险` });
      if (!item.start || !item.end) continue;
      for (const block of fixedBlocks) {
        const minutes = Math.min(minutesOfTime(item.end), Number(block.end_minute)) - Math.max(minutesOfTime(item.start), Number(block.start_minute));
        if (minutes > 0) conflicts.push({ code: 'fixed_overlap', date, itemIds: [item.id], blockId: block.id, minutes,
          message: `${date} 的「${item.title}」与固定安排「${block.title ?? block.id}」重叠 ${minutes} 分钟` });
      }
    }
    if (availableMinutes === null) {
      unknownDays += 1;
      conflicts.push({
        code: 'unknown_availability',
        date,
        minutes: scheduledMinutes,
        itemIds: items.map(item => item.id),
        message: `${date} 没有可用时间，无法判断 ${scheduledMinutes} 分钟的安排是否排得下`,
      });
    } else if (scheduledMinutes > availableMinutes) {
      const excess = scheduledMinutes - availableMinutes;
      shortfallTotal += excess;
      conflicts.push({
        code: 'over_capacity',
        date,
        minutes: excess,
        itemIds: items.map(item => item.id),
        message: `${date} 安排了 ${scheduledMinutes} 分钟，可用时间只有 ${availableMinutes} 分钟，超出 ${excess} 分钟`,
      });
    }
    for (const overlap of overlaps) {
      conflicts.push({
        code: 'overlap',
        date,
        itemIds: overlap.itemIds,
        minutes: overlap.minutes,
        message: `${date} 的「${overlap.itemIds.map(id => byId.get(id)?.title ?? id).join('」与「')}」时间重叠 ${overlap.minutes} 分钟`,
      });
    }
    return {
      date,
      availabilitySource,
      declaredMinutes,
      fixedMinutes,
      fixedBlockIds: fixedBlocks.map(block => block.id),
      availableMinutes,
      scheduledMinutes,
      remainingMinutes: availableMinutes === null ? null : availableMinutes - scheduledMinutes,
      itemCount: items.length,
      itemIds: items.map(item => item.id),
      overlaps,
    };
  });

  for (const conflict of conflicts) if (conflict.code !== 'unknown_availability') risks.push(conflict.message);

  const unscheduledItems = data.items.filter(item => item.date === null);
  // A review can keep only part of a task's remaining minutes unscheduled while
  // splitting the rest into real blocks. Those minutes are still unresolved
  // work: count them instead of reporting a plan that only looks as large as
  // the blocks it managed to place.
  const partiallyUnscheduled = planItems.filter(item => item.date !== null && Number(item.unscheduledMinutes) > 0);
  const partialUnscheduledMinutes = partiallyUnscheduled.reduce((sum, item) => sum + Number(item.unscheduledMinutes), 0);
  const unscheduledMinutesTotal = unscheduledItems.reduce((sum, item) => sum + item.estimateMinutes, 0) + partialUnscheduledMinutes;
  if (unscheduledMinutesTotal > 0) {
    const unscheduledCount = unscheduledItems.length + partiallyUnscheduled.length;
    const where = partiallyUnscheduled.length === 0
      ? '没有安排日期'
      : '没有排进可用时间';
    conflicts.push({
      code: 'unscheduled_work',
      minutes: unscheduledMinutesTotal,
      itemIds: [...unscheduledItems, ...partiallyUnscheduled].map(item => item.id),
      message: `还有 ${unscheduledCount} 项、共 ${unscheduledMinutesTotal} 分钟的工作${where}`,
    });
    risks.push(`还有 ${unscheduledCount} 项、共 ${unscheduledMinutesTotal} 分钟的工作${where}`);
  }

  for (const item of data.items) {
    for (const dependencyId of item.dependencies) {
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) continue;
      if (dependency.date === null && item.date !== null) {
        const conflict = {
          code: 'dependency_unscheduled',
          itemIds: [item.id],
          dependsOn: dependency.id,
          message: `「${item.title}」安排在 ${item.date}，但前置任务「${dependency.title}」还没有安排日期`,
        };
        conflicts.push(conflict);
        risks.push(conflict.message);
        continue;
      }
      if (dependency.date === null || item.date === null) continue;
      const dependencyLater = dependency.date > item.date
        || (dependency.date === item.date && dependency.start !== null && item.start !== null && dependency.start > item.start);
      if (dependencyLater) {
        const conflict = {
          code: 'dependency_order',
          itemIds: [item.id],
          dependsOn: dependency.id,
          message: `「${item.title}」排在「${dependency.title}」之前，顺序与前置关系相反`,
        };
        conflicts.push(conflict);
        risks.push(conflict.message);
      }
    }
  }

  const overlapCount = conflicts.filter(conflict => conflict.code === 'overlap').length;
  const requiresTrial = shortfallTotal > 0 || overlapCount > 0 || conflicts.some(conflict => ['deadline_exceeded', 'fixed_overlap'].includes(conflict.code));
  const verdict = requiresTrial ? 'over_capacity' : (unknownDays > 0 || unscheduledMinutesTotal > 0 ? 'partial' : 'fits');
  const uniqueRisks = [...new Set(risks)];
  return {
    date: today,
    verdict,
    requiresTrial,
    days,
    unscheduled: {
      count: unscheduledItems.length + partiallyUnscheduled.length,
      minutes: unscheduledMinutesTotal,
      items: [
        ...unscheduledItems.map(item => ({ id: item.id, title: item.title, estimateMinutes: item.estimateMinutes })),
        ...partiallyUnscheduled.map(item => ({ id: item.id, title: item.title, estimateMinutes: Number(item.unscheduledMinutes), partial: true })),
      ],
    },
    totals: {
      itemCount: planItems.length,
      scheduledItemCount: planItems.filter(item => item.date !== null).length,
      unscheduledItemCount: unscheduledItems.length,
      partialUnscheduledItemCount: partiallyUnscheduled.length,
      workload: Object.fromEntries(['study', 'practice', 'correction', 'rest'].map(key => [key, planItems.reduce((sum, item) => sum + (item.workload?.[key] ?? (key === 'study' ? item.estimateMinutes : 0)), 0)])),
      fixedMinutes: days.reduce((sum, day) => sum + day.fixedMinutes, 0),
      plannedMinutes: planItems.reduce((sum, item) => sum + item.estimateMinutes, 0),
      availableMinutes: availableTotal,
      scheduledMinutes: scheduledTotal,
      unscheduledMinutes: unscheduledMinutesTotal,
      shortfallMinutes: shortfallTotal,
      overlapMinutes: conflicts.filter(conflict => conflict.code === 'overlap').reduce((sum, conflict) => sum + conflict.minutes, 0),
      unknownDays,
    },
    conflicts,
    risks: uniqueRisks,
    goal,
  };
}

/**
 * Refuse to apply a plan whose dependent task is scheduled before its
 * prerequisite. Time capacity may be a trial choice; reversed prerequisites are
 * not a choice the service can represent as a working arrangement.
 */
function requireDependencyOrder(capacity, action) {
  const conflict = capacity.conflicts.find(entry => entry.code === 'dependency_order');
  if (conflict === undefined) return;
  throw invalid(`${action}前需要先调整任务顺序：${conflict.message}`, {
    field: 'items',
    reason: 'dependency_order',
    conflict,
    capacity,
  });
}

/** Pairwise slot overlaps inside one date, using a sorted sweep so each pair is reported once. */
function overlapsOf(items) {  const timed = items
    .filter(item => item.start !== null && item.end !== null)
    .sort((left, right) => minutesOfTime(left.start) - minutesOfTime(right.start) || left.id.localeCompare(right.id));
  const overlaps = [];
  for (let left = 0; left < timed.length; left += 1) {
    const end = minutesOfTime(timed[left].end);
    for (let right = left + 1; right < timed.length; right += 1) {
      const start = minutesOfTime(timed[right].start);
      if (start >= end) break;
      const rightEnd = minutesOfTime(timed[right].end);
      const overlapEnd = Math.min(end, rightEnd);
      const overlapMinutes = overlapEnd - start;
      if (overlapMinutes > 0) {
        overlaps.push({
          itemIds: [timed[left].id, timed[right].id],
          minutes: overlapMinutes,
          from: timed[right].start,
          to: overlapEnd === end ? timed[left].end : timed[right].end,
        });
      }
    }
  }
  return overlaps;
}

// ---------------------------------------------------------------------------
// Storage views
// ---------------------------------------------------------------------------

function planRowById(db, planId, field = 'planId') {
  if (planId === null || planId === undefined) return null;
  if (typeof planId !== 'string' || planId.length === 0) throw invalid(`${field} 必须是字符串`, { field });
  const row = db.get('SELECT * FROM study_plan WHERE id = ?', planId);
  if (row === undefined) throw new StudyError('not_found', `找不到计划 ${planId}`, { planId });
  return row;
}

function latestPlanRow(db, planId, goalId) {
  if (planId !== undefined && planId !== null) return planRowById(db, planId);
  return db.get('SELECT * FROM study_plan WHERE goal_id IS ? ORDER BY updated_at DESC, rowid DESC LIMIT 1', (resolveActiveGoal(db, goalId) ?? 'unassigned')) ?? null;
}

function appliedRevisionRow(db, planId) {
  return db.get(
    "SELECT * FROM study_plan_revision WHERE plan_id = ? AND status = 'applied' ORDER BY number DESC LIMIT 1",
    planId,
  );
}

function draftRowOf(db, planId) {
  return db.get('SELECT * FROM study_plan_draft WHERE plan_id = ?', planId);
}

function dataOfRow(row, label) {
  return parseJsonColumn(row.snapshot_json, null, label);
}

function revisionView(row, { includeData = false } = {}) {
  const data = dataOfRow(row, '计划修订');
  return {
    id: String(row.id),
    number: Number(row.number),
    status: String(row.status),
    action: String(row.action),
    reason: row.reason === null ? null : String(row.reason),
    actor: String(row.actor),
    trial: data?.trial === true,
    reviewAt: data?.reviewAt ?? null,
    createdAt: String(row.created_at),
    appliedAt: String(row.applied_at),
    undoneBy: row.undone_by === null ? null : Number(row.undone_by),
    diff: parseJsonColumn(row.diff_json, {}, '计划修订差异'),
    ...(includeData ? { data } : {}),
  };
}

function draftView(row) {
  return {
    id: String(row.id),
    baseRevision: Number(row.base_revision),
    draftRevision: Number(row.revision),
    reason: row.reason === null ? null : String(row.reason),
    actor: String(row.actor),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    data: dataOfRow(row, '计划草案'),
  };
}

function itemCounts(data) {
  const items = data?.items ?? [];
  const scheduled = items.filter(item => item.date !== null);
  const unscheduled = items.filter(item => item.date === null);
  const partial = scheduled.filter(item => Number(item.unscheduledMinutes) > 0);
  return {
    items: items.length,
    projects: Array.isArray(data?.projects) ? data.projects.length : 0,
    scheduledItems: scheduled.length,
    unscheduledItems: unscheduled.length,
    partialUnscheduledItems: partial.length,
    minutes: items.reduce((sum, item) => sum + item.estimateMinutes, 0),
    unscheduledMinutes: unscheduled.reduce((sum, item) => sum + item.estimateMinutes, 0)
      + partial.reduce((sum, item) => sum + Number(item.unscheduledMinutes), 0),
  };
}

function planView(db, row, { applied, draft } = {}) {
  const appliedRow = applied === undefined ? appliedRevisionRow(db, row.id) : applied;
  const draftRow = draft === undefined ? draftRowOf(db, row.id) : draft;
  const appliedData = appliedRow === undefined ? null : dataOfRow(appliedRow, '计划修订');
  const draftData = draftRow === undefined ? null : dataOfRow(draftRow, '计划草案');
  const visible = appliedData ?? draftData;
  return {
    id: String(row.id),
    goalId: visible?.goalId ?? (row.goal_id === null ? null : String(row.goal_id)),
    title: visible?.title ?? String(row.title),
    status: String(row.status),
    revision: Number(row.revision),
    trial: visible?.trial === true,
    reviewAt: visible?.reviewAt ?? null,
    hasDraft: draftRow !== undefined,
    draftRevision: draftRow?.revision ?? 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    appliedRevision: appliedRow === undefined
      ? null
      : { id: String(appliedRow.id), number: Number(appliedRow.number), reason: appliedRow.reason, appliedAt: String(appliedRow.applied_at) },
    counts: itemCounts(visible),
  };
}

/** Everything a stale caller needs to continue from the latest version. */
function planDetail(db, planId, today) {
  const row = planRowById(db, planId);
  if (row === null) return null;
  const applied = appliedRevisionRow(db, row.id);
  const draft = draftRowOf(db, row.id);
  const appliedData = applied === undefined ? null : refreshLocatorEvidence(db, dataOfRow(applied, '计划修订'));
  const draftData = draft === undefined ? null : refreshLocatorEvidence(db, dataOfRow(draft, '计划草案'));
  return {
    plan: planView(db, row, { applied, draft }),
    applied: applied === undefined ? null : { ...revisionView(applied, { includeData: true }), data: appliedData },
    draft: draft === undefined ? null : { ...draftView(draft), data: draftData },
    capacity: draftData !== null ? analyzePlan(db, draftData, today, planId) : appliedData !== null ? analyzePlan(db, appliedData, today, planId) : null,
    revisions: db.all('SELECT * FROM study_plan_revision WHERE plan_id = ? ORDER BY number DESC LIMIT 5', row.id).map(revision => revisionView(revision)),
  };
}

function staleConflict(db, planRow, baseRevision, today) {
  throw new StudyError('conflict', `计划已更新到修订 ${planRow.revision}，本次提交基于修订 ${baseRevision}，已过期；请基于最新版本重新提交`, {
    baseRevision,
    revision: planRow.revision,
    latest: planDetail(db, planRow.id, today),
  });
}

/**
 * A pending draft is a student edit that has not become a formal revision.
 * Applying a revision or undoing one must not silently throw it away, so the
 * caller has to name the draft it read. Confirmation and draft editing are the
 * operations that own the draft and do not need this acknowledgement.
 */
function requireDraftAcknowledgement(db, planRow, payload, action, today) {
  const draft = draftRowOf(db, planRow.id);
  if (draft === undefined) return;
  const draftId = optionalText(payload.draftId, 'draftId', { max: 64 });
  if (draftId === String(draft.id) && payload.expectedDraftRevision === Number(draft.revision)) return;
  throw new StudyError('conflict', `计划还有未确认的草案 ${draft.id}（${draftView(draft).data.title}）；请先读取最新草案，带上 draftId 再${action}，或先确认/丢弃草案`, {
    reason: 'draft_pending',
    draftId: String(draft.id),
    revision: Number(planRow.revision),
    latest: planDetail(db, planRow.id, today),
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function listPlans(payload, api) {
  const goalId = resolveActiveGoal(api.db, payload.goalId);
  const status = optionalOneOf(payload.status, 'status', PLAN_STATUSES);
  const conditions = ['goal_id IS ?'];
  const parameters = [goalId];
  if (status !== null) {
    conditions.push('status = ?');
    parameters.push(status);
  }
  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const rows = api.db.all(`SELECT * FROM study_plan${where} ORDER BY updated_at DESC, rowid DESC`, ...parameters);
  return { plans: rows.map(row => planView(api.db, row)), total: rows.length };
}

function getPlan(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const row = latestPlanRow(api.db, planId, payload.goalId);
  if (row === null) {
    return { plan: null, applied: null, draft: null, capacity: null, progress: null, revisions: [], notice: '还没有任何学习计划' };
  }
  const applied = appliedRevisionRow(api.db, row.id);
  const draft = draftRowOf(api.db, row.id);
  const appliedData = applied === undefined ? null : refreshLocatorEvidence(api.db, liveData(api.db, row.id, dataOfRow(applied, '计划修订')));
  const draftData = draft === undefined ? null : refreshLocatorEvidence(api.db, dataOfRow(draft, '计划草案'));
  const limit = optionalInteger(payload.limit, 'limit', { min: 1, max: MAX_REVISIONS_RETURNED }) ?? 20;
  return {
    plan: planView(api.db, row, { applied, draft }),
    applied: applied === undefined ? null : { ...{ ...revisionView(applied, { includeData: true }), data: appliedData }, data: appliedData },
    draft: draft === undefined ? null : { ...draftView(draft), data: draftData },
    capacity: draftData !== null ? analyzePlan(api.db, draftData, api.today(), row.id) : appliedData !== null ? analyzePlan(api.db, appliedData, api.today(), row.id) : null,
    progress: appliedData === null ? null : progressSummary(api.db, row.id, appliedData, Number(applied.number)),
    revisions: api.db.all('SELECT * FROM study_plan_revision WHERE plan_id = ? ORDER BY number DESC LIMIT ?', row.id, limit)
      .map(revision => revisionView(revision)),
    rolling: (draftData ?? appliedData) ? rollingView(draftData ?? appliedData, api.today()) : null,
    estimationSuggestions: appliedData ? estimateSuggestions(api.db, row.id, appliedData) : [],
    notice: appliedData === null ? '计划尚未确认；草案不会改变今天的正式安排。' : null,
  };
}

function listRevisions(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const row = latestPlanRow(api.db, planId, payload.goalId);
  if (row === null) return { planId: null, revisions: [], notice: '还没有任何学习计划' };
  const limit = optionalInteger(payload.limit, 'limit', { min: 1, max: MAX_REVISIONS_RETURNED }) ?? 20;
  return {
    planId: String(row.id),
    revision: Number(row.revision),
    revisions: api.db.all('SELECT * FROM study_plan_revision WHERE plan_id = ? ORDER BY number DESC LIMIT ?', row.id, limit)
      .map(revision => revisionView(revision)),
  };
}

function progressMap(db, planId) {
  const rows = db.all('SELECT p.*, l.item_id, l.plan_id FROM study_task_progress p JOIN study_plan_task l ON l.task_id=p.task_id WHERE l.plan_id=? ORDER BY p.id', planId);
  const latest = new Map();
  for (const row of rows) latest.set(String(row.item_id), row);
  return { latest, rows };
}

function progressOf(row) {
  if (row === undefined) {
    return {
      status: 'unrecorded',
      recorded: false,
      confirmed: false,
      quantityDone: null,
      quantityTotal: null,
      note: null,
      date: null,
      at: null,
      actor: null,
    };
  }
  return {
    id: Number(row.id),
    status: String(row.status),
    recorded: true,
    confirmed: Number(row.confirmed) === 1,
    quantityDone: row.quantity_done === null ? null : Number(row.quantity_done),
    quantityTotal: row.quantity_total === null ? null : Number(row.quantity_total),
    note: row.note === null ? null : String(row.note),
    date: String(row.date),
    at: String(row.at),
    actor: String(row.actor),
  };
}

function itemView(item, latest) {
  return {
    ...item,
    id: item.id,
    title: item.title,
    subject: item.subject,
    materialId: item.materialId,
    locator: item.locator,
    estimateMinutes: item.estimateMinutes,
    workload: item.workload,
    date: item.date,
    start: item.start,
    end: item.end,
    flexible: item.flexible,
    completion: item.completion,
    dependencies: item.dependencies,
    note: item.note,
    source: item.source,
    progress: progressOf(latest),
  };
}

function itemsOnDate(items, date) {
  return items.flatMap(item => item.blocks?.length
    ? item.blocks.filter(block => block.date === date).map(block => ({...item,...block,id:item.id,blockId:block.id}))
    : item.date === date ? [item] : []);
}

function dayCapacityOf(capacity, date) {
  const day = capacity.days.find(entry => entry.date === date);
  if (day === undefined) {
    return {
      date,
      availabilitySource: 'unknown',
      availableMinutes: null,
      scheduledMinutes: 0,
      remainingMinutes: null,
      itemCount: 0,
      itemIds: [],
    };
  }
  return {
    date: day.date,
    availabilitySource: day.availabilitySource,
    declaredMinutes: day.declaredMinutes,
    fixedMinutes: day.fixedMinutes,
    fixedBlockIds: day.fixedBlockIds,
    availableMinutes: day.availableMinutes,
    scheduledMinutes: day.scheduledMinutes,
    remainingMinutes: day.remainingMinutes,
    itemCount: day.itemCount,
    itemIds: day.itemIds,
  };
}

function todayView(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const date = optionalDate(payload.date, 'date') ?? api.today();
  const row = latestPlanRow(api.db, planId, payload.goalId);
  if (row === null) {
    return { date, plan: null, items: [], unscheduled: [], capacity: null, totals: null, notice: '还没有任何学习计划' };
  }
  const applied = appliedRevisionRow(api.db, row.id);
  if (applied === undefined) {
    return {
      date,
      plan: planView(api.db, row),
      items: [],
      unscheduled: [],
      capacity: null,
      totals: null,
      notice: '计划尚未确认；草案不会改变今天的正式安排。',
    };
  }
  const data = refreshLocatorEvidence(api.db, liveData(api.db, row.id, dataOfRow(applied, '计划修订')));
  const capacity = analyzePlan(api.db, data, api.today(), row.id);
  const { latest } = progressMap(api.db, row.id);
  const items = itemsOnDate(data.items, date).map(item => itemView(item, latest.get(item.id)));
  const unscheduled = data.items.filter(item => item.date === null).map(item => itemView(item, latest.get(item.id)));
  return {
    date,
    plan: planView(api.db, row, { applied }),
    items,
    unscheduled,
    capacity: dayCapacityOf(capacity, date),
    totals: {
      itemCount: items.length,
      estimatedMinutes: items.reduce((sum, item) => sum + item.estimateMinutes, 0),
      completedMinutes: items
        .filter(item => item.progress.status === 'done' && item.progress.confirmed)
        .reduce((sum, item) => sum + item.estimateMinutes, 0),
      unscheduledCount: capacity.unscheduled.count,
      unscheduledMinutes: capacity.unscheduled.minutes,
    },
    refinement: rollingView(data, date).refinement,
    estimationSuggestions: estimateSuggestions(api.db, row.id, data),
    notice: null,
  };
}

function weekView(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const anchor = optionalDate(payload.date, 'date') ?? api.today();
  const start = weekStartOfDate(anchor);
  const end = addDaysToDate(start, 6);
  const row = latestPlanRow(api.db, planId, payload.goalId);
  if (row === null) {
    return { start, end, plan: null, days: [], unscheduled: [], totals: null, capacity: null, notice: '还没有任何学习计划' };
  }
  const applied = appliedRevisionRow(api.db, row.id);
  if (applied === undefined) {
    return {
      start,
      end,
      plan: planView(api.db, row),
      days: [],
      unscheduled: [],
      totals: null,
      capacity: null,
      notice: '计划尚未确认；草案不会改变今天的正式安排。',
    };
  }
  const data = refreshLocatorEvidence(api.db, liveData(api.db, row.id, dataOfRow(applied, '计划修订')));
  const capacity = analyzePlan(api.db, data, api.today(), row.id);
  const { latest } = progressMap(api.db, row.id);
  const days = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDaysToDate(start, offset);
    const items = itemsOnDate(data.items, date).map(item => itemView(item, latest.get(item.id)));
    days.push({
      date,
      weekday: offset + 1,
      ...dayCapacityOf(capacity, date),
      items,
    });
  }
  const unscheduled = data.items.filter(item => item.date === null).map(item => itemView(item, latest.get(item.id)));
  const summary = progressSummary(api.db, row.id, data, Number(applied.number), latest);
  return {
    start,
    end,
    plan: planView(api.db, row, { applied }),
    days,
    unscheduled,
    totals: {
      itemCount: data.items.length,
      estimatedMinutes: summary.minutes.planned,
      scheduledMinutes: capacity.totals.scheduledMinutes,
      availableMinutes: capacity.totals.availableMinutes,
      unscheduledCount: capacity.unscheduled.count,
      unscheduledMinutes: capacity.totals.unscheduledMinutes,
      completedItems: summary.completion.completedItems,
      cancelledItems: summary.completion.cancelledItems,
    },
    capacity,
    notice: null,
  };
}

function progressSummary(db, planId, data, revision, latestMap) {
  const map = latestMap ?? progressMap(db, planId).latest;
  const counts = {
    unrecorded: 0,
    notStarted: 0,
    inProgress: 0,
    partial: 0,
    done: 0,
    cancelled: 0,
    pendingConfirmation: 0,
  };
  let doneConfirmed = 0;
  let planned = 0;
  let scheduled = 0;
  let unscheduled = 0;
  let doneEstimate = 0;
  let cancelledEstimate = 0;
  for (const item of data.items) {
    planned += item.estimateMinutes;
    if (item.date === null) {
      unscheduled += item.estimateMinutes;
    } else if (item.blocks?.length) {
      // A reviewed item can be split: only the placed blocks count as
      // scheduled; the remainder recorded on the item stays unscheduled.
      scheduled += item.blocks.reduce((sum, block) => sum + (minutesOfTime(block.end) - minutesOfTime(block.start)), 0);
      unscheduled += Number(item.unscheduledMinutes) || 0;
    } else {
      scheduled += item.estimateMinutes;
    }
    const row = map.get(item.id);
    if (row === undefined) {
      counts.unrecorded += 1;
      continue;
    }
    const status = String(row.status);
    const confirmed = Number(row.confirmed) === 1;
    if (status === 'not_started') counts.notStarted += 1;
    else if (status === 'in_progress') counts.inProgress += 1;
    else if (status === 'partial') counts.partial += 1;
    else if (status === 'done') counts.done += 1;
    else if (status === 'cancelled') counts.cancelled += 1;
    if (!confirmed) counts.pendingConfirmation += 1;
    if (status === 'done' && confirmed) {
      doneConfirmed += 1;
      doneEstimate += item.estimateMinutes;
    }
    if (status === 'cancelled') cancelledEstimate += item.estimateMinutes;
  }
  return {
    planId: String(planId),
    revision: Number(revision),
    itemCount: data.items.length,
    counts,
    minutes: { planned, scheduled, unscheduled, doneEstimate, cancelledEstimate },
    completion: {
      countedItems: data.items.length - counts.cancelled,
      completedItems: doneConfirmed,
      cancelledItems: counts.cancelled,
      pendingItems: counts.pendingConfirmation,
      note: '取消不计入完成率；未记录不等于未学习。',
    },
  };
}

function readProgress(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const row = latestPlanRow(api.db, planId, payload.goalId);
  if (row === null) {
    return { planId: null, revision: 0, items: [], summary: null, notice: '还没有任何学习计划' };
  }
  const applied = appliedRevisionRow(api.db, row.id);
  if (applied === undefined) {
    return {
      planId: String(row.id),
      revision: 0,
      items: [],
      summary: {
        planId: String(row.id),
        revision: 0,
        itemCount: 0,
        counts: { unrecorded: 0, notStarted: 0, inProgress: 0, partial: 0, done: 0, cancelled: 0, pendingConfirmation: 0 },
        minutes: { planned: 0, scheduled: 0, unscheduled: 0, doneEstimate: 0, cancelledEstimate: 0 },
        completion: { countedItems: 0, completedItems: 0, cancelledItems: 0, pendingItems: 0, note: '取消不计入完成率；未记录不等于未学习。' },
      },
      notice: '计划尚未确认；确认后才有可记录的进度。',
    };
  }
  const data = refreshLocatorEvidence(api.db, liveData(api.db, row.id, dataOfRow(applied, '计划修订')));
  const itemId = optionalText(payload.itemId, 'itemId', { max: 64 });
  const from = optionalDate(payload.from, 'from');
  const to = optionalDate(payload.to, 'to');
  if (from !== null && to !== null && from > to) throw invalid('from 不能晚于 to', { field: 'from' });
  const selected = data.items.filter(item => {
    if (itemId !== null && item.id !== itemId) return false;
    if (from === null && to === null) return true;
    if (item.date === null) return true;
    if (from !== null && item.date < from) return false;
    if (to !== null && item.date > to) return false;
    return true;
  });
  if (itemId !== null && selected.length === 0) {
    const exists = data.items.some(item => item.id === itemId);
    if (!exists) throw new StudyError('not_found', `计划中没有任务 ${itemId}`, { planId: String(row.id), itemId });
  }
  const { latest, rows } = progressMap(api.db, row.id);
  const scopedData = { ...data, revision: Number(applied.number), items: selected };
  const history = optionalBoolean(payload.history, 'history') === true;
  const result = {
    planId: String(row.id),
    revision: Number(applied.number),
    from,
    to,
    items: selected.map(item => itemView(item, latest.get(item.id))),
    summary: progressSummary(api.db, row.id, scopedData, Number(applied.number), latest),
    notice: null,
  };
  if (history) {
    const records = rows.filter(record => {
      if (itemId !== null && String(record.item_id) !== itemId) return false;
      if (from !== null && String(record.date) < from) return false;
      if (to !== null && String(record.date) > to) return false;
      return true;
    });
    result.records = records.slice(-500).map(progressRecordView);
  }
  return result;
}

function progressRecordView(row) {
  return {
    id: Number(row.id),
    planId: String(row.plan_id),
    revision: Number(row.revision),
    itemId: String(row.item_id),
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

// ---------------------------------------------------------------------------
// Writes: draft, confirm, revise, undo, discard, progress
// ---------------------------------------------------------------------------

function saveDraft(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  let planRow = planId === null ? null : planRowById(api.db, planId);
  if (planRow === null && payload.baseRevision !== undefined && payload.baseRevision !== null && payload.baseRevision !== 0) {
    throw invalid('新计划草案的 baseRevision 必须是 0', { field: 'baseRevision' });
  }
  let baseRevision = 0;
  if (planRow !== null) {
    try {
      baseRevision = requireBaseRevision(payload, planRow.revision);
    } catch (error) {
      if (error instanceof StudyError && error.code === 'conflict') staleConflict(api.db, planRow, payload.baseRevision, api.today());
      throw error;
    }
  }
  const applied = planRow === null ? undefined : appliedRevisionRow(api.db, planRow.id);
  const draft = planRow === null ? undefined : draftRowOf(api.db, planRow.id);
  requireDraftRevision(api, planRow, draft, payload);
  const data = normalizePlanContent(payload, api, {
    applied: applied === undefined ? null : dataOfRow(applied, '计划修订'),
    draft: draft === undefined ? null : dataOfRow(draft, '计划草案'),
    planRow,
  });
  const capacity = analyzePlan(api.db, data, api.today(), planRow?.id ?? null);
  const reason = optionalText(payload.reason, 'reason', { max: 500 });
  const now = api.now().toISOString();
  const snapshot = JSON.stringify(data);

  if (planRow === null) {
    planRow = {
      id: `plan_${randomUUID()}`,
      goal_id: data.goalId,
      title: data.title,
      status: 'draft',
      revision: 0,
      revision_id: null,
      created_at: now,
      updated_at: now,
    };
    api.db.run(
      'INSERT INTO study_plan (id, goal_id, title, status, revision, revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      planRow.id, planRow.goal_id, planRow.title, planRow.status, planRow.revision, planRow.revision_id, planRow.created_at, planRow.updated_at,
    );
    api.db.run(
      'INSERT INTO study_plan_draft (plan_id, id, base_revision, snapshot_json, reason, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      planRow.id, `draft_${randomUUID()}`, baseRevision, snapshot, reason, api.actor, now, now,
    );
  } else {
    if (draft === undefined) {
      api.db.run(
        'INSERT INTO study_plan_draft (plan_id, id, base_revision, snapshot_json, reason, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        planRow.id, `draft_${randomUUID()}`, baseRevision, snapshot, reason, api.actor, now, now,
      );
    } else {
      api.db.run(
        'UPDATE study_plan_draft SET revision = revision + 1, base_revision = ?, snapshot_json = ?, reason = ?, actor = ?, updated_at = ? WHERE plan_id = ?',
        baseRevision, snapshot, reason, api.actor, now, planRow.id,
      );
    }
    if (Number(planRow.revision) === 0) {
      api.db.run(
        'UPDATE study_plan SET goal_id = ?, title = ?, updated_at = ? WHERE id = ?',
        data.goalId, data.title, now, planRow.id,
      );
    } else {
      api.db.run('UPDATE study_plan SET updated_at = ? WHERE id = ?', now, planRow.id);
    }
  }

  const nextDraftRevision = Number(api.db.get('SELECT draft_revision FROM study_plan WHERE id = ?', planRow.id).draft_revision) + 1;
  api.db.run('UPDATE study_plan_draft SET revision = ? WHERE plan_id = ?', nextDraftRevision, planRow.id);
  api.db.run('UPDATE study_plan SET draft_revision = ? WHERE id = ?', nextDraftRevision, planRow.id);
  const freshRow = planRowById(api.db, String(planRow.id));
  const freshDraft = draftRowOf(api.db, String(planRow.id));
  api.change({
    entity: 'plan',
    entityId: String(planRow.id),
    action: 'draft',
    after: {
      title: data.title,
      items: data.items.length,
      trial: data.trial,
      baseRevision,
      verdict: capacity.verdict,
    },
    reason,
  });
  return {
    plan: planView(api.db, freshRow, { applied: appliedRevisionRow(api.db, freshRow.id), draft: freshDraft }),
    draft: draftView(freshDraft),
    capacity,
    requiresTrial: capacity.requiresTrial,
  };
}

function discardDraft(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const planRow = latestPlanRow(api.db, planId, payload.goalId);
  if (planRow === null) return { discarded: false, plan: null, notice: '还没有任何学习计划' };
  try {
    requireBaseRevision(payload, planRow.revision);
  } catch (error) {
    if (error instanceof StudyError && error.code === 'conflict') staleConflict(api.db, planRow, payload.baseRevision, api.today());
    throw error;
  }
  const draft = draftRowOf(api.db, planRow.id);
  requireDraftRevision(api, planRow, draft, payload);
  if (draft === undefined) return { discarded: false, plan: planView(api.db, planRow), notice: '没有待处理的草案' };
  api.db.run('DELETE FROM study_plan_draft WHERE plan_id = ?', planRow.id);
  const before = draftView(draft);
  if (Number(planRow.revision) === 0) {
    api.db.run('DELETE FROM study_plan WHERE id = ?', planRow.id);
    api.change({ entity: 'plan', entityId: String(planRow.id), action: 'discard', before, reason: '丢弃未确认的计划草案' });
    return { discarded: true, plan: null, notice: null };
  }
  const now = api.now().toISOString();
  api.db.run('UPDATE study_plan SET updated_at = ? WHERE id = ?', now, planRow.id);
  api.change({ entity: 'plan', entityId: String(planRow.id), action: 'discard_draft', before, reason: '丢弃计划草案' });
  return { discarded: true, plan: planView(api.db, planRowById(api.db, planRow.id)), notice: null };
}

/** Append one applied revision and move the plan head to it. */
function appendRevision(api, planRow, { data, priorData, action, reason, actor }) {
  const number = Number(planRow.revision) + 1;
  const now = api.now().toISOString();
  const previous = appliedRevisionRow(api.db, planRow.id);
  if (previous !== undefined) api.db.run("UPDATE study_plan_revision SET status = 'superseded' WHERE id = ?", previous.id);
  const revisionId = `rev_${randomUUID()}`;
  materialize(api, planRow.id, data, number);
  const diff = diffPlans(priorData, data, Number(planRow.revision), number);
  api.db.run(
    `INSERT INTO study_plan_revision
       (id, plan_id, number, status, action, reason, actor, snapshot_json, diff_json, undone_by, created_at, applied_at)
     VALUES (?, ?, ?, 'applied', ?, ?, ?, ?, ?, NULL, ?, ?)`,
    revisionId, planRow.id, number, action, reason, actor, JSON.stringify(data), JSON.stringify(diff), now, now,
  );
  const status = data.trial ? 'trial' : 'active';
  api.db.run(
    'UPDATE study_plan SET goal_id = ?, title = ?, status = ?, revision = ?, revision_id = ?, updated_at = ? WHERE id = ?',
    data.goalId, data.title, status, number, revisionId, now, planRow.id,
  );
  api.db.run('DELETE FROM study_plan_draft WHERE plan_id = ?', planRow.id);
  const freshRow = planRowById(api.db, planRow.id);
  return { number, revisionId, diff, freshRow, revisionRow: api.db.get('SELECT * FROM study_plan_revision WHERE id = ?', revisionId) };
}

function confirmPlan(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const planRow = latestPlanRow(api.db, planId, payload.goalId);
  if (planRow === null) throw invalid('还没有计划草案，先提交草案再确认', { field: 'planId', reason: 'no_draft' });
  try {
    requireBaseRevision(payload, Number(planRow.revision));
  } catch (error) {
    if (error instanceof StudyError && error.code === 'conflict') staleConflict(api.db, planRow, payload.baseRevision, api.today());
    throw error;
  }
  const draft = draftRowOf(api.db, planRow.id);
  requireDraftRevision(api, planRow, draft, payload);
  if (draft === undefined) throw invalid('没有待确认的计划草案', { field: 'planId', reason: 'no_draft' });
  if (Number(draft.base_revision) !== Number(planRow.revision)) {
    staleConflict(api.db, planRow, Number(draft.base_revision), api.today());
  }
  const draftData = refreshLocatorEvidence(api.db, dataOfRow(draft, '计划草案'));
  const capacity = analyzePlan(api.db, draftData, api.today(), planRow.id);
  requireDependencyOrder(capacity, '确认');
  const trial = payload.trial === undefined ? draftData.trial === true : requireBoolean(payload.trial, 'trial');
  if (capacity.requiresTrial && trial !== true) {
    throw invalid('计划超出可用时间或有时间重叠；确认试行（trial: true）后才能保留这些安排', {
      field: 'trial',
      reason: 'trial_required',
      capacity,
    });
  }
  const reviewAt = trial
    ? (payload.reviewAt === undefined
      ? (draftData.reviewAt ?? defaultReviewAt(api, draftData.goalId))
      : optionalDate(payload.reviewAt, 'reviewAt'))
    : null;
  const applied = appliedRevisionRow(api.db, planRow.id);
  const priorData = applied === undefined ? null : dataOfRow(applied, '计划修订');
  const data = {
    ...draftData,
    trial,
    reviewAt,
  };
  const reason = optionalText(payload.reason, 'reason', { max: 500 }) ?? draft.reason ?? '确认计划';
  const result = appendRevision(api, planRow, { data, priorData, action: 'confirm', reason, actor: api.actor });
  api.change({
    entity: 'plan',
    entityId: String(planRow.id),
    action: 'confirm',
    before: applied === undefined ? null : { revision: Number(applied.number), title: priorData?.title ?? null },
    after: { revision: result.number, title: data.title, trial, diff: result.diff },
    reason,
  });
  return {
    plan: planView(api.db, result.freshRow),
    revision: revisionView(result.revisionRow, { includeData: true }),
    changes: result.diff,
    capacity,
  };
}

function revisePlan(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const planRow = latestPlanRow(api.db, planId, payload.goalId);
  if (planRow === null) throw invalid('还没有正式计划，先提交并确认草案', { field: 'planId', reason: 'no_plan' });
  if (Number(planRow.revision) === 0) {
    throw invalid('计划尚未确认；请先确认草案，再应用修订', { field: 'planId', reason: 'plan_not_confirmed' });
  }
  try {
    requireBaseRevision(payload, Number(planRow.revision));
  } catch (error) {
    if (error instanceof StudyError && error.code === 'conflict') staleConflict(api.db, planRow, payload.baseRevision, api.today());
    throw error;
  }
  requireDraftAcknowledgement(api.db, planRow, payload, '应用修订', api.today());
  const reason = requireText(payload.reason, 'reason', { max: 500 });
  const applied = appliedRevisionRow(api.db, planRow.id);
  const priorData = dataOfRow(applied, '计划修订');
  const draft = draftRowOf(api.db, planRow.id);
  const data = normalizePlanContent(payload, api, {
    applied: priorData,
    draft: draft === undefined ? null : dataOfRow(draft, '计划草案'),
    planRow,
  });
  const capacity = analyzePlan(api.db, data, api.today(), planRow.id);
  requireDependencyOrder(capacity, '应用修订');
  const trial = data.trial;
  if (capacity.requiresTrial && trial !== true) {
    throw invalid('修订后的计划超出可用时间或有时间重叠；应用修订需要 trial: true', {
      field: 'trial',
      reason: 'trial_required',
      capacity,
    });
  }
  const dataWithReview = {
    ...data,
    reviewAt: trial ? (data.reviewAt ?? defaultReviewAt(api, data.goalId)) : null,
  };
  const result = appendRevision(api, planRow, { data: dataWithReview, priorData, action: 'revise', reason, actor: api.actor });
  api.change({
    entity: 'plan',
    entityId: String(planRow.id),
    action: 'revise',
    before: { revision: Number(applied.number), title: priorData.title },
    after: { revision: result.number, title: dataWithReview.title, diff: result.diff },
    reason,
  });
  return {
    plan: planView(api.db, result.freshRow),
    revision: revisionView(result.revisionRow, { includeData: true }),
    changes: result.diff,
    capacity,
  };
}

/** Apply a dated patch against the current live facts, never a whole-plan replacement. */
function refinePlan(payload, api) {
  const row = latestPlanRow(api.db, optionalText(payload.planId, 'planId', { max: 64 }), payload.goalId);
  if (!row || Number(row.revision) === 0) throw invalid('请先确认计划，再细化当天任务', { reason: 'plan_not_confirmed' });
  if (payload.baseRevision !== Number(row.revision)) staleConflict(api.db, row, payload.baseRevision, api.today());
  // A refinement cannot consume an outstanding manual draft, even if its ID is known.
  if (draftRowOf(api.db, row.id)) throw new StudyError('conflict', '还有未确认的手工草案，请先处理草案再细化', { reason: 'draft_pending' });
  const date = optionalDate(payload.date, 'date') ?? api.today();
  const applied = appliedRevisionRow(api.db, row.id);
  const live = refreshLocatorEvidence(api.db, liveData(api.db, row.id, dataOfRow(applied, '计划修订')));
  const end = addDaysToDate(api.today(), (live.horizonDays ?? 7) - 1);
  if (date < api.today() || date > end) throw invalid('只能细化当前滚动窗口内的日期', { field: 'date', start: api.today(), end });
  if (!Array.isArray(payload.items)) throw invalid('refine 需要当天 items 数组', { field: 'items' });
  const onDate = item => item.blocks?.length ? item.blocks.some(block => block.date === date) : item.date === date;
  const byId = new Map(live.items.map(item => [item.id, item]));
  const patches = new Map();
  for (const item of payload.items) {
    if (!isPlainObject(item)) throw invalid('细化任务必须是对象', { field: 'items' });
    const previous = byId.get(item.id);
    if (previous && !onDate(previous) || !previous && item.date !== date
      || previous && item.date !== date && item.date !== previous.date) {
      throw invalid('细化只能修改指定日期，不能移动其他日期的任务', { field: 'items', date });
    }
    if (item.blocks !== undefined && !Array.isArray(item.blocks)) throw invalid('细化时间块必须是数组', { field: 'items.blocks' });
    const otherBlocks = previous?.blocks?.filter(block => block.date !== date) ?? [];
    for (const block of item.blocks ?? []) {
      if (block.date === date) continue;
      const unchanged = otherBlocks.some(old => old.id === block.id && old.date === block.date && old.start === block.start && old.end === block.end);
      if (!unchanged) throw invalid('细化不能修改其他日期的时间块', { field: 'items.blocks', date });
    }
    const id = item.id ?? `item_${randomUUID()}`;
    if (patches.has(id)) throw invalid('细化任务 ID 重复', { field: 'items.id', itemId: id });
    let blocks = item.blocks === undefined ? previous?.blocks?.filter(block => block.date === date) : item.blocks.filter(block => block.date === date);
    if (otherBlocks.length || blocks !== undefined) blocks = [...otherBlocks, ...(blocks ?? [])].sort((a,b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    patches.set(id, { ...previous, ...item, id, date: blocks?.[0]?.date ?? date,
      ...(blocks === undefined ? {} : { blocks }),
      ...(blocks?.length ? { start: blocks[0].start, end: blocks[0].end } : {}) });
  }
  const items = live.items.flatMap(item => {
    if (patches.has(item.id)) { const patch = patches.get(item.id); patches.delete(item.id); return [patch]; }
    if (!onDate(item)) return [item];
    const otherBlocks = item.blocks?.filter(block => block.date !== date) ?? [];
    return otherBlocks.length ? [{ ...item, blocks: otherBlocks, date: otherBlocks[0].date, start: otherBlocks[0].start, end: otherBlocks[0].end }] : [];
  });
  const content = normalizePlanContent({ ...live, items: [...items, ...patches.values()],
    trial: payload.trial ?? live.trial }, api, { applied: live, draft: null, planRow: row });
  content.refinedDates = [...new Set([...(live.refinedDates ?? []), date])].sort();
  const capacity = analyzePlan(api.db, content, api.today(), row.id);
  requireDependencyOrder(capacity, '细化');
  if (capacity.requiresTrial && !content.trial) throw invalid('细化后的安排存在容量或期限风险，请显式确认试行', { reason: 'trial_required', capacity });
  const reason = optionalText(payload.reason, 'reason', { max: 500 }) ?? `细化 ${date}`;
  const result = appendRevision(api, row, { data: content, priorData: live, action: 'refine', reason, actor: api.actor });
  api.change({ entity: 'plan', entityId: row.id, action: 'refine', before: { revision: Number(row.revision) }, after: { revision: result.number, date }, reason });
  return { plan: planView(api.db, result.freshRow), revision: revisionView(result.revisionRow, { includeData: true }), changes: result.diff, capacity, refinement: { date, needed: false } };
}

function undoRevision(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const planRow = latestPlanRow(api.db, planId, payload.goalId);
  if (planRow === null) throw invalid('还没有正式计划，无法撤销', { field: 'planId', reason: 'no_plan' });
  try {
    requireBaseRevision(payload, Number(planRow.revision));
  } catch (error) {
    if (error instanceof StudyError && error.code === 'conflict') staleConflict(api.db, planRow, payload.baseRevision, api.today());
    throw error;
  }
  const applied = appliedRevisionRow(api.db, planRow.id);
  if (applied === undefined) throw invalid('计划还没有可撤销的修订', { field: 'planId', reason: 'no_applied_revision' });
  if (applied.action === 'replace_task') {
    throw new StudyError('conflict', '最近的修订替代了任务；请通过显式替代操作调整，避免把旧任务与新任务的进度混在一起', {
      reason: 'replacement_requires_explicit_action', action: 'tasks.replaceTask', revision: Number(applied.number),
    });
  }
  requireDraftAcknowledgement(api.db, planRow, payload, '撤销修订', api.today());
  const targetNumber = optionalInteger(payload.revisionNumber, 'revisionNumber', { min: 1, max: 1_000_000 })
    ?? Number(applied.number);
  if (targetNumber !== Number(applied.number)) {
    throw invalid(`只能撤销最近一次修订（${applied.number}）`, { field: 'revisionNumber', reason: 'undo_not_latest', latest: Number(applied.number) });
  }
  const previous = api.db.get(
    'SELECT * FROM study_plan_revision WHERE plan_id = ? AND number = ?',
    planRow.id,
    Number(applied.number) - 1,
  );
  const currentData = dataOfRow(applied, '计划修订');
  const restored = previous === undefined
    ? { ...emptyPlanData(String(planRow.title), currentData.goalId), title: currentData.title }
    : dataOfRow(previous, '计划修订');
  const reason = optionalText(payload.reason, 'reason', { max: 500 }) ?? `撤销修订 ${applied.number}`;
  const number = Number(planRow.revision) + 1;
  const now = api.now().toISOString();
  const revisionId = `rev_${randomUUID()}`;
  materialize(api, planRow.id, restored, number);
  const diff = diffPlans(currentData, restored, Number(planRow.revision), number);
  api.db.run("UPDATE study_plan_revision SET status = 'undone', undone_by = ? WHERE id = ?", number, applied.id);
  api.db.run(
    `INSERT INTO study_plan_revision
       (id, plan_id, number, status, action, reason, actor, snapshot_json, diff_json, undone_by, created_at, applied_at)
     VALUES (?, ?, ?, 'applied', 'undo', ?, ?, ?, ?, NULL, ?, ?)`,
    revisionId, planRow.id, number, reason, api.actor, JSON.stringify(restored), JSON.stringify(diff), now, now,
  );
  const status = restored.trial ? 'trial' : 'active';
  api.db.run(
    'UPDATE study_plan SET goal_id = ?, title = ?, status = ?, revision = ?, revision_id = ?, updated_at = ? WHERE id = ?',
    restored.goalId, restored.title, status, number, revisionId, now, planRow.id,
  );
  api.db.run('DELETE FROM study_plan_draft WHERE plan_id = ?', planRow.id);
  api.change({
    entity: 'plan',
    entityId: String(planRow.id),
    action: 'undo',
    before: { revision: Number(applied.number), reason: applied.reason },
    after: { revision: number, restoredFrom: previous === undefined ? 0 : Number(previous.number), diff },
    reason,
  });
  const freshRow = planRowById(api.db, planRow.id);
  const freshRevision = api.db.get('SELECT * FROM study_plan_revision WHERE id = ?', revisionId);
  return {
    plan: planView(api.db, freshRow),
    revision: revisionView(freshRevision, { includeData: true }),
    changes: diff,
    undone: { number: Number(applied.number), status: 'undone', reason: applied.reason === null ? null : String(applied.reason) },
  };
}

function recordProgress(payload, api) {
  const planId = optionalText(payload.planId, 'planId', { max: 64 });
  const planRow = latestPlanRow(api.db, planId, payload.goalId);
  if (planRow === null) throw invalid('还没有正式计划，无法记录进度', { field: 'planId', reason: 'no_active_plan' });
  const applied = appliedRevisionRow(api.db, planRow.id);
  if (applied === undefined) throw invalid('计划尚未确认，确认后才能记录进度', { field: 'planId', reason: 'plan_not_confirmed' });
  const data = dataOfRow(applied, '计划修订');
  const itemId = requireText(payload.itemId, 'itemId', { max: 64 });
  const item = data.items.find(entry => entry.id === itemId);
  if (item === undefined) throw new StudyError('not_found', `计划中没有任务 ${itemId}`, { planId: String(planRow.id), itemId });
  const link = api.db.get('SELECT task_id FROM study_plan_task WHERE plan_id = ? AND item_id = ?', planRow.id, itemId);
  const result = taskRecordProgress({ ...payload, taskId: link?.task_id ?? item.taskId }, api);
  const raw = { ...api.db.get('SELECT * FROM study_task_progress WHERE id = ?', result.record.recordId),
    plan_id: planRow.id, revision: Number(applied.number), item_id: itemId };
  return { planId: planRow.id, revision: Number(applied.number), itemId, ...result,
    record: progressRecordView(raw), progress: progressOf(raw) };

}

// ---------------------------------------------------------------------------
// Revision diff
// ---------------------------------------------------------------------------

/** Item fields whose change counts as a plan change. */
const DIFF_FIELDS = ['title', 'subject', 'materialId', 'locator', 'estimateMinutes', 'workload', 'date', 'start', 'end', 'flexible', 'completion', 'dependencies', 'note', 'projectId'];
const PROJECT_DIFF_FIELDS = ['title', 'kind', 'materialId', 'target', 'note'];

function diffPlans(before, after, baseRevision, revision) {
  const beforeItems = before?.items ?? [];
  const afterItems = after?.items ?? [];
  const beforeMap = new Map(beforeItems.map(item => [item.id, item]));
  const afterMap = new Map(afterItems.map(item => [item.id, item]));
  const added = afterItems.filter(item => !beforeMap.has(item.id)).map(slimItem);
  const removed = beforeItems.filter(item => !afterMap.has(item.id)).map(slimItem);
  const changed = [];
  for (const item of afterItems) {
    const previous = beforeMap.get(item.id);
    if (previous === undefined) continue;
    const fields = DIFF_FIELDS.filter(field => canonicalJson(previous[field]) !== canonicalJson(item[field]));
    if (fields.length > 0) changed.push({ id: item.id, title: item.title, fields });
  }
  const beforeTotals = totalsOf(before);
  const afterTotals = totalsOf(after);
  const projectChanges = diffProjects(before?.projects, after.projects);
  return {
    baseRevision,
    revision,
    added,
    removed,
    changed,
    projects: projectChanges,
    projectsChanged: projectChanges.added.length + projectChanges.removed.length + projectChanges.changed.length > 0,
    titleChanged: (before?.title ?? null) !== after.title,
    goalChanged: (before?.goalId ?? null) !== after.goalId,
    trialChanged: (before?.trial ?? false) !== after.trial,
    goalsChanged: canonicalJson({ stageGoals: before?.stageGoals ?? null, weekGoals: before?.weekGoals ?? null })
      !== canonicalJson({ stageGoals: after.stageGoals, weekGoals: after.weekGoals }),
    availabilityChanged: canonicalJson(before?.availability ?? null) !== canonicalJson(after.availability),
    unscheduledChanged: beforeTotals.unscheduled !== afterTotals.unscheduled,
    totals: {
      beforeItems: beforeTotals.items,
      afterItems: afterTotals.items,
      beforeMinutes: beforeTotals.minutes,
      afterMinutes: afterTotals.minutes,
      beforeUnscheduled: beforeTotals.unscheduled,
      afterUnscheduled: afterTotals.unscheduled,
    },
    summary: `新增 ${added.length} 项、调整 ${changed.length} 项、移除 ${removed.length} 项`
      + (afterTotals.unscheduled > 0 ? `；仍有 ${afterTotals.unscheduled} 项未安排` : ''),
  };
}

function slimItem(item) {
  return { id: item.id, title: item.title, date: item.date, projectId: item.projectId ?? null, estimateMinutes: item.estimateMinutes };
}

/** Added, removed and changed projects between two plan documents. */
function diffProjects(before, after) {
  const beforeProjects = Array.isArray(before) ? before : [];
  const afterProjects = Array.isArray(after) ? after : [];
  const beforeById = new Map(beforeProjects.map(project => [project.id, project]));
  const afterById = new Map(afterProjects.map(project => [project.id, project]));
  const added = afterProjects.filter(project => !beforeById.has(project.id)).map(slimProject);
  const removed = beforeProjects.filter(project => !afterById.has(project.id)).map(slimProject);
  const changed = [];
  for (const project of afterProjects) {
    const previous = beforeById.get(project.id);
    if (previous === undefined) continue;
    const fields = PROJECT_DIFF_FIELDS.filter(field => canonicalJson(previous[field]) !== canonicalJson(project[field]));
    if (fields.length > 0) changed.push({ id: project.id, title: project.title, fields });
  }
  return { added, removed, changed };
}

function slimProject(project) {
  return { id: project.id, title: project.title, kind: project.kind };
}

function totalsOf(data) {
  const items = data?.items ?? [];
  return {
    items: items.length,
    minutes: items.reduce((sum, item) => sum + item.estimateMinutes, 0),
    scheduled: items.filter(item => item.date !== null).length,
    unscheduled: items.filter(item => item.date === null).length,
  };
}

/** The minimum document an undo restores when the first revision is undone. */
function emptyPlanData(title, goalId) {
  return {
    title,
    goalId,
    trial: false,
    reviewAt: null,
    projects: [],
    stageGoals: [],
    weekGoals: [],
    availability: [],
    constraints: [],
    assumptions: [],
    items: [],
  };
}

// ---------------------------------------------------------------------------
// Dates and review points
// ---------------------------------------------------------------------------

function parseDateText(text) {
  const [year, month, day] = text.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

function formatDate(date) {
  return localDate(date);
}

function addDaysToDate(text, days) {
  const date = parseDateText(text);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

function weekStartOfDate(text) {
  const date = parseDateText(text);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return formatDate(date);
}

function defaultReviewAt(api, goalId) {
  const candidate = addDaysToDate(api.today(), 7);
  if (goalId !== null) {
    const goal = api.db.get('SELECT deadline FROM study_goal WHERE id = ?', goalId);
    if (goal !== undefined && goal.deadline !== null && String(goal.deadline) < candidate) {
      return String(goal.deadline) < api.today() ? api.today() : String(goal.deadline);
    }
  }
  return candidate;
}

function requireDraftRevision(api, planRow, draft, payload) {
  const current = Number(draft?.revision ?? 0);
  if (!Number.isSafeInteger(payload.expectedDraftRevision) || payload.expectedDraftRevision < 0) {
    throw invalid('缺少 expectedDraftRevision；请读取最新草案版本', { field: 'expectedDraftRevision', draftRevision: current });
  }
  if (payload.expectedDraftRevision !== current) {
    throw new StudyError('conflict', `草案已更新到版本 ${current}，请重新读取`, {
      draftRevision: current, latest: planRow ? planDetail(api.db, planRow.id, api.today()) : null,
      diff: diffPlans(payload, draft ? dataOfRow(draft, 'draft') : emptyPlanData('', null), 0, current),
    });
  }
}
