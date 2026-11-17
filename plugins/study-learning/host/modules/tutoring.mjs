import { toolRequestId } from '../../../../packages/study-contracts/index.mjs';
/**
 * Task tutoring context: links one conversation to one study task and injects
 * the task, the traceable material snippets, and the latest formal plan as a
 * model-visible context message.
 *
 * The context is built only from the study service (`tasks`, `materials`,
 * `plans`). It never reads the conversation log, so a long chat is not copied
 * into a new session and old statements cannot masquerade as current facts.
 * The injected message declares the producer-owned message source kind
 * `study-tutoring`; DSH records it through `agent.inject()`, the same durable
 * path every other plugin context uses.
 *
 * One session links to at most one task. Re-opening the same task does not
 * inject twice; changed facts are offered as `stale` until the caller asks
 * `refresh: true`. A session without a link is untouched, so free chat keeps
 * working exactly as before. A link is durable: the same task does not inject
 * again after a restart, and a link created while the session is unloaded is
 * flushed when that Agent is created.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyError, isPlainObject } from '../../../../packages/study-contracts/index.mjs';

/** Module id; matches the `tutoring` service namespace. */
export const id = 'tutoring';

/** The brief reads the task, its material index, and the latest formal plan. */
export const deps = ['tasks', 'materials', 'plans'];

/** Schema version of the association table. */
export const schemaVersion = 1;

/** Producer-owned message source kind of an injected tutoring context. */
export const sourceKind = 'study-tutoring';

/** Tables owned by this module. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS study_tutoring_link (
    session_id   TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    digest       TEXT NOT NULL,
    injected_at  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_tutoring_link_task ON study_tutoring_link (task_id, updated_at)',
];

const WRITE_METHODS = ['open', 'flush', 'close'];
const OPEN_KEYS = new Set(['taskId', 'sessionId', 'refresh']);
const SESSION_KEYS = new Set(['sessionId']);
const BRIEF_KEYS = new Set(['taskId']);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MATERIAL_HITS = 3;
const MAX_MATERIAL_QUERIES = 12;
const MAX_PLAN_ITEMS = 4;
const MAX_SNIPPET_CHARS = 240;
const MAX_CONTEXT_CHARS = 2400;
const MAX_QUERY_CHARS = 200;
const PLAN_ITEM_KEYS = ['id', 'title', 'subject', 'date', 'start', 'end', 'estimateMinutes', 'flexible', 'note'];

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { defineTool } = requireFromSource(join(sourceDirectory, 'packages/core/tools/lib/index.js'));
const { createUserMessage } = requireFromSource(join(sourceDirectory, 'packages/llm/llm/lib/index.js'));

/**
 * Register the `tutoring` service, its pending-context listener, and its Agent
 * tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study`, `tools` and the optional `agents`.
 * @param {{ database: { get: Function } }} kernel - Kernel handle; the listener only reads it.
 */
export function apply(ctx, kernel) {
  ctx.effect(() => ctx.study.register('tutoring', {
    methods: {
      open: (payload, api) => openLink(ctx, payload, api),
      flush: (payload, api) => flushLink(ctx, payload, api),
      close: (payload, api) => closeLink(payload, api),
      brief: (payload, api) => briefOfTask(ctx, payload, api),
      context: (payload, api) => contextOfSession(ctx, payload, api),
    },
    writes: WRITE_METHODS,
  }), 'study: tutoring namespace');

  // A link may be created before its session is loaded (for example while a
  // client prepares a new conversation). Inject when that Agent appears.
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    let row;
    try {
      row = kernel.database.get('SELECT injected_at FROM study_tutoring_link WHERE session_id = ?', sessionId);
    } catch (error) {
      console.warn(`[study] tutoring link was not read for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (row === undefined || row.injected_at !== null) return;
    ctx.study.call('tutoring', 'flush', { sessionId }, { actor: 'system', requestId: `tutoring:flush:${sessionId}` }).then(result => {
      if (result.ok !== true) {
        console.warn(`[study] pending tutoring context was not injected for ${sessionId}: ${result.message}`);
      }
    }, error => {
      console.warn(`[study] pending tutoring context was not injected for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }), 'study: tutoring pending context');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_tutoring',
    description: '任务答疑上下文：把学生正在做的任务、可核对的资料片段和最新正式计划带入当前对话。'
      + '上下文只来自学习服务的最新事实，不复制旧聊天；同一任务在同一会话里只注入一次。'
      + '打开（open）后模型会收到一条上下文消息；资料不足或页码、题号无法确认时会明确列出，不要替学生补全。',
    parameters: {
      requestId: { type: 'string', description: 'Stable operation ID; defaults to executor callId.' },
      action: {
        type: 'string',
        required: true,
        enum: ['open', 'context', 'close'],
        description: 'open 关联任务并带入上下文；context 读取当前会话的关联；close 解除关联（不改已有聊天记录）。',
      },
      taskId: { type: 'string', description: '任务 ID；open 时必填。' },
      refresh: { type: 'boolean', description: 'open 时任务、资料或计划已更新，是否刷新已注入的上下文（默认不重复注入）。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const sessionId = exec.agent?.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('当前对话没有可关联的会话，无法带入任务答疑上下文。');
      }
      const action = args.action;
      if (action === 'open' && (typeof args.taskId !== 'string' || args.taskId.trim().length === 0)) {
        throw new Error('open 需要 taskId（任务 ID）。');
      }
      const payload = action === 'open'
        ? { taskId: args.taskId, sessionId, ...(args.refresh === undefined ? {} : { refresh: args.refresh }) }
        : { sessionId };
      const result = await ctx.study.call('tutoring', action, payload, { actor: 'agent', requestId: action === 'context' ? undefined : toolRequestId(args, exec) });
      if (result.ok !== true) {
        throw new Error(`任务答疑上下文操作失败（${result.code}）：${result.message}`);
      }
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '任务答疑上下文' }),
  })), 'study: tutoring tool');
}

/* --------------------------------------------------------------------- writes */

/**
 * Link one session to one task and inject the brief when the session is live.
 * Repeated open calls with the same facts are idempotent; changed facts are
 * reported as stale until `refresh: true`.
 * @param {object} ctx - Plugin context.
 * @param {object} payload - `{ taskId, sessionId, refresh? }`.
 * @param {object} api - Kernel call API.
 * @returns {Promise<object>} Association and injection outcome.
 */
async function openLink(ctx, payload, api) {
  assertPayload(payload, OPEN_KEYS, 'open');
  const taskId = requireText(payload.taskId, 'taskId', 64);
  const sessionId = requireSessionId(payload.sessionId);
  const refresh = optionalBoolean(payload.refresh, 'refresh') ?? false;
  const task = await readActiveTask(ctx, taskId);
  const brief = await composeBrief(ctx, task, api);
  const existing = api.db.get('SELECT * FROM study_tutoring_link WHERE session_id = ?', sessionId);
  const agent = liveAgent(ctx, sessionId);
  const now = api.now().toISOString();
  const previousTaskId = existing === undefined ? null : String(existing.task_id);
  let status;
  let shouldInject = false;
  let changed = false;

  if (existing === undefined) {
    insertLink(api.db, { sessionId, taskId, digest: brief.digest, now });
    changed = true;
    shouldInject = agent !== undefined;
    status = shouldInject ? 'injected' : 'pending';
  } else if (String(existing.task_id) === taskId) {
    if (String(existing.digest) === brief.digest) {
      if (existing.injected_at !== null) {
        status = 'already_injected';
      } else if (agent !== undefined) {
        shouldInject = true;
        status = 'injected';
      } else {
        status = 'pending';
      }
    } else if (!refresh) {
      status = 'stale';
    } else {
      updateLink(api.db, { sessionId, taskId, digest: brief.digest, now });
      changed = true;
      shouldInject = agent !== undefined;
      status = shouldInject ? 'refreshed' : 'pending';
    }
  } else {
    updateLink(api.db, { sessionId, taskId, digest: brief.digest, now });
    changed = true;
    shouldInject = agent !== undefined;
    status = shouldInject ? 'injected' : 'pending';
  }

  if (shouldInject) {
    injectBrief(agent, taskId, brief);
    markInjected(api.db, sessionId, brief.digest, now);
    changed = true;
  }

  if (changed) {
    api.change({
      entity: 'tutoring_link',
      entityId: sessionId,
      action: shouldInject ? 'inject' : 'link',
      before: existing === undefined ? null : {
        taskId: previousTaskId,
        digest: String(existing.digest),
        injectedAt: existing.injected_at,
      },
      after: { taskId, digest: brief.digest, injected: shouldInject, status },
      reason: previousTaskId !== null && previousTaskId !== taskId
        ? '切换到另一个任务并带入答疑上下文'
        : '带入任务答疑上下文',
    });
  }

  return {
    status,
    injected: shouldInject,
    changedTask: previousTaskId !== null && previousTaskId !== taskId,
    previousTaskId,
    sessionId,
    task,
    brief,
    digest: brief.digest,
    sourceKind,
    injectedAt: shouldInject ? now : (existing?.injected_at ?? null),
  };
}

/**
 * Inject a previously linked but not yet injected context after its session
 * became live. No-op when the link is absent or already injected.
 * @param {object} ctx - Plugin context.
 * @param {object} payload - `{ sessionId }`.
 * @param {object} api - Kernel call API.
 * @returns {Promise<object>} Injection outcome.
 */
async function flushLink(ctx, payload, api) {
  assertPayload(payload, SESSION_KEYS, 'flush');
  const sessionId = requireSessionId(payload.sessionId);
  const row = api.db.get('SELECT * FROM study_tutoring_link WHERE session_id = ?', sessionId);
  if (row === undefined) return { status: 'no_link', injected: false, sessionId, task: null };
  if (row.injected_at !== null) {
    return {
      status: 'already_injected',
      injected: false,
      sessionId,
      taskId: String(row.task_id),
      task: null,
      injectedAt: String(row.injected_at),
    };
  }
  const agent = liveAgent(ctx, sessionId);
  if (agent === undefined) {
    return { status: 'pending', injected: false, sessionId, taskId: String(row.task_id), task: null };
  }
  const taskId = String(row.task_id);
  const task = await readActiveTask(ctx, taskId);
  const brief = await composeBrief(ctx, task, api);
  const now = api.now().toISOString();
  injectBrief(agent, taskId, brief);
  markInjected(api.db, sessionId, brief.digest, now);
  api.change({
    entity: 'tutoring_link',
    entityId: sessionId,
    action: 'inject',
    before: { taskId, digest: String(row.digest), injectedAt: null },
    after: { taskId, digest: brief.digest, injected: true, status: 'injected' },
    reason: '会话打开后补齐待注入的答疑上下文',
  });
  return {
    status: 'injected',
    injected: true,
    sessionId,
    task,
    brief,
    digest: brief.digest,
    sourceKind,
    injectedAt: now,
  };
}

/**
 * Remove the task association of one session. The message already in the
 * conversation log is immutable history and stays; only future lookups stop.
 * @param {object} payload - `{ sessionId }`.
 * @param {object} api - Kernel call API.
 * @returns {object} Close outcome.
 */
function closeLink(payload, api) {
  assertPayload(payload, SESSION_KEYS, 'close');
  const sessionId = requireSessionId(payload.sessionId);
  const row = api.db.get('SELECT * FROM study_tutoring_link WHERE session_id = ?', sessionId);
  if (row === undefined) return { closed: false, sessionId, taskId: null };
  api.db.run('DELETE FROM study_tutoring_link WHERE session_id = ?', sessionId);
  const taskId = String(row.task_id);
  api.change({
    entity: 'tutoring_link',
    entityId: sessionId,
    action: 'close',
    before: { taskId, digest: String(row.digest), injectedAt: row.injected_at },
    after: null,
    reason: '解除任务与会话的答疑关联',
  });
  return { closed: true, sessionId, taskId };
}

/* ---------------------------------------------------------------------- reads */

/**
 * Build the fresh brief for one task without touching any session.
 * @param {object} ctx - Plugin context.
 * @param {object} payload - `{ taskId }`.
 * @param {object} api - Kernel call API.
 * @returns {Promise<object>} Brief, including its model-facing text.
 */
async function briefOfTask(ctx, payload, api) {
  assertPayload(payload, BRIEF_KEYS, 'brief');
  const taskId = requireText(payload.taskId, 'taskId', 64);
  const task = await readActiveTask(ctx, taskId);
  return await composeBrief(ctx, task, api);
}

/**
 * Read one session's association and whether its injected brief is still the
 * latest computed one.
 * @param {object} ctx - Plugin context.
 * @param {object} payload - `{ sessionId }`.
 * @param {object} api - Kernel call API.
 * @returns {Promise<object>} Association, task and freshness.
 */
async function contextOfSession(ctx, payload, api) {
  assertPayload(payload, SESSION_KEYS, 'context');
  const sessionId = requireSessionId(payload.sessionId);
  const row = api.db.get('SELECT * FROM study_tutoring_link WHERE session_id = ?', sessionId);
  if (row === undefined) {
    return { status: 'no_link', sessionId, task: null, brief: null, stale: false, link: null };
  }
  const link = {
    taskId: String(row.task_id),
    digest: String(row.digest),
    injectedAt: row.injected_at === null ? null : String(row.injected_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  const taskEnvelope = await ctx.study.call('tasks', 'getTask', { id: link.taskId });
  if (taskEnvelope.ok !== true) {
    throw toStudyError(taskEnvelope, `读取任务 ${link.taskId}`);
  }
  const task = taskEnvelope.value.task;
  if (task.deletedAt !== null) {
    return { status: 'linked', sessionId, task, brief: null, stale: true, link };
  }
  const brief = await composeBrief(ctx, task, api);
  return { status: 'linked', sessionId, task, brief, stale: brief.digest !== link.digest, link };
}

/* -------------------------------------------------------------------- brief */

/**
 * Compose the task-centered brief from the three owning services. A failed
 * material or plan read stays visible in the brief; it never turns into "no
 * material exists".
 * @param {object} ctx - Plugin context.
 * @param {object} task - Active task view from `tasks.getTask`.
 * @param {object} api - Kernel call API (clock and today).
 * @returns {Promise<object>} Brief with digest and rendered text.
 */
async function composeBrief(ctx, task, api) {
  const materials = await collectMaterials(ctx, task);
  const plan = await collectPlan(ctx, task, api);
  const generatedAt = api.now().toISOString();
  const content = { version: 1, task, materials, plan };
  const digest = createHash('sha256').update(canonicalJson(content)).digest('hex');
  return {
    version: 1,
    task,
    materials,
    plan,
    generatedAt,
    digest,
    sourceKind,
    text: renderBriefText({ task, materials, plan }),
  };
}

/**
 * Resolve the material reference of a task and retrieve a few traceable
 * snippets matching its title, subject, and completion criteria.
 * @param {object} ctx - Plugin context.
 * @param {object} task - Task view.
 * @returns {Promise<object>} Query, resolved material, hits, and any failure notice.
 */
async function collectMaterials(ctx, task) {
  const query = [task.title, task.subject, task.completionCriteria]
    .filter(value => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .slice(0, MAX_QUERY_CHARS);
  let material = null;
  if (typeof task.materialRef === 'string' && task.materialRef.trim().length > 0) {
    material = await resolveMaterialRef(ctx, task.materialRef.trim(), task.goalId);
  }
  const cues = materialSearchCues(task);
  if (cues.length === 0) {
    return { query, material, hits: [], notice: '任务没有可用于检索的标题或学科' };
  }
  const hits = [];
  const seen = new Set();
  const notices = [];
  for (const cue of cues) {
    if (hits.length >= MAX_MATERIAL_HITS) break;
    const envelope = await ctx.study.call('materials', 'search', {
      goalId: task.goalId,
      query: cue,
      limit: MAX_MATERIAL_HITS,
      ...(material === null ? {} : { materialId: material.id }),
    });
    if (envelope.ok !== true) {
      return {
        query,
        material,
        hits,
        error: { code: envelope.code, message: envelope.message },
        notice: '资料检索暂时失败；不要把资料缺失当成没有资料',
      };
    }
    if (typeof envelope.value.notice === 'string' && envelope.value.notice.length > 0) {
      notices.push(envelope.value.notice);
    }
    for (const hit of envelope.value.hits) {
      if (hits.length >= MAX_MATERIAL_HITS) break;
      if (seen.has(hit.chunkId)) continue;
      seen.add(hit.chunkId);
      hits.push({
        materialId: hit.materialId,
        chunkId: hit.chunkId,
        title: hit.title,
        citation: hit.citation,
        snippet: truncate(hit.snippet, MAX_SNIPPET_CHARS),
        locator: hit.locator,
        locatorSource: hit.locatorSource,
        unverified: hit.unverified,
        verification: hit.verification,
        matchedTerms: hit.matchedTerms,
      });
    }
  }
  return {
    query,
    material,
    hits,
    searchNotice: notices.length === 0 ? null : [...new Set(notices)].join('；'),
    notice: hits.length === 0 ? '没有找到相关资料片段' : null,
  };
}

/**
 * Build lexical search cues from the task title and subject. A full CJK phrase
 * often fails because the FTS phrase requires every bigram in order, so the
 * segments and bigrams are also tried; `第二章 导数习题` can still find
 * `第二章 导数` in a workbook.
 * @param {{ title: string, subject: string|null }} task - Task view.
 * @returns {string[]} Unique cues, most specific first.
 */
function materialSearchCues(task) {
  const cues = [];
  const add = value => {
    if (cues.length >= MAX_MATERIAL_QUERIES) return;
    const text = value.trim().slice(0, MAX_QUERY_CHARS);
    if (text.length >= 2 && !cues.includes(text)) cues.push(text);
  };
  const addText = text => {
    if (typeof text !== 'string' || text.trim().length === 0) return;
    add(text);
    for (const segment of text.split(/[\s，。；：、,.!?;:()（）《》【】\[\]—–]+/u)) add(segment);
    for (const run of text.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
      for (let index = 0; index + 1 < run.length; index += 1) add(run.slice(index, index + 2));
    }
  };
  addText(task.title);
  addText(task.subject);
  return cues;
}

/**
 * Resolve `task.materialRef` when it names a material id or an exact material
 * title. A free-text location such as "第3章 第2节" stays as a label.
 * @param {object} ctx - Plugin context.
 * @param {string} ref - Stored material reference.
 * @returns {Promise<{ id: string, title: string } | null>} Resolved material or null.
 */
async function resolveMaterialRef(ctx, ref, goalId) {
  if (ref.startsWith('mat_')) {
    const envelope = await ctx.study.call('materials', 'get', { materialId: ref });
    if (envelope.ok === true && envelope.value.material.deletedAt === null) {
      return { id: envelope.value.material.id, title: envelope.value.material.title };
    }
  }
  const listed = await ctx.study.call('materials', 'list', { goalId });
  if (listed.ok !== true) return null;
  const match = listed.value.materials.find(item => item.deletedAt === null && item.title === ref);
  return match === undefined ? null : { id: match.id, title: match.title };
}

/**
 * Select the latest formal plan and up to four relevant items: exact task-title
 * matches first, then other items scheduled for today. Drafts are never
 * presented as the formal plan.
 * @param {object} ctx - Plugin context.
 * @param {object} task - Task view.
 * @param {object} api - Kernel call API (`today()`).
 * @returns {Promise<object|null>} Plan summary, or a visible absence/failure record.
 */
async function collectPlan(ctx, task, api) {
  const envelope = await ctx.study.call('plans', 'get', { goalId: task.goalId });
  if (envelope.ok !== true) {
    return {
      available: false,
      applied: false,
      error: { code: envelope.code, message: envelope.message },
      notice: '最新计划暂时无法读取',
      items: [],
    };
  }
  const value = envelope.value;
  if (value.plan === null || value.plan === undefined) {
    return { available: false, applied: false, notice: '还没有任何学习计划', items: [] };
  }
  const summary = {
    available: true,
    applied: false,
    planId: value.plan.id,
    revision: value.plan.revision,
    status: value.plan.status,
    notice: value.notice ?? null,
    items: [],
  };
  if (value.applied === null || value.applied === undefined || value.applied.data === null) {
    return summary;
  }
  const allItems = Array.isArray(value.applied.data.items) ? value.applied.data.items : [];
  const title = normalizeText(task.title);
  const matching = allItems.filter(item => normalizeText(item.title) === title);
  const today = allItems.filter(item => item.date === api.today());
  const selected = [];
  const seen = new Set();
  for (const item of [...matching, ...today]) {
    if (selected.length >= MAX_PLAN_ITEMS) break;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    selected.push(Object.fromEntries(PLAN_ITEM_KEYS.map(key => [key, item[key] ?? null])));
  }
  return {
    ...summary,
    applied: true,
    title: value.plan.title,
    revision: value.applied.number,
    trial: value.applied.trial === true,
    reviewAt: value.applied.reviewAt ?? null,
    matchingItems: matching.length,
    todayItems: today.length,
    items: selected,
    notice: selected.length === 0 ? '计划里没有与这个任务直接匹配的安排' : null,
  };
}

/**
 * Render the complete model-facing context. The text is bounded; task and
 * material facts are listed before the plan so truncation keeps the most
 * specific evidence.
 * @param {{ task: object, materials: object, plan: object|null }} brief - Brief content.
 * @returns {string} Bounded context text.
 */
function renderBriefText({ task, materials, plan }) {
  const lines = [
    '【任务答疑上下文｜来自学习服务的最新事实，不是聊天副本】',
    `任务：${task.title}`,
  ];
  if (task.subject !== null) lines.push(`学科：${task.subject}`);
  if (task.completionCriteria !== null) lines.push(`完成条件：${task.completionCriteria}`);
  if (task.estimatedMinutes !== null) lines.push(`预计工作量：${task.estimatedMinutes} 分钟`);
  if (task.materialRef !== null) lines.push(`材料位置：${task.materialRef}`);
  if (materials.error !== undefined) {
    lines.push(`资料检索：暂时失败（${materials.error.message}）；不要假设没有相关资料。`);
  } else if (materials.hits.length === 0) {
    lines.push(`资料检索：${materials.notice ?? '没有找到相关片段'}`);
  } else {
    lines.push('相关资料（引用来自资料库，可核对）：');
    for (const hit of materials.hits) {
      const unverified = Array.isArray(hit.unverified) && hit.unverified.length > 0
        ? `；未核实：${hit.unverified.join('、')}`
        : '';
      lines.push(`- ${hit.citation}：${hit.snippet}${unverified}`);
    }
  }
  if (plan === null || plan.available !== true) {
    lines.push(`最新计划：${plan?.error?.message ?? plan?.notice ?? '还没有任何学习计划'}`);
  } else if (plan.applied !== true) {
    lines.push(`最新计划：${plan.notice ?? '计划尚未确认；草案不会改变今天的正式安排。'}`);
  } else {
    lines.push(`最新计划「${plan.title}」修订 ${plan.revision}${plan.trial ? '（试行）' : ''}：`);
    if (plan.items.length === 0) {
      lines.push(`- ${plan.notice ?? '没有与这个任务直接匹配的安排'}`);
    } else {
      for (const item of plan.items) {
        const when = item.date === null
          ? '未安排'
          : `${item.date}${item.start === null ? '' : ` ${item.start}–${item.end}`}`;
        lines.push(`- ${when} ${item.title}${item.estimateMinutes === null ? '' : `（${item.estimateMinutes} 分钟）`}`);
      }
    }
  }
  lines.push('只依据以上可核对事实解答。资料不足、页码或题号无法确认时请直接说明，不要替学生补全；需要更多原文时使用 study_materials 检索。');
  const text = lines.join('\n');
  return text.length <= MAX_CONTEXT_CHARS ? text : `${text.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
}

/* -------------------------------------------------------------------- helpers */

/** Append the association row with a not-yet-injected marker. */
function insertLink(database, { sessionId, taskId, digest, now }) {
  database.run(
    `INSERT INTO study_tutoring_link (session_id, task_id, digest, injected_at, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
    sessionId, taskId, digest, now, now,
  );
}

/** Replace the task and digest of an existing association and clear its injected marker. */
function updateLink(database, { sessionId, taskId, digest, now }) {
  database.run(
    'UPDATE study_tutoring_link SET task_id = ?, digest = ?, injected_at = NULL, updated_at = ? WHERE session_id = ?',
    taskId, digest, now, sessionId,
  );
}

/** Record a successful injection. */
function markInjected(database, sessionId, digest, now) {
  database.run(
    'UPDATE study_tutoring_link SET digest = ?, injected_at = ?, updated_at = ? WHERE session_id = ?',
    digest, now, now, sessionId,
  );
}

/**
 * Inject one context message through DSH's durable Agent inbox path.
 * @param {{ inject: Function }} agent - Live agent for the linked session.
 * @param {string} taskId - Task identity carried in the message source.
 * @param {{ text: string, digest: string }} brief - Rendered context and digest.
 */
function injectBrief(agent, taskId, brief) {
  if (agent === undefined || typeof agent.inject !== 'function') {
    throw new StudyError('unavailable', '当前会话还不可写入；任务关联已保留，会话加载后会补齐上下文', { taskId, reason: 'agent_unavailable' });
  }
  let message;
  try {
    message = createUserMessage({
      content: [{ type: 'text', text: brief.text }],
      source: { kind: sourceKind, taskId, digest: brief.digest },
    });
  } catch (error) {
    throw new StudyError('unavailable', `答疑上下文消息无法创建：${error instanceof Error ? error.message : String(error)}`, { taskId });
  }
  try {
    agent.inject(message);
  } catch (error) {
    throw new StudyError('unavailable', `答疑上下文注入失败：${error instanceof Error ? error.message : String(error)}`, {
      taskId,
      reason: 'inject_failed',
    });
  }
}

/** Read the live Agent for a session through the optional `agents` service. */
function liveAgent(ctx, sessionId) {
  const agents = ctx.get('agents');
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined;
  return agents.get(sessionId);
}

/** Read one active task, refusing a deleted one with an explicit failure. */
async function readActiveTask(ctx, taskId) {
  const envelope = await ctx.study.call('tasks', 'getTask', { id: taskId });
  if (envelope.ok !== true) throw toStudyError(envelope, `读取任务 ${taskId}`);
  const task = envelope.value.task;
  if (task.deletedAt !== null) {
    throw new StudyError('not_found', `任务 ${taskId} 已删除，不能带入答疑`, { taskId, deleted: true });
  }
  return task;
}

/** Convert a service envelope failure into a StudyError. */
function toStudyError(envelope, action) {
  return new StudyError(
    envelope.code ?? 'unavailable',
    `${action}失败：${envelope.message ?? '未知错误'}`,
    envelope.details ?? {},
  );
}

/** Reject unknown payload fields loudly; the context never accepts copied chat or plan bodies. */
function assertPayload(payload, allowed, method) {
  if (!isPlainObject(payload)) throw new StudyError('invalid', `${method} 的载荷必须是对象`);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new StudyError('invalid', `${method} 不接受字段 ${key}；答疑上下文只保存会话与任务的关联，不复制聊天内容或计划正文`, { field: key });
    }
  }
}

/** Require a non-empty bounded text field. */
function requireText(value, field, max) {
  if (typeof value !== 'string') throw new StudyError('invalid', `${field} 必须是字符串`, { field });
  const text = value.trim();
  if (text.length === 0) throw new StudyError('invalid', `${field} 不能为空`, { field });
  if (text.length > max) throw new StudyError('invalid', `${field} 不能超过 ${max} 个字符`, { field, max });
  return text;
}

/** Require a DSH session id shaped value. */
function requireSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value.trim())) {
    throw new StudyError('invalid', 'sessionId 必须是 1-128 个合法会话标识字符', { field: 'sessionId' });
  }
  return value.trim();
}

/** Read an optional boolean field. */
function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new StudyError('invalid', `${field} 必须是布尔值`, { field });
  return value;
}

/** Trim and collapse whitespace for case-insensitive title matching. */
function normalizeText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

/** Bound one text field with an ellipsis. */
function truncate(text, length) {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

/** Stable JSON text for hashing: object keys sorted, arrays preserved. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** Render a compact tool result for the model. */
function renderToolResult(value) {
  if (value === null || typeof value !== 'object') return '任务答疑上下文没有返回结果。';
  if (value.status === 'no_link') return '当前会话没有关联任何学习任务。';
  if (value.status === 'closed' || value.closed === true) {
    return `已解除任务关联${value.taskId === null || value.taskId === undefined ? '' : `（${value.taskId}）`}；已有聊天记录不变。`;
  }
  const title = value.task?.title ?? value.taskId ?? '该任务';
  switch (value.status) {
    case 'injected':
      return value.changedTask === true
        ? `已切换到任务《${title}》并带入最新的答疑上下文。`
        : `已带入任务《${title}》的答疑上下文（资料片段 ${value.brief?.materials?.hits?.length ?? 0} 条）；同一任务不会重复注入。`;
    case 'refreshed':
      return `已刷新任务《${title}》的答疑上下文。`;
    case 'pending':
      return `已记录任务《${title}》的关联；当前会话加载后会带入上下文。`;
    case 'already_injected':
      return `任务《${title}》的答疑上下文已经在当前会话里，不重复注入。`;
    case 'stale':
      return `任务《${title}》的任务、资料或计划已更新；需要刷新已注入的上下文时再调用 open 并传 refresh: true。`;
    case 'linked':
      return `当前会话关联任务《${title}》${value.stale === true ? '，但缓存上下文已过期' : '，上下文是最新的'}。`;
    default:
      return `任务答疑上下文：${value.status ?? 'ok'}。`;
  }
}
