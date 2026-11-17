/**
 * Export module: build one JSON document with the student's learning data,
 * expose it to the Agent as `study_export`, and serve it from the authenticated
 * `GET /api/study/export.json` route for the app's own origin.
 *
 * The export reads only the study database and `memory.json` beside it. It
 * never reads the credential store, logs, Electron profile, or the request
 * idempotency cache, so a credential cannot ride along by accident. As a second
 * guard, keys that name a credential and values that look like a known API
 * token abort the export instead of writing a package that contains them.
 *
 * `request_log` is deliberately not exported: it is an internal replay cache,
 * not student data. Cold backups still preserve it because they copy the whole
 * data root. Derived outcomes are read through the optional outcomes service;
 * table names never imply that a disabled plugin is available.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { StudyError, isPlainObject } from '../../../../packages/study-contracts/index.mjs';

/** Module id; no service namespace is registered, so it differs from the namespace list. */
export const id = 'export';

/** Export needs the kernel module's database; declaring it keeps module order explicit. */
export const deps = ['kernel'];

/** No tables: the export reads the existing modules' tables. */
export const schema = [];

/** Schema version for a schema-less module (never recorded). */
export const schemaVersion = 1;

/** Stable format marker written into every export. */
export const EXPORT_FORMAT = 'studybuddy-export';

/** Version of the export document layout. */
export const EXPORT_FORMAT_VERSION = 1;

/** Route served from the app's own authenticated origin. */
export const EXPORT_ROUTE = '/api/study/export.json';

const FILE_VERSION = 1;
const MAX_FILENAME_ATTEMPTS = 100;

/**
 * Tables copied into `data`, in document order. Names come from the shipped
 * modules; the query is still guarded by `sqlite_master` so a database created
 * before that module loaded can be exported.
 */
const TABLE_GROUPS = Object.freeze([
  ['goals', 'study_goal'],
  ['goalWorkspaces', 'study_goal_workspace'],
  ['materials', 'study_material'],
  ['materialChunks', 'study_material_chunk'],
  ['tasks', 'study_task'],
  ['timeBlocks', 'study_time_block'],
  ['plans', 'study_plan'],
  ['planRevisions', 'study_plan_revision'],
  ['planDrafts', 'study_plan_draft'],
  ['progress', 'study_plan_progress'],
  ['taskProgress', 'study_task_progress'],
]);

const KNOWN_TABLES = new Set(TABLE_GROUPS.map(([, table]) => table));
const CORE_TABLES = new Set(['meta', 'module_schema', 'request_log', 'change_log', 'day_snapshot']);
const EXCLUDED_STUDY_TABLES = new Set(['study_turn', 'study_episode_problem', 'study_episode_turn', 'study_capture_gap', 'study_memory_state']);

const CREDENTIAL_KEYS = /^(api[-_]?key|apikey|password|passwd|secret|token|access[-_]?token|refresh[-_]?token|authorization|cookie|credentials?)$/i;

/** High-confidence token formats; a study note that happens to contain one is refused rather than exported. */
const SECRET_VALUE_PATTERNS = Object.freeze([
  { id: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]);

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { defineTool } = requireFromSource(join(sourceDirectory, 'packages/core/tools/lib/index.js'));

/**
 * Register the export tool and, when the host has a web connection, the
 * authenticated download route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {{ database: import('../db.mjs').StudyDatabase }} kernel - Kernel handle.
 */
export function apply(ctx, kernel) {
  const dataDir = dirname(kernel.database.file);

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_export',
    description: '把学习数据导出成一份 JSON 文件：目标、资料与片段、任务与时间块、计划与修订、进度、日周月成果快照、'
      + '记忆、变更历史。不含凭据、日志、Electron 配置或请求幂等缓存。只读学习数据，并在学习数据目录的 exports 子目录新写一个导出文件；'
      + '不会修改、删除或上传任何学习数据。',
    parameters: {
      periods: { type: 'array', items: { type: 'string', enum: ['day', 'week', 'month'] }, description: '成果周期，默认当前日、周、月。' },
      includeFacts: { type: 'boolean', description: '是否包含原始学习事实，默认是；不含原始会话与附件。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderExportResult(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const result = await writeStudyExport({ database: kernel.database, dataDir, study: ctx.study, ...exportSelection(args) });
      return result;
    },
    presentCall: () => ({ card: 'generic', title: '导出学习数据' }),
  })), 'study: study_export tool');

  ctx.inject(['connection'], scoped => {
    scoped.effect(() => scoped.connection.fetch.register({
      path: EXPORT_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: request => serveExport(kernel.database, dataDir, ctx.study, request),
    }), 'study: export route');
  });
}

/**
 * Build the export document from one open study database.
 *
 * All database reads are synchronous, so the document observes one revision:
 * the service kernel cannot interleave a write while the builder is running.
 * @param {{
 *   database: { get: Function, all: Function, file?: string },
 *   dataDir?: string,
 *   now?: () => Date,
 * }} options - Open database, its data directory (defaults to the database's own), and clock.
 * @returns {object} Export document, including `summary`, `data`, and `checksum`.
 * @throws {StudyError} `unavailable` when the database or memory file cannot be read safely.
 */
export function buildStudyExport({ database, dataDir = dirname(database.file), now = () => new Date(), study, periods = ['day', 'week', 'month'], includeFacts = true, outcomeSnapshot } = {}) {
  const selection = exportSelection({ periods, includeFacts });
  if (study !== undefined) return collectOutcomes(study, selection.periods).then(snapshot => {
    if (snapshot.revision !== undefined && snapshot.revision !== Number(database.get("SELECT value FROM meta WHERE key = 'revision'")?.value ?? 0)) {
      throw new StudyError('unavailable', '导出期间学习数据发生变化，请重试');
    }
    return buildStudyExport({ database, dataDir, now, ...selection, outcomeSnapshot: snapshot });
  });
  if (database === undefined || typeof database.get !== 'function' || typeof database.all !== 'function') {
    throw new TypeError('buildStudyExport needs an open study database');
  }
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('buildStudyExport needs the study data directory');
  }

  const tables = new Set(database.all("SELECT name FROM sqlite_master WHERE type = 'table'").map(row => String(row.name)));
  if (!tables.has('meta')) {
    throw new StudyError('unavailable', '学习数据库缺少元数据表，无法导出', { file: database.file ?? null });
  }
  const revisionRow = database.get("SELECT value FROM meta WHERE key = 'revision'");
  const revision = revisionRow === undefined ? 0 : Number(revisionRow.value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new StudyError('unavailable', '学习数据库的修订号损坏，已停止导出', { file: database.file ?? null });
  }

  const data = {};
  const summary = {};
  for (const [key, table] of TABLE_GROUPS) {
    const rows = tables.has(table) ? readRows(database, table, { ordered: true }) : [];
    data[key] = rows.map((row, index) => decodeJsonColumns(row, `${key}[${index}]`));
    summary[key] = data[key].length;
  }

  const otherTables = {};
  for (const table of [...tables].sort()) {
    if (!table.startsWith('study_') || KNOWN_TABLES.has(table) || table.includes('_fts') || EXCLUDED_STUDY_TABLES.has(table)) continue;
    otherTables[table] = readRows(database, table).map((row, index) => decodeJsonColumns(row, `${table}[${index}]`));
  }
  data.outcomes = outcomeSnapshot?.items ?? [];
  data.otherTables = otherTables;
  summary.outcomes = data.outcomes.length;
  summary.otherTables = Object.fromEntries(Object.entries(otherTables).map(([name, rows]) => [name, rows.length]));

  data.memory = tables.has('study_memory_item') ? readSqliteMemory(database) : readMemory(dataDir);
  summary.memories = data.memory.items.length;
  summary.memoryTombstones = data.memory.tombstones.length;

  data.changeLog = tables.has('change_log')
    ? readRows(database, 'change_log', { ordered: true }).map((row, index) => decodeChangeLog(row, index))
    : [];
  summary.changeLog = data.changeLog.length;

  const modules = tables.has('module_schema')
    ? database.all('SELECT module_id, schema_version FROM module_schema ORDER BY module_id')
      .map(row => ({ id: String(row.module_id), schemaVersion: Number(row.schema_version) }))
    : [];
  const writerVersion = Number(database.get('PRAGMA user_version')?.user_version ?? 0);
  const outcomesAvailable = outcomeSnapshot?.available === true;
  if (!includeFacts) {
    for (const key of Object.keys(data)) if (key !== 'outcomes') delete data[key];
    for (const key of Object.keys(summary)) if (key !== 'outcomes') delete summary[key];
  }

  const document = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: now().toISOString(),
    revision,
    selection,
    source: {
      product: 'StudyBuddy',
      database: 'study.db',
      coreSchemaVersion: writerVersion,
      modules,
    },
    availability: {
      outcomes: {
        available: outcomesAvailable,
        reason: outcomesAvailable ? null : outcomeSnapshot?.reason ?? 'outcomes_service_not_registered',
      },
    },
    excluded: ['credentials', 'request_log', 'logs', 'electron-user-data', 'material_search_index', 'raw_conversations', 'attachments'],
    summary,
    data,
  };
  document.checksum = {
    algorithm: 'sha256',
    covers: 'formatVersion+revision+data',
    value: sha256(JSON.stringify({ formatVersion: document.formatVersion, revision, data })),
  };

  assertNoCredentialMaterial(document);
  return document;
}

/**
 * Serialize one export document exactly as it is written to disk.
 * @param {object} document - Result of {@link buildStudyExport}.
 * @returns {string} Pretty JSON with one trailing newline.
 */
export function serializeStudyExport(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Build and atomically write one export file below `<dataDir>/exports`.
 * @param {{
 *   database: { get: Function, all: Function, file?: string },
 *   dataDir?: string,
 *   now?: () => Date,
 * }} options - Same inputs as {@link buildStudyExport}.
 * @returns {Promise<{
 *   path: string, bytes: number, sha256: string, dataChecksum: string,
 *   generatedAt: string, revision: number, summary: object,
 *   availability: object, excluded: string[],
 * }>} Written file facts; the full data stays in the file, not in the Agent result.
 */
export async function writeStudyExport({ database, dataDir = dirname(database.file), now = () => new Date(), ...options } = {}) {
  const document = await buildStudyExport({ database, dataDir, now, ...options });
  const text = serializeStudyExport(document);
  const directory = join(dataDir, 'exports');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await uniqueExportPath(directory, now());
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    throw new StudyError('unavailable', '无法写入导出文件，本次导出未完成', {
      directory,
      reason: error.message,
    });
  }
  return {
    path: file,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
    dataChecksum: document.checksum.value,
    generatedAt: document.generatedAt,
    revision: document.revision,
    summary: document.summary,
    availability: document.availability,
    excluded: document.excluded,
  };
}

/**
 * Candidate export file name for one instant, in local time.
 * @param {Date} [date] - Instant to name; defaults to now.
 * @returns {string} File name without directory.
 */
export function exportFileName(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `studybuddy-export-${stamp}.json`;
}

/* --------------------------------------------------------------- internals */

/**
 * Serve the export document as a download on the authenticated route.
 * @param {object} database - Open study database.
 * @param {string} dataDir - Study data directory.
 * @returns {Promise<Response>} JSON attachment or a sanitized failure.
 */
async function serveExport(database, dataDir, study, request) {
  try {
    if (request?.method === 'POST') {
      let payload;
      try { payload = await request.json(); } catch { throw new StudyError('invalid', '导出选项不是合法 JSON'); }
      const value = await writeStudyExport({ database, dataDir, study, ...exportSelection(payload) });
      return Response.json({ ok: true, value, revision: value.revision }, { headers: { 'cache-control': 'no-store' } });
    }
    const document = await buildStudyExport({ database, dataDir, study });
    return new Response(serializeStudyExport(document), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFileName()}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const known = error instanceof StudyError;
    return Response.json({
      ok: false,
      code: known ? error.code : 'unavailable',
      message: known ? error.message : '导出学习数据失败，本次未生成文件',
      details: known ? error.details : { reason: error instanceof Error ? error.message : String(error) },
    }, {
      status: known && error.code === 'invalid' ? 400 : 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}

function exportSelection(payload = {}) {
  if (!isPlainObject(payload) || Object.keys(payload).some(key => !['periods', 'includeFacts'].includes(key))) throw new StudyError('invalid', '导出只接受 periods 和 includeFacts');
  const periods = payload.periods ?? ['day', 'week', 'month'];
  if (!Array.isArray(periods) || periods.length === 0 || periods.some(period => !['day', 'week', 'month'].includes(period))) throw new StudyError('invalid', '成果周期请选择 day、week 或 month');
  if (payload.includeFacts !== undefined && typeof payload.includeFacts !== 'boolean') throw new StudyError('invalid', 'includeFacts 必须是布尔值');
  return { periods: [...new Set(periods)], includeFacts: payload.includeFacts ?? true };
}

async function collectOutcomes(study, periods) {
  const items = [];
  let revision;
  for (const period of periods) {
    const result = await study.call('outcomes', period, {}, { actor: 'ui' });
    if (result.ok !== true) return { available: false, reason: result.code === 'not_found' ? 'outcomes_service_not_registered' : `outcomes_${period}_${result.code}`, items: [] };
    if (revision !== undefined && revision !== result.revision) throw new StudyError('unavailable', '成果快照期间学习数据发生变化，请重试');
    revision = result.revision;
    items.push(result.value);
  }
  return { available: true, reason: null, items, revision };
}

/** Read one table, ordered by rowid when the caller needs stable output. */
function readRows(database, table, { ordered = false } = {}) {
  const quoted = quoteIdentifier(table);
  const sql = ordered ? `SELECT * FROM ${quoted} ORDER BY rowid` : `SELECT * FROM ${quoted}`;
  return database.all(sql);
}

/** Quote a table name for interpolation; names come from sqlite_master, not from callers. */
function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

/** Decode every `*_json` column in one row and drop the raw text. */
function decodeJsonColumns(row, label) {
  const decoded = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('_json')) {
      decoded[key.slice(0, -'_json'.length)] = parseJsonColumn(value, `${label}.${key}`);
    } else {
      decoded[key] = value;
    }
  }
  return decoded;
}

/** Decode the change log's optional payload columns. */
function decodeChangeLog(row, index) {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    entity: row.entity,
    entityId: row.entity_id,
    action: row.action,
    before: parseJsonColumn(row.before_json, `changeLog[${index}].before_json`),
    after: parseJsonColumn(row.after_json, `changeLog[${index}].after_json`),
    reason: row.reason,
  };
}

/** Parse one JSON column; corrupt history stops the export instead of being copied as text. */
function parseJsonColumn(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new StudyError('unavailable', `导出失败：${label} 不是 JSON 文本`, { field: label });
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StudyError('unavailable', `导出失败：${label} 不是合法 JSON`, { field: label, reason: error.message });
  }
}

/**
 * Read `memory.json` beside the database.
 * @param {string} dataDir - Study data directory.
 * @returns {{ version: number, updatedAt: string|null, items: object[], tombstones: object[] }} Memory content.
 */
function readMemory(dataDir) {
  const file = join(dataDir, 'memory.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: FILE_VERSION, updatedAt: null, items: [], tombstones: [] };
    throw new StudyError('unavailable', `无法读取记忆文件 ${file}`, { file, reason: error.message });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StudyError('unavailable', `记忆文件 ${file} 不是合法 JSON，已停止导出以免漏掉数据`, {
      file,
      reason: error.message,
    });
  }
  if (!isPlainObject(parsed)
    || parsed.version !== FILE_VERSION
    || !Array.isArray(parsed.items)
    || !Array.isArray(parsed.tombstones)) {
    throw new StudyError('unavailable', `记忆文件 ${file} 的格式或版本不受支持，已停止导出以免漏掉数据`, { file });
  }
  for (const [index, item] of parsed.items.entries()) {
    if (!isPlainObject(item)
      || typeof item.id !== 'string'
      || typeof item.kind !== 'string'
      || typeof item.text !== 'string'
      || typeof item.createdAt !== 'string'
      || typeof item.updatedAt !== 'string'
      || (item.expiresAt !== null && typeof item.expiresAt !== 'string')
      || !isPlainObject(item.source)) {
      throw new StudyError('unavailable', `记忆文件 ${file} 的第 ${index + 1} 条记录不完整，已停止导出以免漏掉数据`, { file, index });
    }
  }
  for (const [index, tombstone] of parsed.tombstones.entries()) {
    if (!isPlainObject(tombstone)
      || typeof tombstone.id !== 'string'
      || typeof tombstone.contentHash !== 'string'
      || typeof tombstone.deletedAt !== 'string') {
      throw new StudyError('unavailable', `记忆文件 ${file} 的第 ${index + 1} 个删除标记不完整，已停止导出以免漏掉数据`, { file, index });
    }
  }
  return {
    version: FILE_VERSION,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    items: parsed.items,
    tombstones: parsed.tombstones,
  };
}

function readSqliteMemory(database) {
  const items = database.all("SELECT * FROM study_memory_item WHERE kind IN ('preference', 'state', 'observation') AND status = 'active' AND superseded_by IS NULL ORDER BY created_at, id").map(row => {
    const metadata = parseJsonColumn(row.value_json, 'memory.value_json') ?? {};
    return { id: row.id, goalId: (metadata.scope ?? 'student') === 'student' ? null : row.goal_id, scope: metadata.scope ?? 'student', sessionId: metadata.sessionId ?? null,
      sourceRef: metadata.sourceRef ?? { legacy: true }, history: metadata.history ?? [], kind: row.kind, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at,
      expiresAt: row.valid_until, source: { actor: row.source_actor, requestId: metadata.requestId ?? null, note: metadata.note ?? null } };
  });
  const tombstones = database.all('SELECT * FROM study_memory_tombstone ORDER BY deleted_at, id').map(row => ({ id: row.id, goalId: row.goal_id, contentHash: row.content_hash, deletedAt: row.deleted_at, source: parseJsonColumn(row.source_json, 'memory.tombstone.source_json') }));
  return { version: FILE_VERSION, updatedAt: items.at(-1)?.updatedAt ?? null, items, tombstones };
}

/** Pick a free file name, adding a numeric suffix if two exports land in the same second. */
async function uniqueExportPath(directory, date) {
  const base = exportFileName(date);
  for (let attempt = 1; attempt <= MAX_FILENAME_ATTEMPTS; attempt += 1) {
    const file = join(directory, attempt === 1 ? base : base.replace(/\.json$/, `-${attempt}.json`));
    try {
      await readFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') return file;
      throw new StudyError('unavailable', '无法检查导出文件是否已存在', { directory, reason: error.message });
    }
  }
  throw new StudyError('unavailable', '导出文件重名过多，请稍后重试', { directory });
}

/** Render the Agent-visible result without repeating the whole export. */
function renderExportResult(value) {
  const summary = value?.summary ?? {};
  const parts = [
    `已导出学习数据 JSON：${value?.path ?? '?'}`,
    `修订 ${value?.revision ?? '?'}，${formatBytes(value?.bytes ?? 0)}`,
    `目标 ${summary.goals ?? 0}、资料 ${summary.materials ?? 0}、任务 ${summary.tasks ?? 0}`
      + `、计划 ${summary.plans ?? 0}、计划进度 ${summary.progress ?? 0}、任务进度 ${summary.taskProgress ?? 0}`
      + `、记忆 ${summary.memories ?? 0}`,
    '不含凭据、日志或请求缓存。',
  ];
  return parts.join('；');
}

function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Refuse to emit credential-shaped keys or values.
 * The export never reads the credential store, so this is a second guard for
 * data a student or the Agent may have pasted into notes or memory.
 * @param {object} document - Candidate export document.
 * @throws {StudyError} `unavailable` when a credential key or token value is present.
 */
function assertNoCredentialMaterial(document) {
  const found = findSecret(document, '$');
  if (found === null) return;
  throw new StudyError('unavailable', `导出内容在 ${found.path} 处疑似包含凭据（${found.pattern}），已停止导出；请先删除该内容再重试`, {
    path: found.path,
    pattern: found.pattern,
  });
}

/** Depth-first search for a credential key or a token-shaped string. */
function findSecret(value, path) {
  if (typeof value === 'string') {
    for (const { id: pattern, pattern: expression } of SECRET_VALUE_PATTERNS) {
      if (expression.test(value)) return { path, pattern };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSecret(value[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (CREDENTIAL_KEYS.test(key)) return { path: childPath, pattern: 'credential-key' };
      const found = findSecret(child, childPath);
      if (found !== null) return found;
    }
  }
  return null;
}

/** SHA-256 of UTF-8 text, lowercase hex. */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
