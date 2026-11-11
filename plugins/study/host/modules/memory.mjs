/**
 * Memory module: durable student memory, teaching-parameter traits, and the
 * per-turn tutoring contract.
 *
 * Before S3 the module kept three kinds (preference / state / observation) in
 * memory.json and mirrored them into study_memory_state. It now owns the
 * seven-kind SQLite model from the design: study_memory_item (plus
 * study_memory_evidence and study_memory_tombstone). The v1 rows are migrated
 * once at startup, the file is copied to memory.v1.backup.json, and the tables
 * become the only write target; memory.json is kept untouched as an export
 * source. A failed migration leaves the tables empty and switches the methods to
 * "unavailable" instead of writing partial data.
 *
 * remember / recall / forget keep their v1 signatures and result fields.
 * profileGet / profileExplain / profileSet expose the six teaching parameters;
 * refreshTraits recomputes the inferred ones after a learning change and writes
 * one versioned item per effective level. The system prompt receives a compiled
 * teaching contract (parameters only, never evidence or confidence) and falls
 * back to the v1 snapshot when no trait is effective.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveActiveGoal } from '../facts.mjs';
import { toolRequestId } from '../operation.mjs';
import { StudyError, isPlainObject } from '../registry.mjs';
import {
  KIND_LABELS,
  SCHEMA,
  V1_KINDS,
  currentItemByKey,
  currentItems,
  deleteItem,
  deleteTombstone,
  findTombstone,
  insertItem,
  insertTombstone,
  itemById,
  pruneTombstones,
  replaceEvidence,
  supersedeItem,
  updateItemContent,
  updateItemMetadata,
} from '../memory/store.mjs';
import { migrateV1, parseLegacyState, readLegacySource } from '../memory/migrate-v1.mjs';
import {
  TRAITS,
  behaviorText,
  compileContract,
  evaluateAllTraits,
  evaluateTrait,
  isTraitLevel,
  renderV1Snapshot,
  roundLevel,
  storedTraitValue,
  traitSpec,
  valueOfLevel,
  evaluateAutoTrait,
} from '../memory/traits.mjs';

/** Module id; matches the memory service namespace. */
export const id = 'memory';

/** Memory depends on no other module; trait derivation reads learning tables when present. */
export const deps = [];

/** The seven-kind memory tables; applied once and recorded as memory = 1. */
export const schema = SCHEMA;

/** First recorded schema version of this module. */
export const schemaVersion = 1;

const FILE_NAME = 'memory.json';
const BACKUP_NAME = 'memory.v1.backup.json';
const KINDS = V1_KINDS;
const KIND_ORDER = Object.freeze({ preference: 0, state: 1, observation: 2 });
const MAX_TEXT = 500;
const MAX_ITEMS = 200;
const MAX_TOMBSTONES = 500;
const MAX_INJECTED = 8;
const MAX_INJECTED_CHARS = 120;
const MAX_CONTRACT_MEMORIES = 4;
const MAX_CONTRACT_MEMORY_CHARS = 50;
const DEFAULT_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const SCORE_THRESHOLD = 0.35;
const ID_PATTERN = /^mem_[a-f0-9]{12}$/;
const ALLOWED_REMEMBER_KEYS = new Set(['goalId', 'id', 'text', 'kind', 'expiresAt', 'ttlMs', 'note', 'revokeTombstone']);
const ALLOWED_RECALL_KEYS = new Set(['goalId', 'query', 'kind', 'includeExpired', 'limit']);
const ALLOWED_FORGET_KEYS = new Set(['goalId', 'id', 'query']);
const ALLOWED_PROFILE_EXPLAIN_KEYS = new Set(['key']);
const ALLOWED_PROFILE_SET_KEYS = new Set(['key', 'level']);
const EMPTY_KEYS = new Set();

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { defineTool } = requireFromSource(join(sourceDirectory, 'packages/core/tools/lib/index.js'));

/**
 * Register the memory namespace, migration, trait refresh listener, contract
 * injection, and the Agent tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {{ database: { file: string }, status: Function }} kernel - Kernel handle; files live beside study.db.
 */
export async function apply(ctx, kernel) {
  const directory = dirname(kernel.database.file);
  const file = join(directory, FILE_NAME);
  const backupFile = join(directory, BACKUP_NAME);
  const database = kernel.database;
  const now = () => new Date(kernel.status().serverTime);
  const runtime = { fallback: null };
  let refreshSeq = 0;

  // Keep one v1 generation for audit and read-only recovery, exactly as before.
  database.exec('CREATE TABLE IF NOT EXISTS study_memory_state (id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL) STRICT');
  const goalId = resolveActiveGoal(database) ?? 'unassigned';
  if (!database.get('SELECT id FROM study_memory_state WHERE id = 1')) {
    try {
      const legacy = await readLegacyFile(file);
      if (legacy !== null) {
        for (const entry of [...legacy.items, ...legacy.tombstones]) entry.goalId ??= goalId;
        database.run('INSERT OR IGNORE INTO study_memory_state (id, json) VALUES (1, ?)', JSON.stringify(legacy));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[study] the v1 memory file could not be copied into the legacy table: ' + messageOf(error));
      }
    }
  }

  try {
    const migration = await migrateV1({ db: database, file, backupFile, goalId, now });
    if (migration.status === 'migrated') {
      console.info('[study] memory v1 migrated: ' + migration.items + ' items, ' + migration.tombstones + ' tombstones, backup ' + (migration.backup ?? '(already existed)'));
    }
  } catch (error) {
    let legacy = null;
    try {
      const source = await readLegacySource({ db: database, file });
      legacy = source?.state ?? null;
    } catch {
      legacy = null;
    }
    runtime.fallback = { error, legacy, backupFile };
    console.warn('[study] memory v1 migration failed; memory stays read-only until the backup is restored: ' + messageOf(error));
  }

  const methods = {
    remember: (payload, api) => {
      assertTableMode(runtime, 'remember');
      return remember(database, payload, api);
    },
    recall: (payload, api) => {
      assertTableMode(runtime, 'recall');
      return recall(database, payload, api);
    },
    forget: (payload, api) => {
      assertTableMode(runtime, 'forget');
      return forget(database, payload, api);
    },
    profileGet: (payload, api) => {
      assertTableMode(runtime, 'profileGet');
      return profileGet(database, payload, api);
    },
    profileExplain: (payload, api) => {
      assertTableMode(runtime, 'profileExplain');
      return profileExplain(database, payload, api);
    },
    profileSet: (payload, api) => {
      assertTableMode(runtime, 'profileSet');
      return profileSet(database, payload, api);
    },
    refreshTraits: (payload, api) => {
      assertTableMode(runtime, 'refreshTraits');
      return refreshTraits(database, payload, api);
    },
    export: (payload, api) => {
      assertTableMode(runtime, 'export');
      assertPayload(payload, EMPTY_KEYS, 'export');
      return exportSnapshot(database, api.now());
    },
  };

  ctx.effect(() => ctx.study.register('memory', {
    methods,
    writes: ['remember', 'forget', 'profileSet', 'refreshTraits'],
  }), 'study: memory namespace');

  // The learning module announces every committed capture / merge / split on
  // the next tick; recompute the inferred traits after it, so a re-ask changes
  // the next explanation without blocking the conversation.
  ctx.effect(() => ctx.on('study/learning/changed', event => {
    if (runtime.fallback !== null || database.isOpen !== true) return;
    const requestId = 'traits:' + (event?.kind ?? 'change') + ':' + now().toISOString() + ':' + (++refreshSeq);
    void ctx.study.call('memory', 'refreshTraits', {}, { actor: 'system', requestId }).then(result => {
      if (result?.ok !== true) {
        console.warn('[study] trait refresh skipped: ' + (result?.code ?? 'unknown') + ': ' + (result?.message ?? ''));
      }
    }, error => {
      console.warn('[study] trait refresh failed: ' + messageOf(error));
    });
  }), 'study: memory trait refresh');

  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(() => scoped.systemPrompt.context({
      name: 'study:memory',
      order: 500,
      text: () => renderContext(database, now, runtime),
    }), 'study: memory context');
  });

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: '把学生明确表达的偏好、短期状态或待确认观察写入学习记忆。只记录偏好/短期状态/观察，'
      + '不记录计划、任务或完成量（这些以学习服务为准）。传 id 可纠正已有记忆；与已删除记忆内容相同时默认拒绝，'
      + '只有用户本人可以显式恢复。',
    parameters: {
      requestId: { type: 'string', description: 'Stable write ID; executor callId is used when omitted.' },
      goalId: { type: 'string', description: 'Defaults to active goal.' },
      text: { type: 'string', required: true, description: '要记住的一句话；不超过 500 字。' },
      kind: { type: 'string', enum: [...KINDS], description: 'preference（长期偏好）/ state（短期状态，默认 7 天过期）/ observation（待确认观察）。' },
      id: { type: 'string', description: '要纠正的记忆 id；省略表示新增。' },
      ttlMs: { type: 'integer', description: '短期状态的有效期（毫秒），1 分钟到 90 天；省略时 state 默认 7 天。' },
      expiresAt: { type: 'string', description: '绝对过期时间（ISO 8601）；ttlMs 优先。' },
      note: { type: 'string', description: '来源补充说明，例如“来自 11 月 10 日的对话”；不写进记忆正文。' },
      revokeTombstone: { type: 'boolean', description: '仅用户本人可用：确认恢复一条此前被删除的同内容记忆。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderRememberResult(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const { requestId, ...payload } = args;
      const result = await ctx.study.call('memory', 'remember', payload, { actor: 'agent', requestId: toolRequestId(args, exec) });
      if (result.ok !== true) throw new Error('保存记忆失败（' + result.code + '）：' + result.message);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '记录记忆' }),
  })), 'study: memory tools');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '按中文关键词或直接列出学习记忆（偏好、短期状态、待确认观察）。过期状态默认不返回；'
      + '结果带创建/更新时间与来源，便于核对。不返回计划或完成量。',
    parameters: {
      requestId: { type: 'string', description: 'Stable write ID; executor callId is used when omitted.' },
      goalId: { type: 'string', description: 'Defaults to active goal.' },
      query: { type: 'string', description: '中文检索词；省略时按类型和时间列出。' },
      kind: { type: 'string', enum: [...KINDS], description: '只看某一类记忆。' },
      includeExpired: { type: 'boolean', description: '是否包含已过期的短期状态（默认否）。' },
      limit: { type: 'integer', description: '最多返回条数，1-50，默认 20。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderRecallResult(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const { requestId, ...payload } = args;
      const result = await ctx.study.call('memory', 'recall', payload, { actor: 'agent' });
      if (result.ok !== true) throw new Error('读取记忆失败（' + result.code + '）：' + result.message);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '检索记忆' }),
  })), 'study: memory tools');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: '删除一条或多条学习记忆并留下删除标记。删除后不会再被召回，也不会被旧对话内容重建；'
      + '只有用户本人之后明确要求，才能恢复同内容记忆。',
    parameters: {
      requestId: { type: 'string', description: 'Stable write ID; executor callId is used when omitted.' },
      goalId: { type: 'string', description: 'Defaults to active goal.' },
      id: { type: 'string', description: '要删除的记忆 id。' },
      query: { type: 'string', description: '按中文关键词删除匹配的记忆；与 id 二选一。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderForgetResult(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const { requestId, ...payload } = args;
      const result = await ctx.study.call('memory', 'forget', payload, { actor: 'agent', requestId: toolRequestId(args, exec) });
      if (result.ok !== true) throw new Error('删除记忆失败（' + result.code + '）：' + result.message);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '删除记忆' }),
  })), 'study: memory tools');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_profile',
    description: '读取或调整讲解参数（详细度、提示偏好、推进速度、例子顺序、步骤粒度、确认频率）。'
      + 'get 返回当前生效参数；explain 只用于核对某个参数的证据，不作为对话内容；'
      + 'set 仅在学生明确要求改变讲法时使用，下一轮生效。',
    parameters: {
      requestId: { type: 'string', description: 'Stable write ID; executor callId is used when omitted.' },
      action: { type: 'string', required: true, enum: ['get', 'explain', 'set'], description: 'get 读取；explain 看证据；set 改档。' },
      key: { type: 'string', enum: TRAITS.map(spec => spec.key), description: 'explain / set 需要：参数名。' },
      level: { type: 'number', description: 'set 需要：目标档位（整数或 0.5 档）。' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => [{ type: 'text', text: renderProfileResult(args?.action, value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const { action, requestId, ...payload } = args ?? {};
      if (!['get', 'explain', 'set'].includes(action)) throw new Error('action 必须是 get、explain 或 set');
      const method = { get: 'profileGet', explain: 'profileExplain', set: 'profileSet' }[action];
      const body = action === 'get' ? {} : action === 'explain' ? { key: payload.key } : { key: payload.key, level: payload.level };
      const options = { actor: 'agent' };
      if (action === 'set') options.requestId = toolRequestId(args, exec);
      const result = await ctx.study.call('memory', method, body, options);
      if (result.ok !== true) throw new Error('读取或调整讲解参数失败（' + result.code + '）：' + result.message);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '讲解参数' }),
  })), 'study: memory tools');
}

/* ------------------------------------------------------------------ writes */

/**
 * Store or correct one v1 memory row.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {object} payload - remember fields.
 * @param {object} api - Kernel call context.
 * @returns {{ status: string, id?: string, message?: string, item?: object }} Result.
 */
function remember(db, payload, api) {
  assertPayload(payload, ALLOWED_REMEMBER_KEYS, 'remember');
  const text = normalizeText(payload.text, '记忆正文');
  const id = payload.id === undefined ? undefined : normalizeId(payload.id);
  const goalId = resolveActiveGoal(db, payload.goalId) ?? 'unassigned';
  const existing = id === undefined ? undefined : itemById(db, id);
  if (id !== undefined && (existing === undefined || existing.goalId !== goalId || !KINDS.includes(existing.kind))) {
    throw new StudyError('not_found', '没有 id 为 ' + id + ' 的记忆', { id });
  }
  const kind = normalizeKind(payload.kind ?? existing?.kind ?? 'preference');
  const keepsExpiry = existing !== undefined && payload.ttlMs === undefined && payload.expiresAt === undefined;
  const at = api.now();
  const iso = at.toISOString();
  const expiresAt = keepsExpiry ? existing.validUntil : resolveExpiry(payload, kind, at);
  const contentHash = hashText(text);

  const tombstone = findTombstone(db, { goalId, contentHash });
  if (tombstone !== undefined && payload.revokeTombstone !== true) {
    return {
      status: 'suppressed',
      id: tombstone.id,
      message: '这条内容已被学生删除；旧对话不能把它重新写入记忆。只有学生本人明确要求时才能恢复。',
    };
  }
  if (tombstone !== undefined) {
    if (api.actor !== 'ui') {
      throw new StudyError('invalid', '只有用户本人可以恢复已删除的记忆；请让用户在记忆页确认恢复', { id: tombstone.id });
    }
    deleteTombstone(db, tombstone.id);
    api.change({
      entity: 'memory',
      entityId: tombstone.id,
      action: 'revoke_tombstone',
      before: { contentHash },
      after: { contentHash },
      reason: '用户明确要求恢复已删除的记忆',
    });
  }

  let item;
  let action;
  if (existing !== undefined) {
    action = 'update';
    item = {
      ...existing,
      goalId,
      text,
      kind,
      validUntil: expiresAt,
      updatedAt: iso,
      sourceActor: api.actor,
      lastConfirmedAt: iso,
    };
    updateItemContent(db, item);
  } else {
    if (countCurrentV1(db, goalId) >= MAX_ITEMS) {
      throw new StudyError('invalid', '记忆已达到 ' + MAX_ITEMS + ' 条上限；请先删除不再需要的记忆', { limit: MAX_ITEMS });
    }
    action = 'create';
    item = {
      id: createId(db),
      goalId,
      kind,
      key: null,
      text,
      value: null,
      confidence: 1,
      status: 'active',
      validFrom: iso,
      validUntil: expiresAt,
      supersededBy: null,
      sourceKind: 'explicit',
      sourceActor: api.actor,
      createdAt: iso,
      updatedAt: iso,
      lastConfirmedAt: iso,
    };
    insertItem(db, item);
  }

  api.change({
    entity: 'memory',
    entityId: item.id,
    action: 'memory.' + action,
    after: { kind: item.kind, textLength: item.text.length, contentHash, expiresAt: item.validUntil },
    reason: payload.note ?? null,
  });
  return { status: action === 'create' ? 'created' : 'updated', item: viewOf(item, at, api.requestId) };
}

/**
 * Delete v1 memories and leave tombstones that suppress the same content.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId?: string, id?: string, query?: string }} payload - Target selection.
 * @param {object} api - Kernel call context.
 * @returns {{ deleted: number, ids: string[] }} Deletion result.
 */
function forget(db, payload, api) {
  assertPayload(payload, ALLOWED_FORGET_KEYS, 'forget');
  const goalId = resolveActiveGoal(db, payload.goalId) ?? 'unassigned';
  const at = api.now();
  const iso = at.toISOString();
  const items = currentItems(db, { goalId, kinds: KINDS });
  let targets;
  if (payload.id !== undefined) {
    const id = normalizeId(payload.id);
    targets = items.filter(item => item.id === id);
    if (targets.length === 0) throw new StudyError('not_found', '没有 id 为 ' + id + ' 的记忆', { id });
  } else if (payload.query !== undefined) {
    const query = normalizeText(payload.query, '删除关键词');
    const tokens = tokensOf(query);
    targets = items.filter(item => scoreItem(tokens, normalizeForSearch(query), item) >= SCORE_THRESHOLD);
    if (targets.length === 0) throw new StudyError('not_found', '没有找到与关键词匹配的记忆', { query });
  } else {
    throw new StudyError('invalid', '删除记忆需要 id 或 query');
  }

  for (const item of targets) {
    const contentHash = hashText(item.text);
    deleteItem(db, item.id);
    insertTombstone(db, {
      id: item.id,
      contentHash,
      goalId: item.goalId,
      deletedAt: iso,
      source: { actor: api.actor, requestId: api.requestId ?? null, at: iso },
    });
    api.change({
      entity: 'memory',
      entityId: item.id,
      action: 'memory.delete',
      before: { kind: item.kind, textLength: item.text.length, contentHash },
      after: null,
      reason: '删除记忆并留下删除标记',
    });
  }
  pruneTombstones(db, MAX_TOMBSTONES);
  return { deleted: targets.length, ids: targets.map(item => item.id) };
}

/* ------------------------------------------------------------------- reads */

/**
 * List v1 memories with the same filtering and lexical scoring as before.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {object} payload - recall fields.
 * @param {object} api - Kernel call context.
 * @returns {{ items: object[], total: number, at: string }} Page of memories.
 */
function recall(db, payload, api) {
  assertPayload(payload, ALLOWED_RECALL_KEYS, 'recall');
  const at = api.now();
  const includeExpired = payload.includeExpired === true;
  const limit = payload.limit === undefined ? 20 : normalizeLimit(payload.limit);
  const kind = payload.kind === undefined ? undefined : normalizeKind(payload.kind);
  const query = payload.query === undefined ? undefined : normalizeText(payload.query, '检索词');
  const tokens = query === undefined ? undefined : tokensOf(query);
  const needle = query === undefined ? undefined : normalizeForSearch(query);
  const goalId = resolveActiveGoal(db, payload.goalId) ?? 'unassigned';

  let items = currentItems(db, { goalId, kinds: kind === undefined ? KINDS : [kind] })
    .filter(item => includeExpired || !isExpired(item, at));
  if (tokens !== undefined) {
    items = items
      .map(item => ({ item, score: scoreItem(tokens, needle, item) }))
      .filter(entry => entry.score >= SCORE_THRESHOLD)
      .sort((left, right) => right.score - left.score || right.item.updatedAt.localeCompare(left.item.updatedAt))
      .map(entry => entry.item);
  } else {
    items = items.sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      || right.updatedAt.localeCompare(left.updatedAt));
  }
  items = items.slice(0, limit);
  return {
    items: items.map(item => viewOf(item, at)),
    total: items.length,
    at: at.toISOString(),
  };
}

/**
 * Build a `memory.json`-compatible snapshot from the SQLite tables. The v1
 * format only knows preference / state / observation; the four later kinds
 * (trait, topic_state, strategy, episode) are derived or analysis data and are
 * intentionally left out so the output can be read by the v1 loader.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {Date} at - Export instant.
 * @returns {{ version: number, items: object[], tombstones: object[], exportedAt: string }} Snapshot.
 */
function exportSnapshot(db, at) {
  const items = db.all(
    `SELECT * FROM study_memory_item
      WHERE kind IN ('preference', 'state', 'observation')
        AND status = 'active' AND superseded_by IS NULL
      ORDER BY created_at ASC, id ASC`,
  ).map(row => ({
    id: String(row.id),
    goalId: String(row.goal_id),
    kind: String(row.kind),
    text: String(row.text),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: row.valid_until === null ? null : String(row.valid_until),
    source: {
      actor: String(row.source_actor),
      kind: String(row.source_kind),
    },
  }));
  const tombstones = db.all(
    'SELECT * FROM study_memory_tombstone ORDER BY deleted_at ASC, id ASC',
  ).map(row => ({
    id: String(row.id),
    contentHash: String(row.content_hash),
    goalId: String(row.goal_id),
    deletedAt: String(row.deleted_at),
    source: parseSnapshotJson(row.source_json) ?? { actor: 'internal', at: String(row.deleted_at) },
  }));
  return {
    version: 1,
    items,
    tombstones,
    exportedAt: at.toISOString(),
    profileMarkdown: profileMarkdown(db, at),
  };
}

/**
 * Render the current six teaching parameters as Markdown, so an export carries
 * both the v1-compatible JSON and a human-readable profile.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {Date} at - Export instant.
 * @returns {string} Markdown profile.
 */
function profileMarkdown(db, at) {
  const goalId = resolveActiveGoal(db) ?? 'unassigned';
  let traits;
  try {
    traits = evaluateAllTraits({ db, goalId, now: at });
  } catch {
    traits = TRAITS.map(spec => ({
      spec,
      level: spec.defaultLevel,
      text: behaviorText(spec.key, spec.defaultLevel),
    }));
  }
  return [
    '# 学生画像',
    '',
    ...traits.map(trait => `- ${trait.spec.key}：${trait.level}/${trait.spec.max}（${trait.text}）`),
    '',
  ].join('\n');
}

function parseSnapshotJson(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/**
 * Current effective teaching parameters plus memory counts.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {object} payload - Must be empty.
 * @param {object} api - Kernel call context.
 * @returns {{ goalId: string, traits: object[], memories: Record<string, number>, at: string }} Profile snapshot.
 */
function profileGet(db, payload, api) {
  assertPayload(payload, EMPTY_KEYS, 'profileGet');
  const at = api.now();
  const goalId = resolveActiveGoal(db) ?? 'unassigned';
  const traits = evaluateAllTraits({ db, goalId, now: at }).map(viewTrait);
  const memories = { preference: 0, state: 0, observation: 0 };
  for (const item of currentItems(db, { goalId, kinds: KINDS })) {
    if (!isExpired(item, at)) memories[item.kind] += 1;
  }
  return { goalId, traits, memories, at: at.toISOString() };
}

/**
 * Evidence behind one trait; the contract never includes this.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ key: string }} payload - Trait key.
 * @param {object} api - Kernel call context.
 * @returns {object} Trait, evidence, and computed statistics.
 */
function profileExplain(db, payload, api) {
  assertPayload(payload, ALLOWED_PROFILE_EXPLAIN_KEYS, 'profileExplain');
  const spec = traitSpec(payload.key);
  const at = api.now();
  const goalId = resolveActiveGoal(db) ?? 'unassigned';
  const { current, stats, decision } = evaluateTrait({ db, spec, goalId, now: at });
  const effective = evaluateAllTraits({ db, goalId, now: at }).find(trait => trait.spec.key === spec.key);
  return {
    trait: viewTrait(effective),
    evidence: stats.evidence.map(entry => ({
      refKind: entry.refKind,
      refId: entry.refId,
      at: entry.at,
      weight: round4(entry.weight),
      positive: entry.positive,
    })),
    computed: {
      value: round4(stats.value),
      confidence: round4(stats.confidence),
      alpha: round4(stats.alpha),
      beta: round4(stats.beta),
      units: stats.units,
      spanDays: round4(stats.spanDays),
      latestAt: stats.latestAt,
      evidenceCount: stats.evidenceCount,
    },
    decision: {
      level: roundLevel(decision.level),
      active: decision.active,
      reason: decision.reason,
      desired: decision.desired === undefined ? null : roundLevel(decision.desired),
    },
    current: current === undefined ? null : {
      id: current.id,
      level: storedTraitValue(spec, current).level,
      sourceKind: current.sourceKind,
      validFrom: current.validFrom,
      updatedAt: current.updatedAt,
    },
  };
}

/**
 * Explicitly set one trait level; bypasses inference gating and takes effect on
 * the next request.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ key: string, level: number }} payload - Trait and target level.
 * @param {object} api - Kernel call context.
 * @returns {{ status: string, itemId: string, trait: object }} New current version.
 */
function profileSet(db, payload, api) {
  assertPayload(payload, ALLOWED_PROFILE_SET_KEYS, 'profileSet');
  const spec = traitSpec(payload.key);
  const level = normalizeTraitLevel(spec, payload.level);
  const at = api.now();
  const iso = at.toISOString();
  const goalId = resolveActiveGoal(db) ?? 'unassigned';
  const current = currentItemByKey(db, { goalId, kind: 'trait', key: spec.key });
  const text = behaviorText(spec.key, level);
  const value = { value: round4(valueOfLevel(spec, level)), level: roundLevel(level), alpha: 1, beta: 1 };

  if (current !== undefined && current.sourceKind === 'user_edit' && storedTraitValue(spec, current).level === level) {
    current.text = text;
    current.value = value;
    current.confidence = 1;
    current.updatedAt = iso;
    current.lastConfirmedAt = iso;
    updateItemMetadata(db, current);
    return {
      status: 'confirmed',
      itemId: current.id,
      trait: viewTrait(evaluateAllTraits({ db, goalId, now: at }).find(trait => trait.spec.key === spec.key)),
    };
  }

  const item = {
    id: 'tra_' + randomToken(),
    goalId,
    kind: 'trait',
    key: spec.key,
    text,
    value,
    confidence: 1,
    status: 'active',
    validFrom: iso,
    validUntil: null,
    supersededBy: null,
    sourceKind: 'user_edit',
    sourceActor: api.actor,
    createdAt: iso,
    updatedAt: iso,
    lastConfirmedAt: iso,
  };
  insertItem(db, item);
  if (current !== undefined) supersedeItem(db, { id: current.id, supersededBy: item.id, at: iso });
  api.change({
    entity: 'memory',
    entityId: item.id,
    action: 'trait.correct',
    before: current === undefined ? null : { id: current.id, level: storedTraitValue(spec, current).level },
    after: { key: spec.key, level, id: item.id },
    reason: '用户显式改档',
  });
  return {
    status: 'updated',
    itemId: item.id,
    trait: viewTrait(evaluateAllTraits({ db, goalId, now: at }).find(trait => trait.spec.key === spec.key)),
  };
}

/**
 * Recompute inferred traits and persist one version per effective level.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {object} payload - Must be empty.
 * @param {object} api - Kernel call context.
 * @returns {{ changed: object[], traits: object[] }} Level changes and current profile.
 */
function refreshTraits(db, payload, api) {
  assertPayload(payload, EMPTY_KEYS, 'refreshTraits');
  const at = api.now();
  const iso = at.toISOString();
  const goalId = resolveActiveGoal(db) ?? 'unassigned';
  const changed = [];

  for (const spec of TRAITS) {
    if (!spec.inferred) continue;
    const current = currentItemByKey(db, { goalId, kind: 'trait', key: spec.key });
    const { stats, decision } = evaluateTrait({ db, spec, goalId, now: at });
    const currentLevel = current === undefined ? undefined : storedTraitValue(spec, current).level;

    if (current !== undefined && current.sourceKind === 'user_edit') {
      // A correction is respected until three new independent units over at
      // least fourteen days contradict it again.
      const auto = evaluateAutoTrait({ spec, stats, now: at, needsColdStart: true });
      if (auto.active && auto.level !== currentLevel) {
        persistTraitVersion(db, api, { spec, goalId, at: iso, stats, level: auto.level, reason: 'correction_replaced', current });
        changed.push({ key: spec.key, from: currentLevel, to: auto.level, reason: 'correction_replaced' });
      }
      continue;
    }

    if (!decision.active) {
      if (current !== undefined && current.sourceKind === 'inferred') {
        // Decay and disappearing evidence fall back to the default level in
        // place; `retired` is reserved for an explicit retirement.
        current.text = behaviorText(spec.key, spec.defaultLevel);
        current.value = traitValue(stats, spec.defaultLevel);
        current.confidence = round4(stats.confidence);
        current.updatedAt = iso;
        current.lastConfirmedAt = stats.latestAt;
        updateItemMetadata(db, current);
        replaceEvidence(db, current.id, evidenceRows(stats));
        if (currentLevel !== spec.defaultLevel) {
          api.change({
            entity: 'memory',
            entityId: current.id,
            action: 'trait.decay',
            before: { key: spec.key, level: currentLevel },
            after: { key: spec.key, level: spec.defaultLevel },
            reason: decision.reason,
          });
          changed.push({ key: spec.key, from: currentLevel, to: spec.defaultLevel, reason: decision.reason });
        }
      }
      continue;
    }

    if (current === undefined || decision.level !== currentLevel) {
      persistTraitVersion(db, api, { spec, goalId, at: iso, stats, level: decision.level, reason: decision.reason, current });
      changed.push({ key: spec.key, from: currentLevel ?? null, to: decision.level, reason: decision.reason });
      continue;
    }

    current.text = behaviorText(spec.key, decision.level);
    current.value = traitValue(stats, decision.level);
    current.confidence = round4(stats.confidence);
    current.updatedAt = iso;
    current.lastConfirmedAt = stats.latestAt;
    updateItemMetadata(db, current);
    replaceEvidence(db, current.id, evidenceRows(stats));
  }

  return {
    changed,
    traits: evaluateAllTraits({ db, goalId, now: at }).map(viewTrait),
  };
}

/**
 * Insert a fresh inferred version and supersede the previous one.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {object} api - Kernel call context.
 * @param {{ spec: object, goalId: string, at: string, stats: object, level: number, reason: string, current?: object }} options - Version inputs.
 * @returns {object} New item.
 */
function persistTraitVersion(db, api, { spec, goalId, at, stats, level, reason, current }) {
  const item = {
    id: 'tra_' + randomToken(),
    goalId,
    kind: 'trait',
    key: spec.key,
    text: behaviorText(spec.key, level),
    value: traitValue(stats, level),
    confidence: round4(stats.confidence),
    status: 'active',
    validFrom: at,
    validUntil: null,
    supersededBy: null,
    sourceKind: 'inferred',
    sourceActor: 'system',
    createdAt: at,
    updatedAt: at,
    lastConfirmedAt: stats.latestAt,
  };
  insertItem(db, item);
  if (current !== undefined) supersedeItem(db, { id: current.id, supersededBy: item.id, at });
  replaceEvidence(db, item.id, evidenceRows(stats));
  api.change({
    entity: 'memory',
    entityId: item.id,
    action: 'trait.change',
    before: current === undefined ? null : { id: current.id, level: storedTraitValue(spec, current).level },
    after: { key: spec.key, level, reason },
    reason,
  });
  return item;
}

/* --------------------------------------------------------------- contract */

/**
 * Render the dynamic prompt context: the teaching contract, or the v1 snapshot
 * when no trait is effective (and the read-only fallback after a failed
 * migration).
 * @param {import('../db.mjs').StudyDatabase} database - Open study database.
 * @param {() => Date} now - Clock.
 * @param {{ fallback: object | null }} runtime - Migration state.
 * @returns {string} Context text, or '' when there is nothing to inject.
 */
function renderContext(database, now, runtime) {
  const at = now();
  if (runtime.fallback !== null) {
    if (runtime.fallback.legacy === null) return '（学习记忆暂时无法读取：' + messageOf(runtime.fallback.error) + '）';
    const legacyItems = [...runtime.fallback.legacy.items]
      .filter(item => item.expiresAt === null || item.expiresAt === undefined || Date.parse(item.expiresAt) > at.getTime())
      .sort((left, right) => (KIND_ORDER[left.kind] ?? 9) - (KIND_ORDER[right.kind] ?? 9) || String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, MAX_INJECTED)
      .map(item => ({ kind: item.kind, text: truncate(item.text, MAX_INJECTED_CHARS), expiresAt: item.expiresAt ?? null }));
    return renderV1Snapshot(legacyItems, MAX_INJECTED);
  }
  try {
    const goalId = resolveActiveGoal(database) ?? 'unassigned';
    const traits = evaluateAllTraits({ db: database, goalId, now: at });
    const items = currentItems(database, { goalId, kinds: KINDS })
      .filter(item => !isExpired(item, at))
      .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
        || right.updatedAt.localeCompare(left.updatedAt));
    const effective = traits.filter(trait => trait.active && trait.level !== trait.defaultValue);
    if (effective.length === 0) {
      return renderV1Snapshot(items.slice(0, MAX_INJECTED).map(item => ({
        kind: item.kind,
        text: truncate(item.text, MAX_INJECTED_CHARS),
        expiresAt: item.validUntil,
      })), MAX_INJECTED);
    }
    return compileContract({
      traits,
      memories: items.slice(0, MAX_CONTRACT_MEMORIES).map(item => ({
        kind: item.kind,
        text: truncate(item.text, MAX_CONTRACT_MEMORY_CHARS),
        expiresAt: item.validUntil,
      })),
      maxMemories: MAX_CONTRACT_MEMORIES,
    });
  } catch (error) {
    return '（学习记忆暂时无法读取：' + messageOf(error) + '）';
  }
}

/* --------------------------------------------------------------- rendering */

function renderRememberResult(value) {
  if (value?.status === 'suppressed') return '未写入：' + value.message;
  const label = value?.status === 'created' ? '已记住' : '已更新';
  return (label + '（' + (value?.item?.id ?? '?') + '）：' + (value?.item?.kindLabel ?? '') + ' ' + (value?.item?.text ?? '')).trim();
}

function renderRecallResult(value) {
  if (!value || value.items.length === 0) return '没有找到符合条件的记忆。';
  return value.items.map(item => {
    const expiry = item.expiresAt === null ? '' : '（' + (item.expired ? '已过期' : '到 ' + item.expiresAt.slice(0, 10)) + '）';
    return '- ' + item.id + ' [' + item.kindLabel + ']' + expiry + ' ' + item.text + '\n  来源：' + item.source.actor + '｜更新：' + item.updatedAt.slice(0, 10);
  }).join('\n');
}

function renderForgetResult(value) {
  return '已删除 ' + value.deleted + ' 条记忆（' + value.ids.join('、') + '）；删除标记已保留，旧内容不会被重新召回。';
}

function renderProfileResult(action, value) {
  if (action === 'set') {
    return '已调整：' + traitLine(value?.trait) + '；下一轮生效。';
  }
  if (action === 'explain') {
    const trait = value?.trait;
    const computed = value?.computed;
    const evidence = Array.isArray(value?.evidence) ? value.evidence : [];
    const latest = evidence.at(-1)?.at?.slice(0, 10) ?? '无';
    return traitLine(trait) + '｜证据 ' + evidence.length + ' 条｜最近 ' + latest
      + '｜置信度 ' + (computed?.confidence ?? 0) + '｜' + (value?.decision?.reason ?? '');
  }
  const traits = Array.isArray(value?.traits) ? value.traits : [];
  return '画像：' + traits.map(traitLine).join('；') + '。';
}

function traitLine(trait) {
  if (trait === undefined || trait === null) return '无';
  return traitName(trait.key) + ' ' + trait.level + '（' + trait.text + '）';
}

function traitName(key) {
  return { explain_detail: '详细度', hint_preference: '提示偏好', pace: '推进速度', example_first: '例子顺序', step_granularity: '步骤粒度', check_frequency: '确认频率' }[key] ?? key;
}

/* ----------------------------------------------------------------- helpers */

function viewOf(item, at, requestId) {
  return {
    id: item.id,
    goalId: item.goalId,
    kind: item.kind,
    kindLabel: KIND_LABELS[item.kind],
    text: item.text,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.validUntil,
    expired: isExpired(item, at),
    source: {
      actor: item.sourceActor,
      requestId: requestId ?? null,
      at: item.updatedAt,
    },
  };
}

function viewTrait(trait) {
  if (trait === undefined) throw new StudyError('unavailable', '讲解参数读取失败');
  const spec = trait.spec;
  return {
    key: spec.key,
    level: roundLevel(trait.level),
    defaultLevel: spec.defaultLevel,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    active: trait.active,
    reason: trait.reason,
    sourceKind: trait.sourceKind,
    confidence: round4(trait.confidence),
    value: round4(trait.value),
    evidenceCount: trait.evidenceCount,
    unitCount: trait.unitCount,
    text: trait.text,
    updatedAt: trait.updatedAt,
  };
}

function traitValue(stats, level) {
  return {
    value: round4(stats.value),
    level: roundLevel(level),
    alpha: round4(stats.alpha),
    beta: round4(stats.beta),
  };
}

function evidenceRows(stats) {
  return stats.evidence.map(entry => ({
    refKind: entry.refKind,
    refId: entry.refId,
    weight: round4(entry.weight),
    at: entry.at,
  }));
}

function isExpired(item, at) {
  return item.validUntil !== null && Date.parse(item.validUntil) <= at.getTime();
}

function countCurrentV1(db, goalId) {
  return Number(db.get(
    "SELECT COUNT(*) AS count FROM study_memory_item WHERE goal_id = ? AND kind IN ('preference', 'state', 'observation') AND status = 'active' AND superseded_by IS NULL",
    goalId,
  ).count);
}

function resolveExpiry(payload, kind, at) {
  if (payload.ttlMs !== undefined) {
    if (!Number.isSafeInteger(payload.ttlMs) || payload.ttlMs < MIN_TTL_MS || payload.ttlMs > MAX_TTL_MS) {
      throw new StudyError('invalid', 'ttlMs 必须是 ' + MIN_TTL_MS + ' 到 ' + MAX_TTL_MS + ' 之间的整数');
    }
    return new Date(at.getTime() + payload.ttlMs).toISOString();
  }
  if (payload.expiresAt !== undefined) {
    const parsed = Date.parse(payload.expiresAt);
    if (!Number.isFinite(parsed)) throw new StudyError('invalid', 'expiresAt 必须是可解析的 ISO 8601 时间');
    if (parsed <= at.getTime()) throw new StudyError('invalid', 'expiresAt 必须晚于当前时间');
    return new Date(parsed).toISOString();
  }
  if (kind === 'state') return new Date(at.getTime() + DEFAULT_STATE_TTL_MS).toISOString();
  return null;
}

function normalizeText(value, label) {
  if (typeof value !== 'string') throw new StudyError('invalid', label + '必须是字符串');
  const text = value.trim();
  if (text.length === 0) throw new StudyError('invalid', label + '不能为空');
  if (text.length > MAX_TEXT) throw new StudyError('invalid', label + '不能超过 ' + MAX_TEXT + ' 字', { length: text.length, limit: MAX_TEXT });
  return text;
}

function normalizeKind(value) {
  if (typeof value !== 'string' || !KINDS.includes(value)) {
    throw new StudyError('invalid', 'kind 必须是 ' + KINDS.join('、') + ' 之一');
  }
  return value;
}

function normalizeId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new StudyError('invalid', '记忆 id 格式不合法');
  }
  return value;
}

function normalizeLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new StudyError('invalid', 'limit 必须是 1-50 的整数');
  }
  return value;
}

function normalizeTraitLevel(spec, value) {
  if (!isTraitLevel(spec, value)) {
    const levels = [];
    for (let level = spec.min; level <= spec.max + 1e-9; level += spec.step) levels.push(roundLevel(level));
    throw new StudyError('invalid', spec.key + ' 的档位必须是 ' + levels.join('、') + ' 之一', { key: spec.key, level: value });
  }
  return roundLevel(value);
}

function assertPayload(payload, allowed, method) {
  if (!isPlainObject(payload)) throw new StudyError('invalid', method + ' 的载荷必须是对象');
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new StudyError('invalid', method + ' 不接受字段 ' + key + '；记忆只保存偏好、短期状态和待确认观察，不保存计划或完成量副本', { field: key });
    }
  }
}

function assertTableMode(runtime, method) {
  if (runtime.fallback === null) return;
  const reason = messageOf(runtime.fallback.error);
  throw new StudyError(
    'unavailable',
    '学习记忆迁移失败，' + method + ' 暂不可用；原数据未改动，请用数据目录下的 ' + BACKUP_NAME + ' 恢复。原因：' + reason,
    { method, backup: runtime.fallback.backupFile, reason },
  );
}

function createId(db) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = 'mem_' + createHash('sha1').update(Date.now() + '-' + Math.random() + '-' + attempt).digest('hex').slice(0, 12);
    if (db.get('SELECT id FROM study_memory_item WHERE id = ?', id) === undefined
      && db.get('SELECT id FROM study_memory_tombstone WHERE id = ?', id) === undefined) return id;
  }
  throw new StudyError('unavailable', '无法生成唯一的记忆 id');
}

function randomToken() {
  return createHash('sha1').update(Date.now() + '-' + Math.random()).digest('hex').slice(0, 12);
}

function hashText(text) {
  return createHash('sha256').update(normalizeForSearch(text)).digest('hex');
}

function normalizeForSearch(text) {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()\[\]{}<>《》]/g, '');
}

function tokensOf(text) {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens = new Set();
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const run = match[0];
    for (const character of run) tokens.add(character);
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2));
  }
  for (const match of normalized.matchAll(/[a-z0-9]+/g)) tokens.add(match[0]);
  return tokens;
}

function scoreItem(queryTokens, needle, item) {
  const text = item.text;
  if (needle.length > 0 && normalizeForSearch(text).includes(needle)) return 1;
  const tokens = tokensOf(text + ' ' + (KIND_LABELS[item.kind] ?? ''));
  let hits = 0;
  let total = 0;
  for (const token of queryTokens) {
    const weight = Math.max(1, token.length);
    total += weight;
    if (tokens.has(token)) hits += weight;
  }
  if (total === 0) return 0;
  const kindBonus = queryTokens.has(item.kind) ? 0.2 : 0;
  return Math.min(1, hits / total + kindBonus);
}

function truncate(text, length) {
  return text.length <= length ? text : text.slice(0, length - 1) + '…';
}

function round4(value) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(4));
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readLegacyFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StudyError('unavailable', '无法读取记忆文件 ' + file, { file, reason: error.message });
  }
  return parseLegacyState(text, file);
}
