/**
 * Plan creation context: links one conversation to one "Create plan" form
 * snapshot and injects the feature's instructions into that conversation's
 * first step.
 *
 * The client creates the session, calls `planning.start` with the form the
 * student filled in, and then opens the conversation. Before the first model
 * request, `agent/pre-step` claims the stored snapshot and appends it as a
 * durable `user/message` with the producer-owned source kind
 * `study-planning`. The instructions therefore reach the model in the same
 * step as the student's opening message, and the message is logged like every
 * other injected context.
 *
 * Only the form snapshot and the rendered prompt live here; plans stay in the
 * plans module. A session receives the context once: `claim` marks the row so
 * later steps and later turns never repeat it.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyError, isPlainObject } from '../../../../packages/study-contracts/index.mjs';

/** Module id; matches the `planning` service namespace. */
export const id = 'planning';

/** The snapshot reads the active goal and the imported materials. */
export const deps = ['materials'];

/** Schema version of the association table. */
export const schemaVersion = 1;

/** Producer-owned message source kind of the injected creation context. */
export const sourceKind = 'study-planning';

/** Tables owned by this module. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS study_planning_link (
    session_id   TEXT PRIMARY KEY,
    goal_id      TEXT,
    snapshot     TEXT NOT NULL,
    digest       TEXT NOT NULL,
    version      INTEGER NOT NULL,
    injected_at  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_planning_link_goal ON study_planning_link (goal_id, created_at)',
];

/** Prompt template version; bump when the instructions change materially. */
const PROMPT_VERSION = 2;

const WRITE_METHODS = ['start', 'claim', 'close'];
const START_KEYS = new Set(['sessionId', 'goalId', 'brief']);
const SESSION_KEYS = new Set(['sessionId']);
const BRIEF_KEYS = new Set(['planTitle', 'stageGoal', 'dailyMinutes', 'constraints', 'notes', 'materialIds']);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEXT = 2000;
const MAX_TITLE = 200;
const MAX_MATERIALS = 32;
const PROMPT_PLACEHOLDER = '{{KNOWN_INFORMATION}}';

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { createUserMessage } = requireFromSource(join(sourceDirectory, 'packages/llm/llm/lib/index.js'));
const promptFile = fileURLToPath(new URL('../prompts/plan-creation.md', import.meta.url));

/**
 * Register the `planning` service and its first-step context injection.
 * The prompt template is read at load so a missing asset fails the plugin
 * load instead of every creation attempt.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study` and the `agent/pre-step` event.
 */
export async function apply(ctx) {
  const template = await readFile(promptFile, 'utf8');

  ctx.effect(() => ctx.study.register('planning', {
    methods: {
      start: (payload, api) => startLink(ctx, payload, api, template),
      pending: readPending,
      claim: claimLink,
      get: readLink,
      latest: readLatest,
      close: closeLink,
    },
    writes: WRITE_METHODS,
  }), 'study: planning namespace');

  ctx.effect(() => ctx.on('agent/pre-step', async (event, next) => {
    const decision = await next();
    if (decision === undefined || decision.kind !== 'enter') return decision;
    if (event.turn !== 1 || event.step !== 1) return decision;
    const sessionId = event.agent?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return decision;
    // Most sessions never start from this page: check with a read first so the
    // first step of an ordinary conversation does not commit a write.
    const pending = await ctx.study.call('planning', 'pending', { sessionId }, { actor: 'system' });
    if (pending.ok !== true) {
      console.warn(`[study] plan creation pending check failed for ${sessionId}: ${pending.message}`);
      return decision;
    }
    if (pending.value?.pending !== true) return decision;
    const result = await ctx.study.call('planning', 'claim', { sessionId }, {
      actor: 'system',
      requestId: `planning:claim:${sessionId}`,
    });
    if (result.ok !== true || result.value?.claimed !== true) return decision;
    let message;
    try {
      message = createUserMessage({
        content: [{ type: 'text', text: String(result.value.snapshot) }],
        source: { kind: sourceKind, form: 'instructions', version: Number(result.value.version) },
      });
    } catch (error) {
      console.warn(`[study] plan creation context was not built for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
    return { ...decision, messages: [...decision.messages, message] };
  }), 'study: plan creation context');
}

/* --------------------------------------------------------------------- writes */

/**
 * Store the form snapshot and the rendered instructions for one conversation.
 * Repeating the same form is idempotent; a link that has already been injected
 * is never rewritten, so a conversation keeps the instructions it started with.
 * @param {object} ctx - Plugin context.
 * @param {object} payload - `{ sessionId, goalId?, brief }`.
 * @param {object} api - Kernel call API.
 * @param {string} template - Loaded prompt template.
 * @returns {Promise<object>} Link status.
 */
async function startLink(ctx, payload, api, template) {
  assertPayload(payload, START_KEYS, 'start');
  const sessionId = requireSessionId(payload.sessionId);
  const goalId = optionalText(payload.goalId, 'goalId', { max: 64 });
  const brief = normalizeBrief(payload.brief);
  const context = await readContext(ctx, goalId);
  const composed = composeSnapshot(template, brief, goalId, context);
  const digest = createHash('sha256').update(`${PROMPT_VERSION}\n${composed.text}`).digest('hex');
  const now = api.now().toISOString();
  const existing = api.db.get('SELECT * FROM study_planning_link WHERE session_id = ?', sessionId);

  if (existing === undefined) {
    api.db.run(
      `INSERT INTO study_planning_link (session_id, goal_id, snapshot, digest, version, injected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      sessionId, composed.goalId, composed.text, digest, PROMPT_VERSION, now, now,
    );
    api.change({
      entity: 'planning_link',
      entityId: sessionId,
      action: 'link',
      after: { goalId: composed.goalId, digest, version: PROMPT_VERSION, chars: composed.text.length },
      reason: '创建计划：记录表单快照与提示词',
    });
    return { status: 'created', sessionId, goalId: composed.goalId, digest, version: PROMPT_VERSION, injected: false };
  }

  if (existing.injected_at !== null) {
    return {
      status: 'exists',
      sessionId,
      goalId: existing.goal_id === null ? null : String(existing.goal_id),
      digest: String(existing.digest),
      version: Number(existing.version),
      injected: true,
    };
  }

  if (String(existing.digest) === digest) {
    return {
      status: 'unchanged',
      sessionId,
      goalId: composed.goalId,
      digest,
      version: PROMPT_VERSION,
      injected: false,
    };
  }

  api.db.run(
    'UPDATE study_planning_link SET goal_id = ?, snapshot = ?, digest = ?, version = ?, updated_at = ? WHERE session_id = ?',
    composed.goalId, composed.text, digest, PROMPT_VERSION, now, sessionId,
  );
  api.change({
    entity: 'planning_link',
    entityId: sessionId,
    action: 'update',
    before: { goalId: existing.goal_id, digest: String(existing.digest), version: Number(existing.version) },
    after: { goalId: composed.goalId, digest, version: PROMPT_VERSION, chars: composed.text.length },
    reason: '创建计划：学生修改表单后刷新快照',
  });
  return { status: 'updated', sessionId, goalId: composed.goalId, digest, version: PROMPT_VERSION, injected: false };
}

/**
 * Claim the pending snapshot exactly once and return it for the first step.
 * A missing or already injected link returns `claimed: false`.
 * @param {object} payload - `{ sessionId }`.
 * @param {object} api - Kernel call API.
 * @returns {object} Claim result.
 */
function claimLink(payload, api) {
  assertPayload(payload, SESSION_KEYS, 'claim');
  const sessionId = requireSessionId(payload.sessionId);
  const row = api.db.get('SELECT * FROM study_planning_link WHERE session_id = ? AND injected_at IS NULL', sessionId);
  if (row === undefined) return { claimed: false, sessionId };
  const now = api.now().toISOString();
  api.db.run(
    'UPDATE study_planning_link SET injected_at = ?, updated_at = ? WHERE session_id = ?',
    now, now, sessionId,
  );
  api.change({
    entity: 'planning_link',
    entityId: sessionId,
    action: 'inject',
    before: { injectedAt: null, digest: String(row.digest) },
    after: { injectedAt: now, digest: String(row.digest), version: Number(row.version) },
    reason: '创建计划：第一轮带入表单快照与提示词',
  });
  return {
    claimed: true,
    sessionId,
    snapshot: String(row.snapshot),
    digest: String(row.digest),
    version: Number(row.version),
  };
}

/**
 * Remove one conversation's creation link. Messages already in the log stay.
 * @param {object} payload - `{ sessionId }`.
 * @param {object} api - Kernel call API.
 * @returns {object} Close result.
 */
function closeLink(payload, api) {
  assertPayload(payload, SESSION_KEYS, 'close');
  const sessionId = requireSessionId(payload.sessionId);
  const row = api.db.get('SELECT * FROM study_planning_link WHERE session_id = ?', sessionId);
  if (row === undefined) return { closed: false, sessionId };
  api.db.run('DELETE FROM study_planning_link WHERE session_id = ?', sessionId);
  api.change({
    entity: 'planning_link',
    entityId: sessionId,
    action: 'close',
    before: {
      goalId: row.goal_id,
      digest: String(row.digest),
      injectedAt: row.injected_at,
      version: Number(row.version),
    },
    after: null,
    reason: '创建计划：解除会话关联',
  });
  return { closed: true, sessionId };
}

/* ---------------------------------------------------------------------- reads */

/** Goal-scoped persistent conversation mapping; never reuses another goal's link. */
function readLatest(payload, api) {
  assertPayload(payload, new Set(['goalId']), 'latest');
  const explicit = optionalText(payload.goalId, 'goalId', { max: 64 });
  const goalId = explicit ?? api.db.get('SELECT id FROM study_goal WHERE active = 1 ORDER BY rowid DESC LIMIT 1')?.id;
  if (!goalId) return { link: null };
  const row = api.db.get('SELECT session_id FROM study_planning_link WHERE goal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', goalId);
  return row ? readLink({ sessionId: String(row.session_id) }, api) : { link: null };
}

/**
 * Report whether one conversation still has an unclaimed snapshot, without
 * writing anything. The first step of an ordinary conversation stays a read.
 * @param {object} payload - `{ sessionId }`.
 * @param {object} api - Kernel call API.
 * @returns {{ pending: boolean, sessionId: string }} Pending flag.
 */
function readPending(payload, api) {
  assertPayload(payload, SESSION_KEYS, 'pending');
  const sessionId = requireSessionId(payload.sessionId);
  const row = api.db.get('SELECT session_id FROM study_planning_link WHERE session_id = ? AND injected_at IS NULL', sessionId);
  return { pending: row !== undefined, sessionId };
}

/**
 * Read one conversation's link summary without its snapshot.
 * @param {object} payload - `{ sessionId }`.
 * @param {object} api - Kernel call API.
 * @returns {{ link: object | null }} Link summary.
 */
function readLink(payload, api) {
  assertPayload(payload, SESSION_KEYS, 'get');
  const sessionId = requireSessionId(payload.sessionId);
  const row = api.db.get('SELECT * FROM study_planning_link WHERE session_id = ?', sessionId);
  return {
    link: row === undefined ? null : {
      sessionId: String(row.session_id),
      goalId: row.goal_id === null ? null : String(row.goal_id),
      version: Number(row.version),
      injectedAt: row.injected_at === null ? null : String(row.injected_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      chars: String(row.snapshot).length,
    },
  };
}

/* ------------------------------------------------------------------- snapshot */

/**
 * Read the goal and materials the snapshot describes.
 * @param {object} ctx - Plugin context with `study`.
 * @param {string | null} goalId - Explicit goal, or null for the active one.
 * @returns {Promise<{ goal: object | null, materials: object[] }>} Context data.
 */
async function readContext(ctx, goalId) {
  let goal = null;
  try {
    const envelope = await ctx.study.call('materials', 'getGoal', goalId === null ? {} : { id: goalId }, { actor: 'internal' });
    if (envelope.ok === true) goal = envelope.value?.goal ?? null;
  } catch (error) {
    console.warn(`[study] planning context could not read the goal: ${error instanceof Error ? error.message : String(error)}`);
  }
  let materials = [];
  try {
    const envelope = await ctx.study.call('materials', 'list', {}, { actor: 'internal' });
    if (envelope.ok === true) materials = envelope.value?.materials ?? [];
  } catch (error) {
    console.warn(`[study] planning context could not read materials: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { goal, materials };
}

/**
 * Render the known-information block and splice it into the prompt template.
 * @param {string} template - Prompt template holding `{{KNOWN_INFORMATION}}`.
 * @param {object} brief - Normalized form snapshot.
 * @param {string | null} goalId - Goal the snapshot belongs to, if any.
 * @param {{ goal: object | null, materials: object[] }} context - Read goal and materials.
 * @returns {{ text: string, goalId: string | null }} Rendered snapshot and its goal.
 */
function composeSnapshot(template, brief, goalId, context) {
  const goal = context.goal;
  const resolvedGoalId = goal?.id ?? goalId ?? null;
  const selected = new Set(brief.materialIds);
  const chosen = context.materials.filter(material => selected.has(material.id));
  const dailyMinutes = brief.dailyMinutes ?? goal?.dailyMinutes ?? null;
  const lines = [
    '学生刚在「创建计划」页填写了下面的信息。未填写的项写「未填写」，不要当成已知，也不要替学生补全。',
    '',
    `- 考试/课程：${valueOrMissing(goal?.exam)}`,
    `- 考试年份：${goal?.examYear === null || goal?.examYear === undefined ? '未填写' : String(goal.examYear)}`,
    `- 考试日期：${valueOrMissing(goal?.deadline)}`,
    `- 每天可用分钟：${dailyMinutes === null ? '未填写' : String(dailyMinutes)}${brief.dailyMinutes !== null && brief.dailyMinutes !== undefined && goal?.dailyMinutes !== brief.dailyMinutes ? '（表单填写）' : ''}`,
    `- 计划标题：${valueOrMissing(brief.planTitle)}`,
    `- 阶段目标：${valueOrMissing(brief.stageGoal)}`,
    `- 固定安排/限制：${valueOrMissing(brief.constraints)}`,
    `- 备注：${valueOrMissing(brief.notes)}`,
    `- 已选材料：${chosen.length === 0 ? '未选择' : chosen.map(materialName).join('；')}`,
    `- 当前目标 ID：${resolvedGoalId ?? '未建立'}`,
  ];
  const known = lines.join('\n');
  const text = template.includes(PROMPT_PLACEHOLDER)
    ? template.replace(PROMPT_PLACEHOLDER, known)
    : `${known}\n\n${template}`;
  return { text, goalId: resolvedGoalId };
}

/** One material as a readable citation. */
function materialName(material) {
  const edition = material.edition === null || material.edition === undefined ? '' : `（${material.edition}）`;
  const chunks = Number.isSafeInteger(material.chunkCount) ? `，${material.chunkCount} 个片段` : '';
  return `《${material.title}》${edition}${chunks}`;
}

/** Render one optional value or its missing marker. */
function valueOrMissing(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '未填写';
}

/**
 * Normalize the optional brief fields; unknown keys are rejected so a typo does
 * not silently disappear.
 * @param {unknown} value - Raw `brief` payload.
 * @returns {{ planTitle: string | null, stageGoal: string | null, dailyMinutes: number | null,
 *   constraints: string | null, notes: string | null, materialIds: string[] }} Normalized brief.
 */
function normalizeBrief(value) {
  if (value === undefined || value === null) {
    return { planTitle: null, stageGoal: null, dailyMinutes: null, constraints: null, notes: null, materialIds: [] };
  }
  assertPayload(value, BRIEF_KEYS, 'brief');
  const materialIds = [];
  if (value.materialIds !== undefined) {
    if (!Array.isArray(value.materialIds)) throw new StudyError('invalid', 'materialIds 必须是数组', { field: 'materialIds' });
    for (const entry of value.materialIds) {
      const id = requireText(entry, 'materialIds', { max: 64 });
      if (!materialIds.includes(id)) materialIds.push(id);
    }
    if (materialIds.length > MAX_MATERIALS) {
      throw new StudyError('invalid', `materialIds 最多 ${MAX_MATERIALS} 项`, { field: 'materialIds', max: MAX_MATERIALS });
    }
  }
  return {
    planTitle: optionalText(value.planTitle, 'planTitle', { max: MAX_TITLE }),
    stageGoal: optionalText(value.stageGoal, 'stageGoal', { max: MAX_TEXT }),
    dailyMinutes: optionalInteger(value.dailyMinutes, 'dailyMinutes', { min: 0, max: 1440 }),
    constraints: optionalText(value.constraints, 'constraints', { max: MAX_TEXT }),
    notes: optionalText(value.notes, 'notes', { max: MAX_TEXT }),
    materialIds,
  };
}

/* --------------------------------------------------------------- validation */

/** Reject payload keys outside the method's contract. */
function assertPayload(payload, allowed, action) {
  if (!isPlainObject(payload)) throw new StudyError('invalid', `${action} 的载荷必须是 JSON 对象`);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new StudyError('invalid', `${action} 不接受字段 ${key}`, { field: key });
  }
}

/** Validate one session identity used as the link key. */
function requireSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new StudyError('invalid', 'sessionId 不合法', { field: 'sessionId' });
  }
  return value;
}

function requireText(value, field, { max = 64 } = {}) {
  if (typeof value !== 'string') throw new StudyError('invalid', `${field} 必须是字符串`, { field });
  const text = value.trim();
  if (text.length === 0) throw new StudyError('invalid', `${field} 不能为空`, { field });
  if (text.length > max) throw new StudyError('invalid', `${field} 不能超过 ${max} 个字符`, { field, max });
  return text;
}

function optionalText(value, field, options) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  return requireText(value, field, options);
}

function optionalInteger(value, field, { min, max }) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new StudyError('invalid', `${field} 必须是 ${min} 到 ${max} 之间的整数`, { field, min, max });
  }
  return value;
}
