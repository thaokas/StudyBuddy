/**
 * Learning module: the L0 evidence layer and L0.5 Q&A units.
 *
 * It captures every user-authored turn delivered to an Agent (injected study
 * messages are ignored), classifies it by rule, groups consecutive learning
 * turns of one conversation into a Q&A unit, extracts the problems the student
 * asked, records outcome signals, and detects the same problem being asked
 * again. Non-learning turns are stored for intent statistics but never open a
 * unit.
 *
 * Capture never blocks the conversation: the listener records a row in
 * `study_capture_gap` instead of throwing, and `(session_id, message_id)` plus
 * the kernel request id make a repeated delivery a replay, not a second turn.
 *
 * Every committed capture / merge / split emits `study/learning/changed` on a
 * deferred tick, so the memory module can recompute teaching traits without
 * joining the write transaction.
 *
 * S2 adds the 04:00 study-day windows on top of the same evidence: capture
 * ensures today's window, a ten-minute tick seals and summarizes finished
 * windows (rule summaries only, no model), and `merge`/`split` let the student
 * correct a unit boundary. Reads are exposed as `learning.list/get/stats`,
 * `windowStatus`, `summaries`, and the `study_questions` Agent tool.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveActiveGoal } from '../facts.mjs';
import { StudyError, isPlainObject } from '../registry.mjs';
import { classify, CLASSIFIER_VERSION, signalKinds } from '../learning/classify.mjs';
import {
  boundaryScore,
  decideBoundary,
  isNewProblemTurn,
  MAX_EPISODE_TURNS,
  MAX_GAP_MS,
} from '../learning/segment.mjs';
import { hashText, jaccard, normalize, sketch, sketchTokens, truncate } from '../learning/text.mjs';
import {
  closeEpisode,
  closeOpenEpisodes,
  countEpisodeRows,
  countEpisodeTurns,
  countProblems,
  createEpisode,
  deleteEpisodeTopics,
  deleteEpisodeTurns,
  episodeRow,
  episodeTopics,
  findTurn,
  insertEpisodeTopic,
  insertEpisodeTurn,
  insertGap,
  insertProblem,
  insertSignal,
  insertSplitEpisode,
  insertTurn,
  listEpisodeRows,
  markReasked,
  moveSignalsOfCorrection,
  moveSignalsOfEpisodes,
  nextTurnPosition,
  openEpisode,
  previousLearningTurn,
  problemsOfEpisode,
  reaskCandidates,
  sessionLink,
  setEpisodeMerged,
  setProblemOwner,
  setResolution,
  setResolutionOrNull,
  setTurnEpisode,
  signalsOfEpisode,
  statsData,
  touchEpisode,
  turnsOfEpisode,
  turnsWithTimeOfEpisode,
  updateProblemCount,
} from '../learning/repo.mjs';
import {
  ensureWindow,
  markSummaryStaleForEpisodes,
  openWindowForInstant,
  runWindowTick,
  sealWindowRow,
  TICK_INTERVAL_MS,
  windowStatusData,
} from '../learning/window.mjs';
import { summarizeWindowRow, summariesData } from '../learning/summary.mjs';
import { refreshTopics } from '../learning/topics.mjs';
import { methodSignals, weakTopics } from '../learning/analysis.mjs';
import { pruneTexts } from '../learning/prune.mjs';

/** Module id; matches the `learning` service namespace. */
export const id = 'learning';

/** Capture reads the task link; the window tables are S2's, so no window dependency. */
export const deps = ['tasks', 'tutoring'];

/** First layout of the evidence layer. */
export const schemaVersion = 1;

/** Tables owned by this module: eight L0/L0.5 tables plus three reserved for S2. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS study_turn (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    turn_no INTEGER,
    at TEXT NOT NULL,
    intent TEXT NOT NULL,
    is_learning INTEGER NOT NULL,
    subject TEXT,
    text TEXT,
    text_hash TEXT NOT NULL,
    text_pruned_at TEXT,
    attachments_json TEXT,
    task_id TEXT,
    material_ref TEXT,
    episode_id TEXT,
    classified_by TEXT NOT NULL,
    classifier_version TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, message_id)
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_turn_at ON study_turn (goal_id, at)',
  'CREATE INDEX IF NOT EXISTS study_turn_session ON study_turn (session_id, at)',

  `CREATE TABLE IF NOT EXISTS study_episode (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    subject TEXT,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    status TEXT NOT NULL,
    problem_count INTEGER NOT NULL DEFAULT 0,
    stuck_json TEXT,
    method_json TEXT,
    resolution TEXT,
    confidence REAL,
    summary TEXT,
    boundary_source TEXT NOT NULL,
    continuation_of TEXT,
    merged_into TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_episode_at ON study_episode (goal_id, opened_at)',

  `CREATE TABLE IF NOT EXISTS study_episode_problem (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    text TEXT,
    norm TEXT,
    hash TEXT NOT NULL,
    sketch TEXT NOT NULL,
    status TEXT NOT NULL,
    resolution TEXT,
    reasked_from TEXT,
    reask_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_problem_episode ON study_episode_problem (episode_id, position)',
  'CREATE INDEX IF NOT EXISTS study_problem_hash ON study_episode_problem (hash, created_at)',

  `CREATE TABLE IF NOT EXISTS study_episode_turn (
    episode_id TEXT NOT NULL,
    turn_id TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL,
    role TEXT NOT NULL,
    ambiguous INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (episode_id, position)
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS study_signal (
    id TEXT PRIMARY KEY,
    episode_id TEXT,
    problem_id TEXT,
    turn_id TEXT,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    value_json TEXT,
    source TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_signal_episode ON study_signal (episode_id, at)',

  `CREATE TABLE IF NOT EXISTS study_topic (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases_json TEXT,
    parent_id TEXT,
    material_ref TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS study_episode_topic (
    episode_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (episode_id, topic_id)
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS study_capture_gap (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT,
    reason TEXT NOT NULL,
    detail_json TEXT,
    at TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0
  ) STRICT`,

  // Reserved for S2: created here so the next increment adds no schema version.
  `CREATE TABLE IF NOT EXISTS study_window (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    status TEXT NOT NULL,
    cursor_json TEXT,
    summary_id TEXT,
    closed_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_window_range ON study_window (goal_id, start_at)',

  `CREATE TABLE IF NOT EXISTS study_window_summary (
    id TEXT PRIMARY KEY,
    window_id TEXT NOT NULL,
    level TEXT NOT NULL,
    text TEXT NOT NULL,
    data_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    model TEXT,
    prompt_version TEXT,
    superseded_by TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_summary_window ON study_window_summary (window_id, created_at)',

  `CREATE TABLE IF NOT EXISTS study_topic_thread (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
];

const WRITE_METHODS = Object.freeze([
  'capture', 'sealWindow', 'summarizeWindow', 'merge', 'split', 'refreshTopics', 'prune',
]);
const MAX_CAPTURE_TEXT = 20_000;
const MAX_ID = 200;
const MAX_ATTACHMENTS = 20;
const MAX_PROBLEM_CHARS = 500;
const MAX_PROBLEMS = 3;
const MAX_MERGE_UNITS = 20;
const REASK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const REASK_SKETCH_JACCARD = 0.8;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const DEFAULT_SUMMARY_LIMIT = 30;
const MAX_SUMMARY_LIMIT = 90;
const EPISODE_STATUSES = Object.freeze(['open', 'closed', 'enriched', 'merged']);
const EPISODE_RESOLUTIONS = Object.freeze(['understood', 'unresolved', 'unknown']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const CAPTURE_KEYS = new Set(['sessionId', 'messageId', 'turnNo', 'text', 'attachments']);
const LIST_KEYS = new Set(['from', 'to', 'subject', 'status', 'resolution', 'query', 'limit']);
const GET_KEYS = new Set(['id']);
const STATS_KEYS = new Set(['from', 'to']);
const EMPTY_KEYS = new Set();
const WINDOW_ID_KEYS = new Set(['id']);
const SUMMARIES_KEYS = new Set(['from', 'to', 'limit']);
const MERGE_KEYS = new Set(['episodeIds']);
const SPLIT_KEYS = new Set(['episodeId', 'atTurnId']);
const WEAK_TOPIC_KEYS = new Set(['limit']);
const EXPORT_KEYS = new Set(['from', 'to', 'goalId']);
const PRUNE_KEYS = new Set(['now']);
const INSIGHT_ACTIONS = Object.freeze(['weak_topics', 'method_signals', 'review_build', 'review_save', 'profile']);
const INSIGHT_KINDS = Object.freeze(['week', 'month']);

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { defineTool } = requireFromSource(join(sourceDirectory, 'packages/core/tools/lib/index.js'));

/**
 * Register the `learning` namespace, the inbox capture listener, and the
 * `study_questions` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study`, `tools`, and events.
 * @param {{ database: import('../db.mjs').StudyDatabase, status: Function }} kernel - Kernel handle.
 */
export function apply(ctx, kernel) {
  ctx.effect(() => ctx.study.register('learning', {
    methods: {
      capture: (payload, api) => {
        const result = capture(payload, api);
        if (result.status === 'created') {
          queueLearningChange(ctx, { kind: 'capture', episodeId: result.episodeId, turnId: result.turnId });
        }
        return result;
      },
      list: (payload, api) => listUnits(api.db, payload),
      get: (payload, api) => getUnit(api.db, payload),
      stats: (payload, api) => unitStats(api.db, payload),
      windowStatus: (payload, api) => {
        assertPayload(payload, EMPTY_KEYS, 'windowStatus');
        return windowStatusData(api.db, { goalId: resolveActiveGoal(api.db) ?? 'unassigned', now: api.now() });
      },
      sealWindow: (payload, api) => {
        assertPayload(payload, WINDOW_ID_KEYS, 'sealWindow');
        return sealWindowRow(api.db, { id: requireText(payload.id, 'id', MAX_ID), now: api.now() });
      },
      summarizeWindow: (payload, api) => {
        assertPayload(payload, WINDOW_ID_KEYS, 'summarizeWindow');
        return summarizeWindowRow(api.db, {
          id: requireText(payload.id, 'id', MAX_ID),
          now: api.now(),
          change: api.change,
        });
      },
      summaries: (payload, api) => {
        assertPayload(payload, SUMMARIES_KEYS, 'summaries');
        return summariesData(api.db, {
          from: normalizeBound(payload.from, 'from', false),
          to: normalizeBound(payload.to, 'to', true),
          limit: payload.limit === undefined
            ? DEFAULT_SUMMARY_LIMIT
            : requireInteger(payload.limit, 'limit', 1, MAX_SUMMARY_LIMIT),
        });
      },
      merge: (payload, api) => {
        const result = mergeUnits(api.db, payload, api);
        queueLearningChange(ctx, { kind: 'merge', episodeIds: [result.targetId, ...result.mergedIds] });
        return result;
      },
      split: (payload, api) => {
        const result = splitUnit(api.db, payload, api);
        queueLearningChange(ctx, { kind: 'split', episodeIds: [result.episodeId, result.newEpisodeId] });
        return result;
      },
      refreshTopics: (payload, api) => {
        assertPayload(payload, EMPTY_KEYS, 'refreshTopics');
        return refreshTopics(api.db, {
          goalId: resolveActiveGoal(api.db) ?? 'unassigned',
          now: api.now(),
          change: api.change,
        });
      },
      weakTopics: (payload, api) => {
        assertPayload(payload, WEAK_TOPIC_KEYS, 'weakTopics');
        return weakTopics(api.db, {
          goalId: resolveActiveGoal(api.db) ?? 'unassigned',
          now: api.now(),
          limit: payload.limit === undefined ? 5 : requireInteger(payload.limit, 'limit', 1, 10),
        });
      },
      methodSignals: (payload, api) => {
        assertPayload(payload, EMPTY_KEYS, 'methodSignals');
        return methodSignals(api.db, {
          goalId: resolveActiveGoal(api.db) ?? 'unassigned',
          now: api.now(),
        });
      },
      prune: (payload, api) => {
        assertPayload(payload, PRUNE_KEYS, 'prune');
        const now = payload.now === undefined ? api.now() : normalizePruneInstant(payload.now);
        return pruneTexts(api.db, { now });
      },
      export: (payload, api) => {
        assertPayload(payload, EXPORT_KEYS, 'export');
        if (payload.goalId !== undefined && (typeof payload.goalId !== 'string' || payload.goalId.trim() === '')) {
          throw new StudyError('invalid', 'goalId 必须是非空字符串', { field: 'goalId' });
        }
        return exportUnits(api.db, {
          from: normalizeBound(payload.from, 'from', false),
          to: normalizeBound(payload.to, 'to', true),
          goalId: typeof payload.goalId === 'string' && payload.goalId.trim() !== ''
            ? payload.goalId.trim()
            : (resolveActiveGoal(api.db) ?? 'unassigned'),
        });
      },
    },
    writes: WRITE_METHODS,
  }), 'study: learning namespace');

  ctx.effect(() => ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message?.source?.kind !== 'user') return;
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content
      .filter(block => block?.type === 'text')
      .map(block => (typeof block.text === 'string' ? block.text : ''))
      .join('\n')
      .trim();
    if (text === '') return;
    const sessionId = agent?.id;
    const messageId = message?.id;
    if (typeof sessionId !== 'string' || sessionId === '' || typeof messageId !== 'string' || messageId === '') return;
    const attachments = content
      .filter(block => block?.type === 'image' || block?.type === 'file')
      .map(block => ({ type: block.type, name: typeof block.name === 'string' ? block.name : null }));
    void ctx.study.call('learning', 'capture', {
      sessionId,
      messageId,
      text,
      attachments,
    }, { actor: 'system', requestId: `capture:${messageId}` }).then(result => {
      if (result?.ok !== true) {
        recordGap(kernel, {
          sessionId,
          messageId,
          reason: `${result?.code ?? 'unknown'}: ${result?.message ?? 'capture failed'}`,
          details: result?.details ?? null,
        });
      }
    }, error => {
      const messageText = error instanceof Error ? error.message : String(error);
      recordGap(kernel, { sessionId, messageId, reason: messageText, details: null });
      console.warn(`[study] capture failed: ${messageText}`);
    });
  }), 'study: learning capture');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_questions',
    description: '只读：检索学生问过的题与问答单元（一次问答含 1-3 道关联题目）。'
      + 'list 按时间、学科、状态或关键词列出单元；get 读取一个单元的题目、回合与信号；stats 返回区间统计。'
      + '用于回答“我问过什么”“这题是不是又问了一遍”，不会修改任何学习数据。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'get', 'stats'],
        description: 'list 检索问答单元；get 读取一个单元；stats 返回区间统计。',
      },
      id: { type: 'string', description: 'get 需要：问答单元 ID。' },
      from: { type: 'string', description: '起始日期（YYYY-MM-DD）或 ISO 时间；可选。' },
      to: { type: 'string', description: '结束日期（YYYY-MM-DD）或 ISO 时间；可选。' },
      subject: { type: 'string', description: '只看某个学科（与任务链接的学科一致）。' },
      status: {
        type: 'string',
        enum: [...EPISODE_STATUSES],
        description: 'list 只看某种单元状态。',
      },
      query: { type: 'string', description: '按题目或回合正文里的关键词过滤。' },
      limit: { type: 'integer', description: 'list 最多返回 1-50 条，默认 20。' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => [{ type: 'text', text: renderQuestions(args?.action, value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const { action, ...payload } = args ?? {};
      if (!['list', 'get', 'stats'].includes(action)) {
        throw new Error('action 必须是 list、get 或 stats');
      }
      const result = await ctx.study.call('learning', action, payload, { actor: 'agent' });
      if (result.ok !== true) throw new Error(`读取问答记录失败（${result.code}）：${result.message}`);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '问答记录' }),
  })), 'study: study_questions tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_insight',
    description: '学习分析：weak_topics 返回带引用的弱主题排序；method_signals 返回学习方法信号与反证；'
      + 'review_build 生成周/月证据包；review_save 生成并保存规则版周报/月报；profile 读取当前讲解参数。'
      + '主题聚类与报告是确定性规则，不调用模型；报告与证据都带题目/摘要 id。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...INSIGHT_ACTIONS],
        description: 'weak_topics 弱主题；method_signals 方法信号；review_build 证据包；review_save 生成并保存报告；profile 讲解参数。',
      },
      date: { type: 'string', description: '周/月报告所属日期（YYYY-MM-DD）；可选，默认今天。' },
      kind: { type: 'string', enum: [...INSIGHT_KINDS], description: 'review_build / review_save 的周期：week（默认）或 month。' },
      limit: { type: 'integer', description: 'weak_topics 最多返回 1-10 条，默认 5。' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => [{ type: 'text', text: renderInsight(args?.action, value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const { action, date, kind, limit } = args ?? {};
      if (!INSIGHT_ACTIONS.includes(action)) {
        throw new Error('action 必须是 weak_topics、method_signals、review_build、review_save 或 profile');
      }
      const reportKind = INSIGHT_KINDS.includes(kind) ? kind : 'week';
      if (action === 'weak_topics' || action === 'method_signals') {
        const refreshed = await ctx.study.call('learning', 'refreshTopics', {}, {
          actor: 'agent',
          requestId: `insight:topics:${randomUUID()}`,
        });
        if (refreshed.ok !== true) throw new Error(`主题聚类失败（${refreshed.code}）：${refreshed.message}`);
        const payload = action === 'weak_topics' && limit !== undefined ? { limit } : {};
        const method = action === 'weak_topics' ? 'weakTopics' : 'methodSignals';
        const result = await ctx.study.call('learning', method, payload, { actor: 'agent' });
        if (result.ok !== true) throw new Error(`分析失败（${result.code}）：${result.message}`);
        return result.value;
      }
      if (action === 'review_build' || action === 'review_save') {
        const result = await ctx.study.call('review', reportKind, {
          ...(date === undefined ? {} : { date }),
          save: action === 'review_save',
        }, { actor: 'agent', requestId: `insight:review:${reportKind}:${date ?? 'now'}:${randomUUID()}` });
        if (result.ok !== true) throw new Error(`报告生成失败（${result.code}）：${result.message}`);
        if (action === 'review_build') {
          return {
            kind: result.value.kind,
            period: result.value.period,
            from: result.value.from,
            to: result.value.to,
            bullets: result.value.bullets,
            evidence: result.value.evidence?.evidencePackage ?? result.value.evidence,
            reportMd: result.value.reportMd,
          };
        }
        return result.value;
      }
      const profile = await ctx.study.call('memory', 'profileGet', {}, { actor: 'agent' });
      if (profile.ok !== true) throw new Error(`画像读取失败（${profile.code}）：${profile.message}`);
      return profile.value;
    },
    presentCall: () => ({ card: 'generic', title: '学习分析' }),
  })), 'study: study_insight tool');

  ctx.effect(() => startWindowTicker(ctx, kernel), 'study: learning window ticker');
  ctx.effect(() => startPruneTicker(kernel), 'study: learning prune ticker');
}

/* ------------------------------------------------------------------ window */

/**
 * Announce a committed learning write after the current service call returns.
 * The deferred emit keeps listeners out of the write transaction; a listener
 * calls back through ctx.study, so its work runs after this write commits.
 * @param {{ emit?: Function }} ctx - Plugin context; test doubles may omit emit.
 * @param {{ kind: string, episodeId?: string | null, turnId?: string, episodeIds?: string[] }} event - What changed.
 */
function queueLearningChange(ctx, event) {
  if (typeof ctx.emit !== 'function') return;
  const handle = setImmediate(() => {
    try {
      ctx.emit('study/learning/changed', event);
    } catch (error) {
      console.warn(`[study] learning change listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (typeof handle.unref === 'function') handle.unref();
}

/**
 * Start the seal/summary catch-up pass. It runs once at startup (backfilling
 * the last 14 days), then every ten minutes; the timer is unref'd so tests and
 * headless profiles can exit. The disposer best-effort seals today's window,
 * and a failure is only logged.
 * @param {{ study: { call: Function } }} ctx - Plugin context.
 * @param {object} kernel - Kernel handle, for the clock and the database.
 * @returns {() => Promise<void>} Disposer.
 */
function startWindowTicker(ctx, kernel) {
  const now = () => new Date(kernel.status().serverTime);
  const tick = () => {
    void runWindowTick(kernel.database, ctx.study.call, now).catch(error => {
      console.warn(`[study] window tick failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  tick();
  const handle = setInterval(tick, TICK_INTERVAL_MS);
  if (typeof handle.unref === 'function') handle.unref();
  return async () => {
    clearInterval(handle);
    // Best effort only: Cordis disposes the namespace registration and this
    // effect together, and a queued service call resolves the namespace after
    // the removal, so this seal usually reports not_found/unavailable. Read the
    // window synchronously first to avoid a second failed call, and never let
    // the failure leave the disposer.
    let current;
    try {
      const goalId = resolveActiveGoal(kernel.database) ?? 'unassigned';
      current = openWindowForInstant(kernel.database, { goalId, now: now() });
    } catch (error) {
      console.warn(`[study] window seal on exit failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (current === null) return;
    try {
      const sealed = await ctx.study.call('learning', 'sealWindow', { id: current.id }, {
        actor: 'system',
        requestId: `window:seal:${current.id}:exit:${current.sealGeneration + 1}`,
      });
      if (sealed?.ok !== true) {
        console.warn(`[study] window seal on exit skipped: ${sealed?.code ?? 'unknown'}: ${sealed?.message ?? ''}`);
      }
    } catch (error) {
      console.warn(`[study] window seal on exit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/**
 * Run the 90-day retention pass at startup and every 24 hours. The pass writes
 * directly, like the window tick: it is maintenance, not a request the student
 * made, and it must not bump the visible revision when nothing expired.
 * @param {object} kernel - Kernel handle, for the clock and the database.
 * @returns {() => void} Disposer.
 */
function startPruneTicker(kernel) {
  const now = () => new Date(kernel.status().serverTime);
  const run = () => {
    try {
      pruneTexts(kernel.database, { now: now() });
    } catch (error) {
      console.warn(`[study] text retention failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  run();
  const handle = setInterval(run, 24 * 60 * 60 * 1000);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}

/* ------------------------------------------------------------------ capture */
/**
 * Persist one user turn, decide its Q&A unit, and derive problems and signals.
 * @param {object} payload - `{ sessionId, messageId, turnNo?, text, attachments? }`.
 * @param {{ db: import('../db.mjs').StudyDatabase, now: Function }} api - Kernel call context.
 * @returns {{ status: string, turnId: string | null, episodeId: string | null }} Capture result.
 */
function capture(payload, api) {
  assertPayload(payload, CAPTURE_KEYS, 'capture');
  const db = api.db;
  const sessionId = requireText(payload.sessionId, 'sessionId', 128);
  const messageId = requireText(payload.messageId, 'messageId', MAX_ID);
  const text = typeof payload.text === 'string' ? payload.text.trim() : null;
  if (text === null) throw new StudyError('invalid', 'text 必须是字符串');
  if (text.length > MAX_CAPTURE_TEXT) {
    throw new StudyError('invalid', `text 不能超过 ${MAX_CAPTURE_TEXT} 字`, { length: text.length, limit: MAX_CAPTURE_TEXT });
  }
  const attachments = normalizeAttachments(payload.attachments);
  const turnNo = payload.turnNo === undefined ? null : requireInteger(payload.turnNo, 'turnNo', 0, Number.MAX_SAFE_INTEGER);

  const existing = findTurn(db, sessionId, messageId);
  if (existing !== undefined) {
    return { status: 'duplicate', turnId: String(existing.id), episodeId: existing.episode_id === null ? null : String(existing.episode_id) };
  }
  if (text === '') return { status: 'ignored', turnId: null, episodeId: null };

  const at = api.now().toISOString();
  const goalId = resolveActiveGoal(db) ?? 'unassigned';
  const link = sessionLink(db, sessionId);
  const taskId = link?.taskId ?? null;
  const subject = link?.subject ?? null;
  const materialRef = link?.materialRef ?? null;
  const classification = classify(text, { taskId, attachments });
  const previous = classification.isLearning ? previousLearningTurn(db, sessionId) : undefined;
  const current = classification.isLearning ? openEpisode(db, sessionId) : undefined;
  const turnId = newId('turn');
  const episode = chooseEpisode(db, { sessionId, goalId, previous, current, classification, text, subject, taskId, materialRef, at });

  insertTurn(db, {
    id: turnId,
    goalId,
    sessionId,
    messageId,
    turnNo,
    at,
    intent: classification.intent,
    isLearning: classification.isLearning,
    subject,
    text,
    textHash: hashText(text),
    attachmentsJson: attachments.length === 0 ? null : JSON.stringify(attachments),
    taskId,
    materialRef,
    episodeId: episode.episodeId,
    classifiedBy: 'rule',
    classifierVersion: CLASSIFIER_VERSION,
    createdAt: at,
  });

  const kinds = signalKinds(text);
  let problemId = null;
  if (episode.episodeId !== null) {
    const firstTurn = countEpisodeTurns(db, episode.episodeId) === 0;
    insertEpisodeTurn(db, {
      episodeId: episode.episodeId,
      turnId,
      position: nextTurnPosition(db, episode.episodeId),
      role: roleOf(kinds, firstTurn),
      ambiguous: episode.ambiguous,
    });
    const problem = addProblem(db, {
      episodeId: episode.episodeId,
      goalId,
      subject,
      text,
      intent: classification.intent,
      turnId,
      at,
    });
    problemId = problem?.id ?? null;
    updateProblemCount(db, episode.episodeId, countProblems(db, episode.episodeId), at);
    // A unit opened before 04:00 can still receive a turn after its window was
    // summarized; the day summary must be rebuilt rather than left stale.
    markSummaryStaleForEpisodes(db, [episode.episodeId]);
  }

  const signalEpisodeId = episode.episodeId ?? (current === undefined ? openEpisode(db, sessionId)?.id ?? null : current.id);
  if (kinds.length > 0) {
    for (const kind of kinds) {
      insertSignal(db, {
        id: newId('sig'),
        episodeId: signalEpisodeId,
        problemId,
        turnId,
        kind,
        at,
        valueJson: null,
        source: 'rule',
      });
    }
    if (signalEpisodeId !== null) {
      setResolution(db, signalEpisodeId, resolutionOf(signalsOfEpisode(db, signalEpisodeId)), at);
    }
  }

  // A learning turn always lands in the window of its 04:00 study day, reopening
  // one an earlier exit sealed so the day keeps a single window.
  if (classification.isLearning) ensureWindow(db, { goalId, at });

  return { status: 'created', turnId, episodeId: episode.episodeId };
}

/**
 * Pick the unit the turn joins, opening a new one when the rules say so.
 * @returns {{ episodeId: string | null, ambiguous: number, created: boolean }} The target unit.
 */
function chooseEpisode(db, { sessionId, goalId, previous, current, classification, text, subject, taskId, materialRef, at }) {
  if (!classification.isLearning) return { episodeId: null, ambiguous: 0, created: false };
  if (current === undefined || previous === undefined) return createEpisodeFor(db, { sessionId, goalId, subject, at });
  if (previous.episode_id !== current.id) return createEpisodeFor(db, { sessionId, goalId, subject, at });
  const gap = Date.parse(at) - Date.parse(String(previous.at));
  if (!Number.isFinite(gap) || gap > MAX_GAP_MS) return createEpisodeFor(db, { sessionId, goalId, subject, at });
  if (countEpisodeTurns(db, String(current.id)) >= MAX_EPISODE_TURNS) {
    return createEpisodeFor(db, { sessionId, goalId, subject, at });
  }
  const boundary = boundaryScore(
    { text: String(previous.text ?? ''), subject: previous.subject ?? null, taskId: previous.task_id ?? null, materialRef: previous.material_ref ?? null, at: String(previous.at) },
    { text, subject, taskId, materialRef, at },
  );
  const decision = decideBoundary(boundary.points);
  if (decision === 'split') return createEpisodeFor(db, { sessionId, goalId, subject, at });
  return { episodeId: String(current.id), ambiguous: decision === 'ambiguous' ? 1 : 0, created: false };
}

/**
 * Close the session's open units and insert a fresh one.
 * @returns {{ episodeId: string, ambiguous: number, created: boolean }} New unit reference.
 */
function createEpisodeFor(db, { sessionId, goalId, subject, at }) {
  if (sessionId === '') throw new StudyError('unavailable', '无法确定捕获回合所属的会话');
  closeOpenEpisodes(db, sessionId, at);
  const episodeId = newId('ep');
  createEpisode(db, {
    id: episodeId,
    goalId,
    sessionId,
    subject,
    openedAt: at,
    boundarySource: 'rule',
    createdAt: at,
    updatedAt: at,
  });
  return { episodeId, ambiguous: 0, created: true };
}

/**
 * Extract and store one problem from the turn when the rules call for it. The
 * first problem of a unit comes from its first question-like turn, so a linked
 * session that starts with "懂了" does not store that as a problem.
 * @returns {{ id: string } | null} The stored problem, when one was added.
 */
function addProblem(db, { episodeId, goalId, subject, text, intent, turnId, at }) {
  const existing = countProblems(db, episodeId);
  const namesAnother = isNewProblemTurn(text);
  const addsFirst = existing === 0 && (intent === 'question' || namesAnother);
  const addsAnother = existing > 0 && existing < MAX_PROBLEMS && namesAnother;
  if (!addsFirst && !addsAnother) return null;

  const problemText = truncate(text, MAX_PROBLEM_CHARS);
  const norm = normalize(problemText);
  const hash = hashText(problemText);
  const sketchText = sketch(problemText);
  const since = new Date(Date.parse(at) - REASK_WINDOW_MS).toISOString();
  const match = findReask(db, { goalId, episodeId, since, hash, sketchText, subject });
  const problemId = newId('prob');
  insertProblem(db, {
    id: problemId,
    episodeId,
    position: existing,
    text: problemText,
    norm,
    hash,
    sketch: sketchText,
    reaskedFrom: match === null ? null : String(match.id),
    createdAt: at,
  });
  if (match !== null) {
    markReasked(db, String(match.id));
    insertSignal(db, {
      id: newId('sig'),
      episodeId,
      problemId,
      turnId,
      kind: 'reask',
      at,
      valueJson: JSON.stringify({ reaskedFrom: String(match.id) }),
      source: 'rule',
    });
  }
  return { id: problemId };
}

/**
 * Earlier problem the student is asking again: identical normalized text, or a
 * very similar keyword sketch in the same subject.
 * @returns {Record<string, unknown> | null} Matched problem row.
 */
function findReask(db, { goalId, episodeId, since, hash, sketchText, subject }) {
  const candidates = reaskCandidates(db, { goalId, episodeId, since });
  const sameHash = candidates.find(candidate => candidate.hash === hash);
  if (sameHash !== undefined) return sameHash;
  const tokens = sketchTokens(sketchText);
  return candidates.find(candidate => (candidate.episode_subject ?? null) === (subject ?? null)
    && jaccard(sketchTokens(String(candidate.sketch ?? '')), tokens) >= REASK_SKETCH_JACCARD) ?? null;
}

function roleOf(kinds, firstTurn) {
  if (firstTurn) return 'ask';
  if (kinds.includes('understood') || kinds.includes('self_solved')) return 'confirm';
  return 'clarify';
}

/**
 * Unit result from its signals: a success wins, otherwise the last signal
 * decides whether the student is still confused.
 * @param {Array<Record<string, unknown>>} signals - Signals oldest first.
 * @returns {'understood' | 'unresolved' | 'unknown'} Derived resolution.
 */
function resolutionOf(signals) {
  if (signals.some(signal => signal.kind === 'understood' || signal.kind === 'self_solved')) return 'understood';
  const last = signals.at(-1);
  if (last?.kind === 'confused') return 'unresolved';
  return 'unknown';
}

/**
 * Record a capture failure without throwing: a dropped turn must be visible.
 * Writes directly because the capture transaction has already rolled back.
 * @param {{ database: object, status?: Function }} kernel - Kernel handle.
 * @param {{ sessionId: string, messageId: string, reason: string, details: object | null }} entry - What failed.
 */
function recordGap(kernel, { sessionId, messageId, reason, details }) {
  try {
    let at;
    try {
      at = kernel.status().serverTime;
    } catch {
      at = new Date().toISOString();
    }
    insertGap(kernel.database, {
      id: newId('gap'),
      sessionId,
      messageId,
      reason: truncate(String(reason), 500),
      detailJson: details === null ? null : JSON.stringify(details),
      at,
    });
  } catch (error) {
    console.warn(`[study] capture gap was not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------------------------------------------- merge and split */

/**
 * Merge at least two units of one goal into the earliest one. Turns and
 * problems move to the target in chronological order, signals follow their
 * turn/problem, and the folded units keep `merged_into` as the audit trail.
 * @param {object} db - Study database.
 * @param {{ episodeIds: string[] }} payload - Units to merge.
 * @param {{ now: Function, change: Function }} api - Kernel call context.
 * @returns {{ targetId: string, mergedIds: string[], problemCount: number, turnCount: number }} Merge result.
 */
function mergeUnits(db, payload, api) {
  assertPayload(payload, MERGE_KEYS, 'merge');
  if (!Array.isArray(payload.episodeIds)) throw new StudyError('invalid', 'episodeIds 必须是数组');
  if (payload.episodeIds.length < 2 || payload.episodeIds.length > MAX_MERGE_UNITS) {
    throw new StudyError('invalid', `merge 需要 ${2}-${MAX_MERGE_UNITS} 个问答单元`, { count: payload.episodeIds.length });
  }
  const ids = [];
  for (const [index, value] of payload.episodeIds.entries()) {
    const id = requireText(value, `episodeIds[${index}]`, MAX_ID);
    if (ids.includes(id)) throw new StudyError('invalid', 'episodeIds 不能重复', { id });
    ids.push(id);
  }
  const rows = ids.map(id => {
    const row = episodeRow(db, id);
    if (row === undefined) throw new StudyError('not_found', `没有 id 为 ${id} 的问答单元`, { id });
    return row;
  });
  const goalId = String(rows[0].goal_id);
  if (rows.some(row => String(row.goal_id) !== goalId)) {
    throw new StudyError('conflict', '只能合并同一个备考目标下的问答单元');
  }
  if (rows.some(row => String(row.status) === 'merged' || (row.merged_into !== null && row.merged_into !== undefined))) {
    throw new StudyError('conflict', '已合并的问答单元不能再合并');
  }

  const at = api.now().toISOString();
  const ordered = [...rows].sort((left, right) => compareInstants(left.opened_at, right.opened_at)
    || String(left.id).localeCompare(String(right.id)));
  const target = ordered[0];
  const targetId = String(target.id);
  const sources = ordered.slice(1);
  const sourceIds = sources.map(row => String(row.id));
  const targetBefore = {
    problemCount: Number(target.problem_count),
    turnCount: turnsWithTimeOfEpisode(db, targetId).length,
  };

  // Turns: rebuild the target's ask order across every merged unit.
  const allTurns = [];
  for (const row of ordered) allTurns.push(...turnsWithTimeOfEpisode(db, String(row.id)));
  allTurns.sort((left, right) => compareInstants(left.at, right.at) || String(left.turn_id).localeCompare(String(right.turn_id)));
  for (const row of ordered) deleteEpisodeTurns(db, String(row.id));
  allTurns.forEach((turn, position) => {
    insertEpisodeTurn(db, {
      episodeId: targetId,
      turnId: String(turn.turn_id),
      position,
      role: String(turn.role),
      ambiguous: Number(turn.ambiguous) === 1,
    });
    setTurnEpisode(db, String(turn.turn_id), targetId);
  });

  // Problems: one contiguous ask order on the target.
  const allProblems = [];
  for (const row of ordered) allProblems.push(...problemsOfEpisode(db, String(row.id)));
  allProblems.sort((left, right) => compareInstants(left.created_at, right.created_at) || String(left.id).localeCompare(String(right.id)));
  allProblems.forEach((problem, position) => setProblemOwner(db, String(problem.id), targetId, position));

  // Topics: union of every source unit's subject, keeping existing topic links.
  const topics = new Map();
  for (const row of ordered) {
    for (const topic of episodeTopics(db, String(row.id))) {
      topics.set(String(topic.topic_id), { confidence: Number(topic.confidence), source: String(topic.source) });
    }
    if (row.subject !== null && row.subject !== undefined) {
      const topicId = `subject:${String(row.subject)}`;
      if (!topics.has(topicId)) topics.set(topicId, { confidence: 1, source: 'merge' });
    }
  }
  for (const row of ordered) deleteEpisodeTopics(db, String(row.id));
  for (const [topicId, topic] of topics) {
    insertEpisodeTopic(db, { episodeId: targetId, topicId, confidence: topic.confidence, source: topic.source });
  }

  moveSignalsOfEpisodes(db, sourceIds, targetId);
  recomputeResolution(db, targetId, at);
  updateProblemCount(db, targetId, countProblems(db, targetId), at);
  for (const source of sources) {
    const sourceId = String(source.id);
    updateProblemCount(db, sourceId, 0, at);
    setEpisodeMerged(db, sourceId, targetId, at);
    api.change({
      entity: 'episode',
      entityId: sourceId,
      action: 'merge',
      before: { status: String(source.status), mergedInto: null, problemCount: Number(source.problem_count) },
      after: { status: 'merged', mergedInto: targetId },
      reason: `合并到 ${targetId}`,
    });
  }
  touchEpisode(db, targetId, at);
  markSummaryStaleForEpisodes(db, ordered.map(row => String(row.id)));
  api.change({
    entity: 'episode',
    entityId: targetId,
    action: 'merge_target',
    before: targetBefore,
    after: { problemCount: countProblems(db, targetId), turnCount: allTurns.length, mergedIds: sourceIds },
    reason: `合并 ${sourceIds.length} 个问答单元`,
  });

  return {
    targetId,
    mergedIds: sourceIds,
    problemCount: countProblems(db, targetId),
    turnCount: allTurns.length,
  };
}

/**
 * Split one unit at a turn: that turn and everything after it become a new
 * closed unit, with the problems created from that turn onward. Both sides
 * recompute their counts and resolution.
 * @param {object} db - Study database.
 * @param {{ episodeId: string, atTurnId: string }} payload - Unit and split point.
 * @param {{ now: Function, change: Function }} api - Kernel call context.
 * @returns {{ episodeId: string, newEpisodeId: string, movedTurns: number, movedProblems: number }} Split result.
 */
function splitUnit(db, payload, api) {
  assertPayload(payload, SPLIT_KEYS, 'split');
  const episodeId = requireText(payload.episodeId, 'episodeId', MAX_ID);
  const atTurnId = requireText(payload.atTurnId, 'atTurnId', MAX_ID);
  const episode = episodeRow(db, episodeId);
  if (episode === undefined) throw new StudyError('not_found', `没有 id 为 ${episodeId} 的问答单元`, { episodeId });
  if (String(episode.status) === 'merged') throw new StudyError('conflict', '已合并的问答单元不能拆分', { episodeId });
  const link = db.get('SELECT position FROM study_episode_turn WHERE episode_id = ? AND turn_id = ?', episodeId, atTurnId);
  if (link === undefined) throw new StudyError('not_found', '该回合不属于这个问答单元', { episodeId, atTurnId });
  const position = Number(link.position);
  if (position === 0) throw new StudyError('invalid', '不能在第一个回合处拆开：原单元会变空', { episodeId, atTurnId });
  const turn = db.get('SELECT * FROM study_turn WHERE id = ?', atTurnId);
  if (turn === undefined) throw new StudyError('not_found', `没有 id 为 ${atTurnId} 的学习回合`, { atTurnId });

  const at = api.now().toISOString();
  const newEpisodeId = newId('ep');
  insertSplitEpisode(db, {
    id: newEpisodeId,
    goalId: String(episode.goal_id),
    sessionId: String(episode.session_id),
    subject: episode.subject === null ? null : String(episode.subject),
    openedAt: String(turn.at),
    closedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  for (const topic of episodeTopics(db, episodeId)) {
    insertEpisodeTopic(db, {
      episodeId: newEpisodeId,
      topicId: String(topic.topic_id),
      confidence: Number(topic.confidence),
      source: String(topic.source),
    });
  }

  const movedTurns = db.all(
    'SELECT turn_id, role, ambiguous FROM study_episode_turn WHERE episode_id = ? AND position >= ? ORDER BY position ASC',
    episodeId,
    position,
  );
  const movedTurnIds = movedTurns.map(row => String(row.turn_id));
  for (const [index, row] of movedTurns.entries()) {
    db.run('DELETE FROM study_episode_turn WHERE episode_id = ? AND turn_id = ?', episodeId, row.turn_id);
    insertEpisodeTurn(db, {
      episodeId: newEpisodeId,
      turnId: String(row.turn_id),
      position: index,
      role: String(row.role),
      ambiguous: Number(row.ambiguous) === 1,
    });
    setTurnEpisode(db, String(row.turn_id), newEpisodeId);
  }

  const movedProblems = db.all(
    'SELECT id FROM study_episode_problem WHERE episode_id = ? AND created_at >= ? ORDER BY created_at ASC, rowid ASC',
    episodeId,
    String(turn.at),
  );
  const movedProblemIds = movedProblems.map(row => String(row.id));
  movedProblems.forEach((problem, index) => setProblemOwner(db, String(problem.id), newEpisodeId, index));
  moveSignalsOfCorrection(db, {
    episodeId,
    toEpisodeId: newEpisodeId,
    turnIds: movedTurnIds,
    problemIds: movedProblemIds,
  });

  recomputeResolution(db, episodeId, at);
  recomputeResolution(db, newEpisodeId, at);
  updateProblemCount(db, episodeId, countProblems(db, episodeId), at);
  updateProblemCount(db, newEpisodeId, countProblems(db, newEpisodeId), at);
  closeEpisode(db, episodeId, at);
  markSummaryStaleForEpisodes(db, [episodeId, newEpisodeId]);
  api.change({
    entity: 'episode',
    entityId: episodeId,
    action: 'split',
    before: { status: String(episode.status), problemCount: Number(episode.problem_count) },
    after: {
      status: 'closed',
      newEpisodeId,
      movedTurns: movedTurnIds.length,
      movedProblems: movedProblemIds.length,
    },
    reason: `从回合 ${atTurnId} 拆开`,
  });

  return {
    episodeId,
    newEpisodeId,
    movedTurns: movedTurnIds.length,
    movedProblems: movedProblemIds.length,
  };
}

/**
 * Re-derive a unit's result from the signals it owns now.
 * @param {object} db - Study database.
 * @param {string} episodeId - Unit id.
 * @param {string} at - Update instant.
 */
function recomputeResolution(db, episodeId, at) {
  const signals = signalsOfEpisode(db, episodeId);
  setResolutionOrNull(db, episodeId, signals.length === 0 ? null : resolutionOf(signals), at);
}

function compareInstants(left, right) {
  const leftTime = Date.parse(String(left));
  const rightTime = Date.parse(String(right));
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || leftTime === rightTime) return 0;
  return leftTime - rightTime;
}

/* -------------------------------------------------------------------- reads */

/**
 * List Q&A units with a short problem digest.
 * @param {object} db - Study database.
 * @param {{ from?: string, to?: string, subject?: string, status?: string, query?: string, limit?: number }} payload - Filters.
 * @returns {{ items: object[], total: number }} Page and total.
 */
function listUnits(db, payload) {
  assertPayload(payload, LIST_KEYS, 'list');
  const filters = {
    from: normalizeBound(payload.from, 'from', false),
    to: normalizeBound(payload.to, 'to', true),
    subject: optionalText(payload.subject, 'subject', 100),
    status: normalizedStatus(payload.status),
    resolution: normalizedResolution(payload.resolution),
    query: optionalText(payload.query, 'query', MAX_ID),
    limit: payload.limit === undefined ? DEFAULT_LIST_LIMIT : requireInteger(payload.limit, 'limit', 1, MAX_LIST_LIMIT),
  };
  const rows = listEpisodeRows(db, filters);
  const total = countEpisodeRows(db, filters);
  return {
    items: rows.map(row => ({
      id: String(row.id),
      openedAt: String(row.opened_at),
      closedAt: row.closed_at === null ? null : String(row.closed_at),
      subject: row.subject === null ? null : String(row.subject),
      status: String(row.status),
      problemCount: Number(row.problem_count),
      resolution: row.resolution === null ? null : String(row.resolution),
      problems: problemsOfEpisode(db, String(row.id)).map(problem => ({
        text: problem.text === null ? null : String(problem.text),
        status: String(problem.status),
        reaskCount: Number(problem.reask_count),
      })),
    })),
    total,
  };
}

/**
 * Read one Q&A unit with its problems, turns, and signals.
 * @param {object} db - Study database.
 * @param {{ id: string }} payload - Unit id.
 * @returns {{ episode: object, problems: object[], turns: object[], signals: object[] }} Unit detail.
 */
function getUnit(db, payload) {
  assertPayload(payload, GET_KEYS, 'get');
  const id = requireText(payload.id, 'id', MAX_ID);
  const row = episodeRow(db, id);
  if (row === undefined) throw new StudyError('not_found', `没有 id 为 ${id} 的问答单元`, { id });
  return {
    episode: episodeView(row),
    problems: problemsOfEpisode(db, id).map(problemView),
    turns: turnsOfEpisode(db, id).map(turnView),
    signals: signalsOfEpisode(db, id).map(signalView),
  };
}

/**
 * Range statistics over turns, units, problems, and outcomes.
 * @param {object} db - Study database.
 * @param {{ from?: string, to?: string }} payload - Time window.
 * @returns {object} Counts plus re-ask rate and per-subject breakdown.
 */
function unitStats(db, payload) {
  assertPayload(payload, STATS_KEYS, 'stats');
  const data = statsData(db, {
    from: normalizeBound(payload.from, 'from', false),
    to: normalizeBound(payload.to, 'to', true),
  });
  const reaskRate = data.problems === 0 ? 0 : Number((data.reaskedProblems / data.problems).toFixed(4));
  return {
    turns: data.turns,
    learningTurns: data.learningTurns,
    episodes: data.episodes,
    problems: data.problems,
    resolved: data.resolved,
    unresolved: data.unresolved,
    reaskRate,
    bySubject: data.bySubject,
  };
}

/* --------------------------------------------------------------- rendering */
/**
 * Export one goal's Q&A units as JSONL. Each line carries the unit, its
 * problems (with text when it still exists), signals, topics, and the turn
 * metadata, but never the original turn text by default.
 * @param {object} db - Study database.
 * @param {{ from?: string, to?: string, goalId: string }} filters - Range and goal.
 * @returns {{ from: string | null, to: string | null, goalId: string, count: number, jsonl: string }} Export.
 */
function exportUnits(db, filters) {
  const clauses = ['goal_id = ?'];
  const params = [filters.goalId];
  if (filters.from !== undefined) {
    clauses.push('opened_at >= ?');
    params.push(filters.from);
  }
  if (filters.to !== undefined) {
    clauses.push('opened_at <= ?');
    params.push(filters.to);
  }
  const episodes = db.all(
    `SELECT * FROM study_episode WHERE ${clauses.join(' AND ')} ORDER BY opened_at ASC, rowid ASC`,
    ...params,
  );
  const lines = episodes.map(row => {
    const episodeId = String(row.id);
    const problems = problemsOfEpisode(db, episodeId).map(problem => ({
      id: String(problem.id),
      position: Number(problem.position),
      text: problem.text === null ? null : String(problem.text),
      hash: String(problem.hash),
      sketch: String(problem.sketch),
      status: String(problem.status),
      resolution: problem.resolution === null ? null : String(problem.resolution),
      reaskedFrom: problem.reasked_from === null ? null : String(problem.reasked_from),
      reaskCount: Number(problem.reask_count),
      createdAt: String(problem.created_at),
    }));
    const signals = signalsOfEpisode(db, episodeId).map(signal => ({
      id: String(signal.id),
      kind: String(signal.kind),
      problemId: signal.problem_id === null ? null : String(signal.problem_id),
      turnId: signal.turn_id === null ? null : String(signal.turn_id),
      at: String(signal.at),
      source: String(signal.source),
    }));
    const topics = db.all(
      `SELECT et.topic_id, et.confidence, et.source, t.name
         FROM study_episode_topic et LEFT JOIN study_topic t ON t.id = et.topic_id
        WHERE et.episode_id = ? ORDER BY et.topic_id ASC`,
      episodeId,
    ).map(topic => ({
      topicId: String(topic.topic_id),
      name: topic.name === null || topic.name === undefined ? null : String(topic.name),
      confidence: Number(topic.confidence),
      source: String(topic.source),
    }));
    const turns = db.all(
      `SELECT t.id, t.at, t.text_pruned_at, et.role, et.position
         FROM study_episode_turn et JOIN study_turn t ON t.id = et.turn_id
        WHERE et.episode_id = ? ORDER BY et.position ASC`,
      episodeId,
    ).map(turn => ({
      id: String(turn.id),
      at: String(turn.at),
      role: String(turn.role),
      position: Number(turn.position),
      textPrunedAt: turn.text_pruned_at === null ? null : String(turn.text_pruned_at),
    }));
    return JSON.stringify({
      id: episodeId,
      goalId: String(row.goal_id),
      sessionId: String(row.session_id),
      subject: row.subject === null ? null : String(row.subject),
      openedAt: String(row.opened_at),
      closedAt: row.closed_at === null ? null : String(row.closed_at),
      status: String(row.status),
      problemCount: Number(row.problem_count),
      resolution: row.resolution === null ? null : String(row.resolution),
      summary: row.summary === null ? null : String(row.summary),
      boundarySource: String(row.boundary_source),
      continuationOf: row.continuation_of === null ? null : String(row.continuation_of),
      mergedInto: row.merged_into === null ? null : String(row.merged_into),
      problems,
      signals,
      topics,
      turns,
    });
  });
  return {
    from: filters.from ?? null,
    to: filters.to ?? null,
    goalId: filters.goalId,
    count: episodes.length,
    jsonl: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
  };
}

/**
 * One-line Chinese summary for the Agent tool.
 * @param {string | undefined} action - list, get, or stats.
 * @param {object} value - Method result.
 * @returns {string} Summary text.
 */
function renderQuestions(action, value) {
  if (value === null || value === undefined) return '没有问答记录。';
  if (action === 'get') {
    const problems = Array.isArray(value.problems) ? value.problems : [];
    const first = problems[0]?.text;
    return `${problems.length} 道题｜${statusLabel(value.episode?.status)}｜${resolutionLabel(value.episode?.resolution)}｜`
      + `${value.turns?.length ?? 0} 个学习回合${first === undefined || first === null ? '' : `｜${truncate(String(first), 40)}`}`;
  }
  if (action === 'stats') {
    return `${value.turns} 个用户回合（${value.learningTurns} 个学习）｜${value.episodes} 次问答｜${value.problems} 道题｜`
      + `${value.resolved} 次闭环｜重问率 ${Math.round((value.reaskRate ?? 0) * 100)}%`;
  }
  const items = Array.isArray(value.items) ? value.items : [];
  const problemCount = items.reduce((sum, item) => sum + (item.problemCount ?? 0), 0);
  const closed = items.filter(item => item.resolution === 'understood').length;
  const latest = items[0]?.problems?.[0]?.text;
  return `共 ${value.total ?? items.length} 次问答（显示 ${items.length} 次）｜${problemCount} 道题｜${closed} 次闭环`
    + `${latest === undefined || latest === null ? '' : `｜最近：${truncate(String(latest), 30)}`}`;
}

/**
 * One-line (or short block) rendering for the `study_insight` tool.
 * @param {string} action - Tool action.
 * @param {object} value - Method result.
 * @returns {string} Text for the tool card.
 */
function renderInsight(action, value) {
  if (value === null || value === undefined) return '没有分析结果。';
  if (action === 'weak_topics') {
    if (value.status === 'insufficient') return value.reason ?? '主题证据不足，暂时不能排序。';
    return value.items.map((item, index) => (
      `${index + 1}. ${item.name}（${item.stateLabel}，薄弱度 ${item.score}，${item.n} 道题，重问 ${item.reaskCount}，未闭环 ${item.unresolvedCount}）`
    )).join('\n');
  }
  if (action === 'method_signals') {
    if (!Array.isArray(value.signals) || value.signals.length === 0) return '这个周期没有发现明确的方法信号。';
    return value.signals.map(signal => (
      `${signal.title}：${signal.detail}（置信度 ${Math.round(signal.confidence * 100)}%）`
    )).join('\n');
  }
  if (action === 'review_build') {
    return [`已生成 ${value.period ?? ''} 的证据包。`, ...(value.bullets ?? []).map(bullet => `- ${bullet}`)].join('\n');
  }
  if (action === 'review_save') {
    return `${value.period ?? ''} 报告已生成并保存。\n\n${value.reportMd ?? ''}`;
  }
  if (action === 'profile') {
    if (!Array.isArray(value.traits) || value.traits.length === 0) return '还没有可用的讲解参数。';
    return value.traits.map(trait => `${trait.text}（当前 ${trait.level}/${trait.max ?? 5}）`).join('\n');
  }
  return '没有分析结果。';
}

function statusLabel(status) {  return { open: '进行中', closed: '已结束', enriched: '已补充', merged: '已合并' }[status] ?? '未知状态';
}

function resolutionLabel(resolution) {
  return { understood: '已闭环', unresolved: '未闭环', unknown: '未判定' }[resolution] ?? '未判定';
}

/* --------------------------------------------------------------- mapping */

function episodeView(row) {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    sessionId: String(row.session_id),
    subject: row.subject === null ? null : String(row.subject),
    openedAt: String(row.opened_at),
    closedAt: row.closed_at === null ? null : String(row.closed_at),
    status: String(row.status),
    problemCount: Number(row.problem_count),
    stuck: parseJson(row.stuck_json),
    method: parseJson(row.method_json),
    resolution: row.resolution === null ? null : String(row.resolution),
    confidence: row.confidence === null ? null : Number(row.confidence),
    summary: row.summary === null ? null : String(row.summary),
    boundarySource: String(row.boundary_source),
    continuationOf: row.continuation_of === null ? null : String(row.continuation_of),
    mergedInto: row.merged_into === null ? null : String(row.merged_into),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function problemView(row) {
  return {
    id: String(row.id),
    episodeId: String(row.episode_id),
    position: Number(row.position),
    text: row.text === null ? null : String(row.text),
    norm: row.norm === null ? null : String(row.norm),
    hash: String(row.hash),
    sketch: String(row.sketch),
    status: String(row.status),
    resolution: row.resolution === null ? null : String(row.resolution),
    reaskedFrom: row.reasked_from === null ? null : String(row.reasked_from),
    reaskCount: Number(row.reask_count),
    createdAt: String(row.created_at),
  };
}

function turnView(row) {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    turnNo: row.turn_no === null ? null : Number(row.turn_no),
    at: String(row.at),
    intent: String(row.intent),
    isLearning: Number(row.is_learning) === 1,
    subject: row.subject === null ? null : String(row.subject),
    text: row.text === null ? null : String(row.text),
    textHash: String(row.text_hash),
    textPrunedAt: row.text_pruned_at === null ? null : String(row.text_pruned_at),
    attachments: parseJson(row.attachments_json),
    taskId: row.task_id === null ? null : String(row.task_id),
    materialRef: row.material_ref === null ? null : String(row.material_ref),
    classifiedBy: String(row.classified_by),
    classifierVersion: row.classifier_version === null ? null : String(row.classifier_version),
    createdAt: String(row.created_at),
    position: row.position === undefined ? null : Number(row.position),
    role: row.role === undefined ? null : String(row.role),
    ambiguous: row.ambiguous === undefined ? null : Number(row.ambiguous) === 1,
  };
}

function signalView(row) {
  return {
    id: String(row.id),
    episodeId: row.episode_id === null ? null : String(row.episode_id),
    problemId: row.problem_id === null ? null : String(row.problem_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    kind: String(row.kind),
    at: String(row.at),
    value: parseJson(row.value_json),
    source: String(row.source),
  };
}

/* --------------------------------------------------------------- helpers */

function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function parseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

/**
 * Parse the optional `now` override of `learning.prune`; the service clock
 * remains the default so a caller cannot silently skip the retention window.
 * @param {unknown} value - ISO instant or date.
 * @returns {Date} Parsed instant.
 */
function normalizePruneInstant(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StudyError('invalid', 'now 必须是 ISO 时间字符串', { field: 'now' });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new StudyError('invalid', `无效时间 ${value}`, { field: 'now' });
  }
  return parsed;
}

function normalizeAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw new StudyError('invalid', `attachments 必须是不超过 ${MAX_ATTACHMENTS} 项的数组`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item) || typeof item.type !== 'string') {
      throw new StudyError('invalid', `attachments[${index}] 必须是 { type, name } 对象`);
    }
    const type = item.type.trim();
    if (type !== 'image' && type !== 'file') {
      throw new StudyError('invalid', `attachments[${index}].type 只能是 image 或 file`);
    }
    return { type, name: typeof item.name === 'string' ? item.name.slice(0, 200) : null };
  });
}

function assertPayload(payload, allowed, method) {
  if (!isPlainObject(payload)) throw new StudyError('invalid', `${method} 的载荷必须是对象`);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new StudyError('invalid', `${method} 不接受字段 ${key}`, { field: key });
  }
}

function requireText(value, label, max) {
  if (typeof value !== 'string') throw new StudyError('invalid', `${label} 必须是字符串`);
  const text = value.trim();
  if (text === '') throw new StudyError('invalid', `${label} 不能为空`);
  if (text.length > max) throw new StudyError('invalid', `${label} 不能超过 ${max} 个字符`);
  return text;
}

function optionalText(value, label, max) {
  if (value === undefined) return undefined;
  return requireText(value, label, max);
}

function requireInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new StudyError('invalid', `${label} 必须是 ${min}-${max} 之间的整数`);
  }
  return value;
}

function normalizedStatus(value) {
  const status = optionalText(value, 'status', 32);
  if (status !== undefined && !EPISODE_STATUSES.includes(status)) {
    throw new StudyError('invalid', `status 必须是 ${EPISODE_STATUSES.join('、')} 之一`);
  }
  return status;
}

function normalizedResolution(value) {
  const resolution = optionalText(value, 'resolution', 32);
  if (resolution !== undefined && !EPISODE_RESOLUTIONS.includes(resolution)) {
    throw new StudyError('invalid', `resolution 必须是 ${EPISODE_RESOLUTIONS.join('、')} 之一`);
  }
  return resolution;
}

/**
 * Normalize a read bound: a bare date covers the whole UTC day; any other
 * parseable time becomes its canonical ISO form.
 */
function normalizeBound(value, label, endOfDay) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StudyError('invalid', `${label} 必须是日期（YYYY-MM-DD）或 ISO 时间字符串`);
  }
  const text = value.trim();
  if (DATE_ONLY.test(text)) {
    const millis = Date.parse(`${text}T00:00:00.000Z`);
    if (!Number.isFinite(millis)) throw new StudyError('invalid', `${label} 不是合法日期`, { value: text });
    return endOfDay ? `${text}T23:59:59.999Z` : `${text}T00:00:00.000Z`;
  }
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) throw new StudyError('invalid', `${label} 不是可解析的时间`, { value: text });
  return new Date(millis).toISOString();
}
