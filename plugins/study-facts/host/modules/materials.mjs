import { verifyLocatorEvidence } from '../plan-policy.mjs';
import { resolveActiveGoal } from '../../../../packages/study-model/facts.mjs';
import { toolRequestId } from '../../../../packages/study-contracts/index.mjs';
/**
 * Materials module: exam goals, imported materials, locator-tagged chunks, and
 * the lexical retriever behind `materials.search`.
 *
 * A chunk records only the page and chapter that its own source proves: page
 * breaks, page markers, PDF page objects, or a chapter the student declared for
 * a pasted excerpt. Fields the source does not prove stay null and are listed
 * in `unverified`, so plans and answers can say "未核实" instead of inventing a
 * page or a question number. PDFs are read from their text layer only; a file
 * without one fails with `pdf_no_text_layer` rather than importing empty pages.
 *
 * Search is lexical, not vector: CJK runs are indexed as overlapping bigrams
 * plus ASCII words in an FTS5 table, so a Chinese query works without a
 * dictionary and a two-character query still recalls the phrase. Queries too
 * short to tokenize fall back to substring matching.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { StudyError, isPlainObject } from '../../../../packages/study-contracts/index.mjs';

/** Module id; matches the `materials` service namespace. */
export const id = 'materials';

/** Goals and materials do not depend on another module. */
export const deps = [];

/** Schema version recorded in `module_schema`; bump when the DDL below changes. */
export const schemaVersion = 1;

/** Additive goal↔workspace links; created on old databases by `ensureGoalWorkspaceSchema`. */
const GOAL_WORKSPACE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS study_goal_workspace (
    goal_id      TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (goal_id, workspace_id)
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_goal_workspace_workspace ON study_goal_workspace (workspace_id)',
];

/** Tables owned by this module. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS study_goal (
    id            TEXT PRIMARY KEY,
    exam          TEXT NOT NULL,
    exam_year     INTEGER,
    deadline      TEXT,
    daily_minutes INTEGER,
    note          TEXT,
    active        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_goal_active ON study_goal (active)',
  ...GOAL_WORKSPACE_SCHEMA,
  `CREATE TABLE IF NOT EXISTS study_material (
    id            TEXT PRIMARY KEY,
    goal_id       TEXT,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    edition       TEXT,
    subject       TEXT,
    source_kind   TEXT NOT NULL,
    source_ref    TEXT,
    source_date   TEXT NOT NULL,
    format        TEXT NOT NULL,
    verification  TEXT NOT NULL,
    toc_json      TEXT NOT NULL DEFAULT '[]',
    deleted_at    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_material_goal ON study_material (goal_id, deleted_at)',
  `CREATE TABLE IF NOT EXISTS study_material_chunk (
    id             TEXT PRIMARY KEY,
    material_id    TEXT NOT NULL,
    ordinal        INTEGER NOT NULL,
    text           TEXT NOT NULL,
    page           INTEGER,
    chapter        TEXT,
    chapter_index  INTEGER,
    locator_source TEXT NOT NULL,
    start_offset   INTEGER NOT NULL,
    end_offset     INTEGER NOT NULL,
    source_date    TEXT NOT NULL,
    created_at     TEXT NOT NULL
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_material_chunk_order ON study_material_chunk (material_id, ordinal)',
  'CREATE VIRTUAL TABLE IF NOT EXISTS study_material_fts USING fts5(tokens, chunk_id UNINDEXED, material_id UNINDEXED)',
];

const WRITE_METHODS = ['saveGoal', 'importText', 'importFile', 'updateMaterial', 'deleteMaterial'];

const KINDS = ['textbook', 'workbook', 'course', 'notes', 'other'];
const FORMATS = ['text', 'markdown', 'pdf'];
const TEXT_FORMATS = ['text', 'markdown'];
const VERIFICATIONS = ['verified', 'unverified'];

/** Target chunk size in characters; callers may choose within the bounds below. */
const DEFAULT_CHUNK_CHARS = 800;
const MIN_CHUNK_CHARS = 120;
const MAX_CHUNK_CHARS = 4000;
/** A single import larger than this is refused with a hint to import by chapter. */
const MAX_TEXT_CHARS = 2_000_000;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_PDF_PAGES = 2000;
const MAX_QUERY_CHARS = 200;
const MAX_QUERY_PARTS = 24;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_TOC_ENTRIES = 500;
const MAX_GOAL_WORKSPACES = 32;

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { defineTool } = requireFromSource(join(sourceDirectory, 'packages/core/tools/lib/index.js'));

/**
 * Create the additive goal↔workspace table on a database opened before this
 * feature. A fresh database already has it because its module schema ran; the
 * check keeps this a no-op on every later open.
 * @param {{ get: Function, exec: Function } | undefined} database - Study database handle.
 */
function ensureGoalWorkspaceSchema(database) {
  if (database === undefined || database === null) return;
  const existing = database.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'study_goal_workspace'",
  );
  if (existing !== undefined) return;
  for (const statement of GOAL_WORKSPACE_SCHEMA) database.exec(statement);
}

/**
 * Register the `materials` service methods and the `study_materials` Agent tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study` and `tools`.
 * @param {{ database?: { get: Function, exec: Function } }} [kernel] - Kernel handle.
 */
export function apply(ctx, kernel) {
  ensureGoalWorkspaceSchema(kernel?.database);
  ctx.effect(() => ctx.study.register('materials', {
    methods: {
      saveGoal,
      getGoal,
      listGoals,
      importText: importTextMaterial,
      importFile: importFileMaterial,
      updateMaterial,
      deleteMaterial,
      list: listMaterials,
      get: getMaterial,
      outline: outlineMaterial,
      chunks: listChunks,
      search: searchMaterials,
      locate: locateMaterial,
      verifyLocator: (payload, api) => {
        const materialId = requireText(payload.materialId, 'materialId', { max: 64 });
        const located = locateMaterial(payload, api);
        return { ...located, locator: verifyLocatorEvidence(api.db, materialId, located.requested, { reading: true }) };
      },
    },
    writes: WRITE_METHODS,
  }), 'study: materials namespace');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_materials',
    description: '学习资料：检索学生已导入的教材/练习册/课程片段，或把学生提供的文字导入成可检索资料。'
      + '检索结果带来源（资料名、章节、页码、来源日期）；页码或章节无法从原文确认时会列在 unverified 里，'
      + '不要替学生补页码、章节或题号。导入只使用学生给出的原文，不要自行改写或补全内容。',
    parameters: {
      requestId: { type: 'string', description: 'Stable write operation ID; defaults to executor callId.' },
      action: {
        type: 'string',
        required: true,
        enum: ['search', 'import_text', 'list'],
        description: 'search 检索片段；import_text 导入学生提供的文字；list 列出已有资料。',
      },
      query: { type: 'string', description: 'search：检索词。两个字符以上会走词法索引，单个字按整串包含匹配。' },
      materialId: { type: 'string', description: 'search：只看某一份资料的片段。' },
      goalId: { type: 'string', description: 'search/list/import_text：限定或关联某个备考目标。' },
      kind: { type: 'string', enum: [...KINDS], description: 'list：按资料类型过滤；import_text：新资料的类型，默认 notes。' },
      limit: { type: 'number', description: 'search：返回条数，1-50，默认 8。' },
      offset: { type: 'number', description: 'search：跳过前多少条，默认 0。' },
      title: { type: 'string', description: 'import_text：资料名称，例如「数学分析 第三版」。' },
      edition: { type: 'string', description: 'import_text：版本，例如「第三版」。' },
      subject: { type: 'string', description: 'import_text：学科，例如「数学」。' },
      chapter: { type: 'string', description: 'import_text：这段文字所属章节；原文自带章节标题时以原文为准。' },
      text: { type: 'string', description: 'import_text：学生提供的原文，不要改写。' },
      format: { type: 'string', enum: [...TEXT_FORMATS], description: 'import_text：text 或 markdown（markdown 会识别 # 标题为章节）。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const call = (method, payload) => ctx.study.call('materials', method, payload, { actor: 'agent', requestId: WRITE_METHODS.includes(method) ? toolRequestId(args, exec) : undefined });
      let result;
      switch (args.action) {
        case 'search':
          result = await call('search', {
            query: args.query,
            materialId: args.materialId,
            goalId: args.goalId,
            kind: args.kind,
            limit: args.limit,
            offset: args.offset,
          });
          break;
        case 'import_text':
          result = await call('importText', {
            kind: args.kind,
            title: args.title,
            edition: args.edition,
            subject: args.subject,
            chapter: args.chapter,
            text: args.text,
            format: args.format ?? 'text',
            goalId: args.goalId,
          });
          break;
        case 'list':
          result = await call('list', { goalId: args.goalId, kind: args.kind });
          break;
        default:
          throw new Error(`study_materials 不支持 action=${JSON.stringify(args.action)}`);
      }
      if (result.ok !== true) throw new Error(`学习资料操作失败（${result.code}）：${result.message}`);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '学习资料' }),
  })), 'study: study_materials tool');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_goal',
    description: '备考目标：读取当前目标、列出全部目标，或新建/更新目标。'
      + '目标是计划与材料的归属：exam 是必填名称，考试日期、每天可用分钟等可以后补，缺什么会列在 missing 里。'
      + '更新已有目标时只传要改的字段，其余字段保持原值；切换当前目标用 active: true。',
    parameters: {
      requestId: { type: 'string', description: 'Stable write operation ID; defaults to executor callId.' },
      action: {
        type: 'string',
        required: true,
        enum: ['get', 'list', 'save'],
        description: 'get 读当前激活目标（可带 id 读指定目标）；list 列出全部目标；save 新建或更新目标。',
      },
      id: { type: 'string', description: 'save：要更新的目标 ID，省略时新建；get：指定目标 ID。' },
      exam: { type: 'string', description: 'save：考试或课程名称，新建时必填。' },
      examYear: { type: 'number', description: 'save：考试年份，1900-2200。' },
      deadline: { type: 'string', description: 'save：考试日期 YYYY-MM-DD。' },
      dailyMinutes: { type: 'number', description: 'save：每天可用分钟，0-1440。' },
      note: { type: 'string', description: 'save：备注。' },
      active: { type: 'boolean', description: 'save：是否设为当前目标；新建默认 true。' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const call = (method, payload) => ctx.study.call('materials', method, payload, {
        actor: 'agent',
        requestId: WRITE_METHODS.includes(method) ? toolRequestId(args, exec) : undefined,
      });
      if (args.action === 'get') {
        const result = await call('getGoal', args.id === undefined ? {} : { id: args.id });
        if (result.ok !== true) throw new Error(`读取备考目标失败（${result.code}）：${result.message}`);
        return result.value;
      }
      if (args.action === 'list') {
        const result = await call('listGoals', {});
        if (result.ok !== true) throw new Error(`列出备考目标失败（${result.code}）：${result.message}`);
        return result.value;
      }
      if (args.action !== 'save') throw new Error(`study_goal 不支持 action=${JSON.stringify(args.action)}`);

      let base = null;
      if (args.id !== undefined) {
        const current = await call('getGoal', { id: args.id });
        if (current.ok !== true) throw new Error(`读取要更新的目标失败（${current.code}）：${current.message}`);
        base = current.value.goal;
      }
      const exam = args.exam === undefined ? base?.exam : args.exam;
      if (typeof exam !== 'string' || exam.trim().length === 0) {
        throw new Error('save 需要 exam（考试或课程名称）；更新已有目标时也要带上 exam。');
      }
      const merged = key => args[key] === undefined ? (base === null ? null : base[key]) : args[key];
      const result = await call('saveGoal', {
        ...(args.id === undefined ? {} : { id: args.id }),
        exam,
        examYear: merged('examYear'),
        deadline: merged('deadline'),
        dailyMinutes: merged('dailyMinutes'),
        note: merged('note'),
        active: args.active === undefined ? (base === null ? true : base.active) : args.active,
      });
      if (result.ok !== true) throw new Error(`保存备考目标失败（${result.code}）：${result.message}`);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '备考目标' }),
  })), 'study: study_goal tool');
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

/** Build an `invalid` service failure with a machine-readable field name. */
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

function optionalBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw invalid(`${field} 必须是 true 或 false`, { field });
  return value;
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

function optionalDate(value, field) {
  if (value === undefined || value === null) return null;
  const text = requireText(value, field, { max: 10 });
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

function parseJsonColumn(value, fallback, label) {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StudyError('unavailable', `${label}数据损坏，无法读取`, { reason: error.message });
  }
}

/** Validate a declared table of contents; returns normalized entries or null. */
function validateToc(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw invalid('toc 必须是数组', { field: 'toc' });
  if (value.length > MAX_TOC_ENTRIES) throw invalid(`toc 最多 ${MAX_TOC_ENTRIES} 条`, { field: 'toc', max: MAX_TOC_ENTRIES });
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`toc[${index}] 必须是对象`, { field: 'toc' });
    const title = requireText(entry.title, `toc[${index}].title`, { max: 200 });
    const page = optionalInteger(entry.page, `toc[${index}].page`, { min: 1, max: 100000 });
    return { index: index + 1, title, page, lastPage: page, chunkCount: 0, source: 'declared' };
  });
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function goalSummary(row, db) {
  const goal = {
    id: String(row.id),
    exam: String(row.exam),
    examYear: row.exam_year === null ? null : Number(row.exam_year),
    deadline: row.deadline === null ? null : String(row.deadline),
    dailyMinutes: row.daily_minutes === null ? null : Number(row.daily_minutes),
    note: row.note === null ? null : String(row.note),
    active: Number(row.active) === 1,
    workspaceIds: db === undefined
      ? []
      : db.all('SELECT workspace_id FROM study_goal_workspace WHERE goal_id = ? ORDER BY rowid', String(row.id))
        .map(entry => String(entry.workspace_id)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  goal.missing = [];
  if (goal.examYear === null) goal.missing.push('examYear');
  if (goal.deadline === null) goal.missing.push('deadline');
  if (goal.dailyMinutes === null) goal.missing.push('dailyMinutes');
  return goal;
}

/**
 * Replace one goal's workspace links in the caller's transaction.
 * @param {{ run: Function }} db - Study database handle.
 * @param {string} goalId - Goal whose links are replaced.
 * @param {string[]} workspaceIds - Deduplicated workspace ids in display order.
 * @param {string} now - ISO timestamp for the new rows.
 */
function replaceGoalWorkspaces(db, goalId, workspaceIds, now) {
  db.run('DELETE FROM study_goal_workspace WHERE goal_id = ?', goalId);
  for (const workspaceId of workspaceIds) {
    db.run(
      'INSERT INTO study_goal_workspace (goal_id, workspace_id, created_at) VALUES (?, ?, ?)',
      goalId, workspaceId, now,
    );
  }
}

/**
 * Normalize the optional workspace selection of a goal write.
 * @param {unknown} value - `undefined` (leave links unchanged) or an array of workspace ids.
 * @returns {string[] | undefined} Deduplicated ids, or undefined when the caller did not choose.
 */
function optionalWorkspaceIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid('workspaceIds 必须是数组', { field: 'workspaceIds' });
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    const id = requireText(entry, 'workspaceIds', { max: 200 });
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > MAX_GOAL_WORKSPACES) {
    throw invalid(`一个目标最多关联 ${MAX_GOAL_WORKSPACES} 个工作区`, { field: 'workspaceIds', max: MAX_GOAL_WORKSPACES });
  }
  return ids;
}

/** Create or update one exam goal; `active: true` makes it the only active goal. */
function saveGoal(payload, api) {
  const exam = requireText(payload.exam, 'exam', { max: 120 });
  const examYear = optionalInteger(payload.examYear, 'examYear', { min: 1900, max: 2200 });
  const deadline = optionalDate(payload.deadline, 'deadline');
  const dailyMinutes = optionalInteger(payload.dailyMinutes, 'dailyMinutes', { min: 0, max: 1440 });
  const note = optionalText(payload.note, 'note', { max: 500 });
  const active = optionalBoolean(payload.active, 'active');
  const workspaceIds = optionalWorkspaceIds(payload.workspaceIds);
  const requestedId = optionalText(payload.id, 'id', { max: 64 });
  const now = api.now().toISOString();

  let goalId = requestedId;
  let before = null;
  if (goalId === null) {
    goalId = `goal_${randomUUID()}`;
  } else {
    const existing = api.db.get('SELECT * FROM study_goal WHERE id = ?', goalId);
    if (existing === undefined) throw new StudyError('not_found', `找不到目标 ${goalId}`, { goalId });
    before = goalSummary(existing, api.db);
  }
  const created = before === null;
  const becomesActive = active ?? (created ? true : before.active);
  if (becomesActive) {
    api.db.run('UPDATE study_goal SET active = 0, updated_at = ? WHERE active = 1 AND id <> ?', now, goalId);
  }
  if (created) {
    api.db.run(
      'INSERT INTO study_goal (id, exam, exam_year, deadline, daily_minutes, note, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      goalId, exam, examYear, deadline, dailyMinutes, note, becomesActive ? 1 : 0, now, now,
    );
  } else {
    api.db.run(
      'UPDATE study_goal SET exam = ?, exam_year = ?, deadline = ?, daily_minutes = ?, note = ?, active = ?, updated_at = ? WHERE id = ?',
      exam, examYear, deadline, dailyMinutes, note, becomesActive ? 1 : 0, now, goalId,
    );
  }
  if (workspaceIds !== undefined) replaceGoalWorkspaces(api.db, goalId, workspaceIds, now);
  const goal = goalSummary(api.db.get('SELECT * FROM study_goal WHERE id = ?', goalId), api.db);
  api.change({ entity: 'goal', entityId: goalId, action: created ? 'create' : 'update', before, after: goal });
  return { goal, created };
}

/** Read one goal by id, or the active goal when no id is given. */
function getGoal(payload, api) {
  const goalId = optionalText(payload.id, 'id', { max: 64 });
  const row = goalId === null
    ? api.db.get('SELECT * FROM study_goal WHERE active = 1 ORDER BY updated_at DESC, rowid DESC LIMIT 1')
    : api.db.get('SELECT * FROM study_goal WHERE id = ?', goalId);
  if (row === undefined && goalId !== null) throw new StudyError('not_found', `找不到目标 ${goalId}`, { goalId });
  return { goal: row === undefined ? null : goalSummary(row, api.db) };
}

/** List goals in creation order. */
function listGoals(_payload, api) {
  const rows = api.db.all('SELECT * FROM study_goal ORDER BY created_at ASC, rowid ASC');
  return { goals: rows.map(row => goalSummary(row, api.db)) };
}

// ---------------------------------------------------------------------------
// Chunking: page and chapter markers
// ---------------------------------------------------------------------------

const PAGE_MARKER_PATTERNS = [
  /^\s*(?:[-—=–]{2,}\s*)?[\[（(]?\s*第\s*(\d{1,5})\s*页\s*[\]）)]?(?:\s*[-—=–]{2,})?\s*$/u,
  /^\s*(?:[-—=–]{2,}\s*)?(?:page|p\.)\s*(\d{1,5})(?:\s*[-—=–]{2,})?\s*$/iu,
  /^\s*[-—=–]{2,}\s*(\d{1,5})\s*[-—=–]{2,}\s*$/u,
];

const CJK_DIGITS = new Map([['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]]);

/** Parse an Arabic or simple Chinese numeral (up to 99) from a chapter label. */
function chineseNumber(text) {
  if (/^\d+$/.test(text)) return Number(text);
  if (text.length === 0) return null;
  const ten = text.indexOf('十');
  if (ten === -1) return CJK_DIGITS.get(text) ?? null;
  const high = ten === 0 ? 1 : CJK_DIGITS.get(text.slice(0, ten));
  const low = ten === text.length - 1 ? 0 : CJK_DIGITS.get(text.slice(ten + 1));
  if (high === undefined || low === undefined) return null;
  return high * 10 + low;
}

/** Chapter number carried by a heading, or null when the heading has none. */
function chapterNumber(text) {
  const labelled = /第\s*([0-9一二三四五六七八九十百千零〇两]+)\s*[章节讲课篇部]/.exec(text)
    ?? /(?:chapter|unit|lesson|section)\s+(\d{1,3})/i.exec(text);
  if (labelled !== null) return chineseNumber(labelled[1]);
  const bare = /^\s*(\d{1,3})\s*$/.exec(text);
  return bare === null ? null : Number(bare[1]);
}

/** Page number of a page-marker line, or null. */
function pageMarkerOf(line) {
  for (const pattern of PAGE_MARKER_PATTERNS) {
    const match = pattern.exec(line);
    if (match !== null) return Number(match[1]);
  }
  return null;
}

/** Heading text when a line looks like a chapter or section heading. */
function headingOf(line, format) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  if (/[。！？!?；;]\s*$/u.test(trimmed)) return null;
  if (format === 'markdown') {
    const match = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(trimmed);
    if (match !== null) return match[2].trim();
  }
  if (/^第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章节讲课篇部](?:\s|$|[^。！？!?；;])/u.test(trimmed)) return trimmed;
  if (/^(?:Chapter|Unit|Lesson|Part|Section)\s+\d+/iu.test(trimmed)) return trimmed;
  if (/^\d+(?:\.\d+)+\s+\S/u.test(trimmed)) return trimmed;
  return null;
}

/** Combine the page and chapter provenance into one locator-source label. */
function locatorSourceOf(pageSource, chapterSource) {
  const sources = new Set([pageSource, chapterSource].filter(source => source !== 'none'));
  if (sources.size === 0) return 'none';
  if (sources.size === 2) return 'mixed';
  return sources.has('detected') ? 'detected' : 'declared';
}

/** Split text longer than one chunk at sentence or line boundaries. */
function splitLongText(text, target) {
  const pieces = [];
  let rest = text;
  while (rest.length > target) {
    let cut = -1;
    for (const mark of ['\n', '。', '！', '？', '；', '.', '!', '?', ';']) {
      const index = rest.lastIndexOf(mark, target);
      if (index > cut) cut = index;
    }
    const boundary = cut >= Math.floor(target / 3) ? cut + 1 : target;
    pieces.push(rest.slice(0, boundary));
    rest = rest.slice(boundary);
  }
  if (rest.trim().length > 0) pieces.push(rest);
  return pieces;
}

/** Group chunks into a table of contents from the chapters their locators name. */
function chaptersOf(chunks) {
  const chapters = [];
  const seen = new Map();
  for (const chunk of chunks) {
    if (chunk.chapter === null) continue;
    const key = `${chunk.chapterIndex ?? 'x'}|${chunk.chapter}`;
    let entry = seen.get(key);
    if (entry === undefined) {
      entry = {
        index: chunk.chapterIndex,
        title: chunk.chapter,
        page: chunk.page,
        lastPage: chunk.page,
        chunkCount: 0,
        source: chunk.chapterSource === 'detected' ? 'detected' : 'declared',
      };
      seen.set(key, entry);
      chapters.push(entry);
    }
    entry.chunkCount += 1;
    if (chunk.page !== null) {
      if (entry.page === null) entry.page = chunk.page;
      entry.lastPage = chunk.page;
    }
  }
  return chapters;
}

/**
 * Cut normalized document text into chunks that never cross a page break, a
 * chapter heading, or the chunk-size limit, and record each chunk's locators.
 * @param {string} text - Document text with `\n` line breaks.
 * @param {{ format: string, declaredChapter: string|null, maxChunkChars: number, pageMode: 'pdf'|'auto' }} options
 *   `format` enables markdown headings, `declaredChapter` labels text with no heading,
 *   and `pageMode: 'pdf'` starts page numbering at 1 because the importer joined pages with `\f`.
 * @returns {{ chunks: Array<object>, chapters: Array<object>, warnings: Array<object> }} Chunk plan.
 */
function chunkDocument(text, { format, declaredChapter, maxChunkChars, pageMode }) {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const warnings = [];
  let page = pageMode === 'pdf' || normalized.includes('\f') ? 1 : null;
  let pageSource = page === null ? 'none' : 'detected';
  let chapter = declaredChapter;
  let chapterSource = chapter === null ? 'none' : 'declared';
  let chapterIndex = null;
  let chapterCounter = 0;

  const blocks = [];
  let block = null;
  const flushBlock = () => {
    if (block !== null && block.lines.length > 0) blocks.push({ ...block, text: block.lines.join('\n') });
    block = null;
  };
  const startBlock = lineStart => {
    block = { lines: [], start: lineStart, end: lineStart, page, pageSource, chapter, chapterIndex, chapterSource };
  };
  const pushLine = (line, lineStart) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushBlock();
      return;
    }
    if (block !== null && (block.page !== page || block.chapter !== chapter || block.chapterIndex !== chapterIndex)) flushBlock();
    if (block === null) startBlock(lineStart);
    block.lines.push(trimmed);
    block.end = lineStart + line.length;
  };
  const advancePage = () => {
    page = page === null ? 1 : page + 1;
    pageSource = 'detected';
  };
  const handleLine = (line, lineStart) => {
    const marker = pageMarkerOf(line);
    if (marker !== null) {
      flushBlock();
      page = marker;
      pageSource = 'detected';
      return;
    }
    const heading = headingOf(line, format);
    if (heading !== null) {
      flushBlock();
      chapter = heading;
      chapterSource = 'detected';
      chapterIndex = chapterNumber(heading) ?? (chapterCounter + 1);
      chapterCounter = Math.max(chapterCounter, chapterIndex);
      return;
    }
    pushLine(line, lineStart);
  };

  let offset = 0;
  while (true) {
    const newline = normalized.indexOf('\n', offset);
    const lineEnd = newline === -1 ? normalized.length : newline;
    const line = normalized.slice(offset, lineEnd);
    if (line.includes('\f')) {
      let segmentOffset = offset;
      line.split('\f').forEach((segment, index) => {
        if (index > 0) {
          flushBlock();
          advancePage();
        }
        handleLine(segment, segmentOffset);
        segmentOffset += segment.length + 1;
      });
    } else {
      handleLine(line, offset);
    }
    if (newline === -1) break;
    offset = lineEnd + 1;
  }
  flushBlock();

  const chunks = [];
  let current = null;
  const openChunk = from => {
    current = {
      parts: [],
      length: 0,
      page: from.page,
      pageSource: from.pageSource,
      chapter: from.chapter,
      chapterIndex: from.chapterIndex,
      chapterSource: from.chapterSource,
      start: from.start,
      end: from.end,
    };
  };
  const flushChunk = () => {
    if (current === null) return;
    const textOut = current.parts.join('\n\n').trim();
    if (textOut.length > 0) {
      chunks.push({
        text: textOut,
        start: current.start,
        end: current.end,
        page: current.page,
        chapter: current.chapter,
        chapterIndex: current.chapterIndex,
        pageSource: current.pageSource,
        chapterSource: current.chapterSource,
        locatorSource: locatorSourceOf(current.pageSource, current.chapterSource),
      });
    }
    current = null;
  };

  for (const item of blocks) {
    if (item.text.length > maxChunkChars) {
      flushChunk();
      for (const piece of splitLongText(item.text, maxChunkChars)) {
        openChunk(item);
        current.parts.push(piece);
        current.length = piece.length;
        flushChunk();
      }
      continue;
    }
    if (current !== null && (current.page !== item.page || current.chapter !== item.chapter || current.chapterIndex !== item.chapterIndex)) {
      flushChunk();
    }
    if (current === null) openChunk(item);
    if (current.length > 0 && current.length + item.text.length + 2 > maxChunkChars) {
      flushChunk();
      openChunk(item);
    }
    current.parts.push(item.text);
    current.length += item.text.length + 2;
  }
  flushChunk();

  return { chunks, chapters: chaptersOf(chunks), warnings };
}

// ---------------------------------------------------------------------------
// Lexical index and query analysis
// ---------------------------------------------------------------------------

const CJK_RANGES = [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2fa1f]];

function isCjkCodePoint(code) {
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end);
}

/** Walk NFKC-normalized runs of CJK characters and ASCII alphanumerics. */
function scanRuns(text, onRun) {
  const normalized = text.normalize('NFKC');
  let run = [];
  let kind = null;
  const flush = () => {
    if (run.length > 0) onRun(kind, run);
    run = [];
    kind = null;
  };
  for (const char of normalized) {
    if (isCjkCodePoint(char.codePointAt(0))) {
      if (kind !== 'cjk') flush();
      kind = 'cjk';
      run.push(char);
      continue;
    }
    if (/^[0-9A-Za-z]$/.test(char)) {
      if (kind !== 'word') flush();
      kind = 'word';
      run.push(char);
      continue;
    }
    flush();
  }
  flush();
}

/** FTS5 token text for one chunk: CJK bigrams plus lowercased ASCII words of length ≥ 2. */
function tokenStringOf(text) {
  const tokens = [];
  scanRuns(text, (kind, chars) => {
    if (kind === 'cjk') {
      for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(chars[index] + chars[index + 1]);
      return;
    }
    if (chars.length >= 2) tokens.push(chars.join('').toLowerCase());
  });
  return tokens.join(' ');
}

/** Split a query into segments whose tokens are phrases for FTS5. */
function queryPartsOf(query) {
  const parts = [];
  scanRuns(query, (kind, chars) => {
    const raw = chars.join('');
    if (kind === 'cjk') {
      const tokens = [];
      for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(chars[index] + chars[index + 1]);
      parts.push({ raw, tokens });
      return;
    }
    parts.push({ raw, tokens: chars.length >= 2 ? [raw.toLowerCase()] : [] });
  });
  return parts;
}

function normalizeForMatch(text) {
  return text.normalize('NFKC').toLowerCase();
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

// ---------------------------------------------------------------------------
// Materials: persistence, summaries, and views
// ---------------------------------------------------------------------------

function coverageOf(db, materialId) {
  const row = db.get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(page IS NULL), 0) AS unknown_page,
            COALESCE(SUM(chapter IS NULL), 0) AS unknown_chapter,
            MIN(page) AS min_page,
            MAX(page) AS max_page
     FROM study_material_chunk WHERE material_id = ?`,
    materialId,
  );
  return {
    total: Number(row.total),
    unknownPage: Number(row.unknown_page),
    unknownChapter: Number(row.unknown_chapter),
    minPage: row.min_page === null ? null : Number(row.min_page),
    maxPage: row.max_page === null ? null : Number(row.max_page),
  };
}

function materialRow(db, materialId, { includeDeleted = false } = {}) {
  if (typeof materialId !== 'string' || materialId.length === 0) throw invalid('materialId 必须是字符串', { field: 'materialId' });
  const row = db.get('SELECT * FROM study_material WHERE id = ?', materialId);
  if (row === undefined) throw new StudyError('not_found', `找不到资料 ${materialId}`, { materialId });
  if (!includeDeleted && row.deleted_at !== null) {
    throw new StudyError('not_found', `资料 ${materialId} 已删除`, { materialId, deletedAt: row.deleted_at });
  }
  return row;
}

function materialSummary(db, row) {
  const toc = parseJsonColumn(row.toc_json, [], '资料目录');
  const coverage = coverageOf(db, row.id);
  const missing = [];
  if (row.edition === null) missing.push('edition');
  if (toc.length === 0) missing.push('toc');
  if (coverage.total === 0 || coverage.unknownPage > 0) missing.push('page');
  if (coverage.total === 0 || coverage.unknownChapter > 0) missing.push('chapter');
  return {
    id: String(row.id),
    goalId: row.goal_id === null ? null : String(row.goal_id),
    kind: String(row.kind),
    title: String(row.title),
    edition: row.edition === null ? null : String(row.edition),
    subject: row.subject === null ? null : String(row.subject),
    format: String(row.format),
    source: {
      kind: String(row.source_kind),
      ref: row.source_ref === null ? null : String(row.source_ref),
      date: String(row.source_date),
    },
    verification: String(row.verification),
    missing,
    toc,
    chunkCount: coverage.total,
    pages: { known: coverage.total - coverage.unknownPage, unknown: coverage.unknownPage, min: coverage.minPage, max: coverage.maxPage },
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function chunkView(row) {
  const page = row.page === null ? null : Number(row.page);
  const chapter = row.chapter === null ? null : String(row.chapter);
  const unverified = [];
  if (page === null) unverified.push('page');
  if (chapter === null) unverified.push('chapter');
  return {
    id: String(row.id),
    ordinal: Number(row.ordinal),
    text: String(row.text),
    page,
    chapter,
    chapterIndex: row.chapter_index === null ? null : Number(row.chapter_index),
    locatorSource: String(row.locator_source),
    unverified,
    sourceDate: String(row.source_date),
    offsets: { start: Number(row.start_offset), end: Number(row.end_offset) },
  };
}

/** Build the citation line a hit shows the student. */
function citationOf(material, { page, chapter }) {
  const parts = [`《${material.title}》`];
  if (chapter !== null) parts.push(chapter);
  if (page !== null) parts.push(`第${page}页`);
  parts.push(`来源 ${material.source_date}`);
  let citation = parts.join(' ');
  if (page === null && chapter === null) citation += '（章节与页码未核实）';
  else if (page === null) citation += '（页码未核实）';
  else if (chapter === null) citation += '（章节未核实）';
  return citation;
}

function snippetOf(text, parts, radius = 60) {
  const lower = text.toLowerCase();
  let index = -1;
  for (const part of parts) {
    const found = lower.indexOf(part.raw.toLowerCase());
    if (found !== -1 && (index === -1 || found < index)) index = found;
  }
  if (index === -1) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= radius * 2 ? flat : `${flat.slice(0, radius * 2)}…`;
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius * 2);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

// ---------------------------------------------------------------------------
// Import pipeline
// ---------------------------------------------------------------------------

/**
 * Persist one material and index its chunks.
 * @param {object} payload - Caller metadata (`kind`, `title`, `edition`, `subject`, `chapter`, `toc`, ...).
 * @param {object} api - Kernel call context.
 * @param {{ text: string, format: string, sourceKind: string, sourceRef: string|null, titleFallback?: string|null, warnings?: Array<object>, pageMode?: 'pdf'|'auto' }} source
 *   The decoded text plus where it came from.
 * @returns {object} Import result: `{ material, chunkCount, warnings }`.
 */
function createMaterial(payload, api, source) {
  const text = source.text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  if (text.trim().length === 0) throw invalid('导入内容为空：没有可切分的文字', { field: 'text', reason: 'empty_text' });
  if (text.length > MAX_TEXT_CHARS) {
    throw invalid(`导入内容超过 ${MAX_TEXT_CHARS} 个字符，请按章节分批导入`, { field: 'text', reason: 'text_too_large', max: MAX_TEXT_CHARS });
  }

  const kind = payload.kind === undefined || payload.kind === null
    ? (source.sourceKind === 'file' ? 'other' : 'notes')
    : oneOf(payload.kind, 'kind', KINDS);
  const title = payload.title === undefined || payload.title === null
    ? source.titleFallback ?? null
    : requireText(payload.title, 'title', { max: 200 });
  if (title === null || title.length === 0) throw invalid('title 不能为空', { field: 'title' });
  const edition = optionalText(payload.edition, 'edition', { max: 120 });
  const subject = optionalText(payload.subject, 'subject', { max: 120 });
  const chapter = optionalText(payload.chapter, 'chapter', { max: 200 });
  const declaredToc = validateToc(payload.toc);
  const verification = optionalBoolean(payload.verified, 'verified') === true ? 'verified' : 'unverified';
  const sourceDate = optionalDate(payload.sourceDate, 'sourceDate') ?? api.today();
  const maxChunkChars = optionalInteger(payload.maxChunkChars, 'maxChunkChars', { min: MIN_CHUNK_CHARS, max: MAX_CHUNK_CHARS }) ?? DEFAULT_CHUNK_CHARS;
  const goalId = resolveActiveGoal(api.db, payload.goalId) ?? 'unassigned';
  if (goalId !== null && goalId !== 'unassigned') {
    const goal = api.db.get('SELECT id FROM study_goal WHERE id = ?', goalId);
    if (goal === undefined) throw new StudyError('not_found', `找不到目标 ${goalId}`, { goalId });
  }

  const plan = chunkDocument(text, {
    format: source.format,
    declaredChapter: chapter,
    maxChunkChars,
    pageMode: source.pageMode ?? 'auto',
  });
  if (plan.chunks.length === 0) {
    throw invalid('导入内容为空：没有可切分的文字', { field: 'text', reason: 'empty_text' });
  }
  const toc = declaredToc === null ? plan.chapters : declaredToc.map(entry => ({
    ...entry,
    chunkCount: plan.chunks.filter(chunk => chunk.chapter === entry.title).length,
  }));

  const materialId = `mat_${randomUUID()}`;
  const now = api.now().toISOString();
  api.db.run(
    `INSERT INTO study_material
       (id, goal_id, kind, title, edition, subject, source_kind, source_ref, source_date, format, verification, toc_json, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    materialId, goalId, kind, title, edition, subject, source.sourceKind, source.sourceRef, sourceDate,
    source.format, verification, JSON.stringify(toc), now, now,
  );

  plan.chunks.forEach((chunk, ordinal) => {
    const chunkId = `chk_${randomUUID()}`;
    api.db.run(
      `INSERT INTO study_material_chunk
         (id, material_id, ordinal, text, page, chapter, chapter_index, locator_source, start_offset, end_offset, source_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      chunkId, materialId, ordinal, chunk.text, chunk.page, chunk.chapter, chunk.chapterIndex,
      chunk.locatorSource, chunk.start, chunk.end, sourceDate, now,
    );
    api.db.run(
      'INSERT INTO study_material_fts (tokens, chunk_id, material_id) VALUES (?, ?, ?)',
      tokenStringOf(chunk.text), chunkId, materialId,
    );
  });

  const material = materialSummary(api.db, api.db.get('SELECT * FROM study_material WHERE id = ?', materialId));
  api.change({
    entity: 'material',
    entityId: materialId,
    action: 'import',
    after: { title, kind, chunkCount: plan.chunks.length, format: source.format, source: material.source, missing: material.missing },
  });
  return { material, chunkCount: plan.chunks.length, warnings: [...(source.warnings ?? []), ...plan.warnings] };
}

/** Validate and store pasted text or markdown. */
function importTextMaterial(payload, api) {
  if (payload.format === 'pdf') {
    throw invalid('importText 只接收文字或 Markdown；PDF 请用 importFile 导入', { field: 'format', reason: 'use_import_file' });
  }
  if (typeof payload.text !== 'string') throw invalid('text 必须是字符串', { field: 'text' });
  const format = payload.format === undefined || payload.format === null
    ? 'text'
    : oneOf(payload.format, 'format', TEXT_FORMATS);
  return createMaterial(payload, api, { text: payload.text, format, sourceKind: 'pasted', sourceRef: null, titleFallback: null });
}

/** Read a local text/markdown/PDF file and store its extracted text. */
async function importFileMaterial(payload, api) {
  const name = optionalText(payload.name, 'name', { max: 260 });
  const path = optionalText(payload.path, 'path', { max: 1024 });
  const base64 = optionalText(payload.base64, 'base64', { max: 44_000_000 });
  if ((path === null) === (base64 === null)) {
    throw invalid('importFile 需要 path 或 base64 之一（不能同时提供）', { field: 'path', reason: 'file_source_required' });
  }
  let bytes;
  let fileName;
  if (path !== null) {
    fileName = name ?? basename(path);
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw new StudyError('not_found', `无法读取文件 ${path}`, { path, reason: error.code ?? error.message });
    }
  } else {
    if (name === null) throw invalid('用 base64 导入文件时必须提供 name（用于判断格式与来源）', { field: 'name' });
    fileName = name;
    bytes = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  }
  if (bytes.length === 0) throw invalid('文件内容为空', { field: path === null ? 'base64' : 'path', reason: 'empty_file' });

  const format = resolveFileFormat(payload.format, fileName);
  const warnings = [];
  let text;
  if (format === 'pdf') {
    const extracted = extractPdfText(bytes);
    text = extracted.text;
    warnings.push(...extracted.warnings);
  } else {
    const decoded = decodeTextBytes(bytes, fileName);
    text = decoded.text;
    warnings.push(...decoded.warnings);
  }
  return createMaterial(payload, api, {
    text,
    format,
    sourceKind: 'file',
    sourceRef: fileName,
    titleFallback: titleFromFileName(fileName),
    warnings,
    pageMode: format === 'pdf' ? 'pdf' : 'auto',
  });
}

function resolveFileFormat(format, name) {
  const extension = extname(name).toLowerCase();
  const byExtension = extension === '.pdf'
    ? 'pdf'
    : ['.md', '.markdown'].includes(extension)
      ? 'markdown'
      : ['.txt', '.text'].includes(extension) ? 'text' : null;
  if (format !== undefined && format !== null) {
    const declared = oneOf(format, 'format', FORMATS);
    if (byExtension === 'pdf' && declared !== 'pdf') {
      throw invalid(`文件 ${name} 是 PDF，但 format 声明为 ${declared}`, { field: 'format', reason: 'format_mismatch' });
    }
    if (byExtension !== null && byExtension !== 'pdf' && declared === 'pdf') {
      throw invalid(`文件 ${name} 不是 PDF`, { field: 'format', reason: 'format_mismatch' });
    }
    return declared;
  }
  if (byExtension === null) {
    throw invalid(`不支持的文件类型「${extension || '无扩展名'}」`, {
      field: 'name',
      reason: 'unsupported_file_type',
      supported: ['.txt', '.md', '.markdown', '.pdf'],
    });
  }
  return byExtension;
}

function titleFromFileName(name) {
  const base = basename(name);
  const extension = extname(base);
  const title = (extension.length > 0 ? base.slice(0, -extension.length) : base).trim();
  return title.length > 0 ? title : base;
}

/** Decode a text file as UTF-8, falling back to GB18030 when the bytes are not UTF-8. */
function decodeTextBytes(bytes, name) {
  const utf8 = bytes.toString('utf8');
  const replacements = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacements === 0) return { text: utf8, warnings: [] };
  let fallback = null;
  try {
    fallback = new TextDecoder('gb18030').decode(bytes);
  } catch {
    fallback = null;
  }
  if (fallback !== null && !fallback.includes('\uFFFD')) {
    return {
      text: fallback,
      warnings: [{ code: 'decoded_as_gb18030', message: `文件 ${name} 不是 UTF-8，已按 GB18030 解码；请确认文字是否正确。` }],
    };
  }
  throw invalid(`文件 ${name} 的编码无法识别（${replacements} 个字符无法解码）`, {
    field: 'path',
    reason: 'text_encoding_unsupported',
    name,
    hint: '请另存为 UTF-8 后重试，或直接粘贴文字导入。',
  });
}

// ---------------------------------------------------------------------------
// Reads: list, get, outline, chunks
// ---------------------------------------------------------------------------

/** List materials in creation order, optionally limited to one goal, kind, or deleted rows. */
function listMaterials(payload, api) {
  const goalId = resolveActiveGoal(api.db, payload.goalId) ?? 'unassigned';
  const kind = optionalOneOf(payload.kind, 'kind', KINDS);
  const includeDeleted = optionalBoolean(payload.includeDeleted, 'includeDeleted') ?? false;
  const conditions = ['goal_id IS ?'];
  const parameters = [goalId];
  if (!includeDeleted) conditions.push('deleted_at IS NULL');
  if (goalId !== null && goalId !== 'unassigned') {
    conditions.push('goal_id = ?');
    parameters.push(goalId);
  }
  if (kind !== null) {
    conditions.push('kind = ?');
    parameters.push(kind);
  }
  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const rows = api.db.all(`SELECT * FROM study_material${where} ORDER BY created_at ASC, rowid ASC`, ...parameters);
  return { materials: rows.map(row => materialSummary(api.db, row)) };
}

/** Read one material summary; a deleted material is `not_found` unless the list asks for it. */
function getMaterial(payload, api) {
  const row = materialRow(api.db, requireText(payload.materialId, 'materialId', { max: 64 }));
  return { material: materialSummary(api.db, row) };
}

/** Report chapter groups and page coverage for one material, including the locators it lacks. */
function outlineMaterial(payload, api) {
  const materialId = requireText(payload.materialId, 'materialId', { max: 64 });
  const row = materialRow(api.db, materialId);
  const summary = materialSummary(api.db, row);
  const chapters = api.db.all(
    `SELECT chapter, chapter_index, COUNT(*) AS chunk_count, MIN(ordinal) AS first_ordinal,
            MIN(page) AS first_page, MAX(page) AS last_page
     FROM study_material_chunk WHERE material_id = ?
     GROUP BY chapter, chapter_index ORDER BY first_ordinal ASC`,
    materialId,
  );
  return {
    materialId,
    title: row.title,
    chunkCount: summary.chunkCount,
    chapters: chapters.map(item => ({
      index: item.chapter_index === null ? null : Number(item.chapter_index),
      title: item.chapter === null ? null : String(item.chapter),
      chunkCount: Number(item.chunk_count),
      page: item.first_page === null ? null : Number(item.first_page),
      lastPage: item.last_page === null ? null : Number(item.last_page),
    })),
    pages: summary.pages,
    missing: summary.missing,
  };
}

/** Read chunks in document order, with their locators and the fields the source did not prove. */
function listChunks(payload, api) {
  const materialId = requireText(payload.materialId, 'materialId', { max: 64 });
  materialRow(api.db, materialId);
  const offset = optionalInteger(payload.offset, 'offset', { min: 0, max: 100000 }) ?? 0;
  const limit = optionalInteger(payload.limit, 'limit', { min: 1, max: 100 }) ?? 20;
  const total = Number(api.db.get('SELECT COUNT(*) AS count FROM study_material_chunk WHERE material_id = ?', materialId).count);
  const rows = api.db.all(
    'SELECT * FROM study_material_chunk WHERE material_id = ? ORDER BY ordinal ASC LIMIT ? OFFSET ?',
    materialId, limit, offset,
  );
  return { materialId, total, offset, limit, items: rows.map(chunkView) };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Retrieve chunks for a query, best first.
 *
 * Segments of two characters or more are matched as FTS5 phrases (CJK bigram
 * phrases, ASCII words) joined with AND; shorter segments fall back to substring
 * filtering. Ranking prefers chunks that contain more query segments, then the
 * FTS5 bm25 score. At most 200 candidates are scored, so very broad queries
 * report the first page of that window rather than the entire corpus.
 */
function searchMaterials(payload, api) {
  const query = requireText(payload.query, 'query', { max: MAX_QUERY_CHARS });
  const limit = optionalInteger(payload.limit, 'limit', { min: 1, max: MAX_SEARCH_LIMIT }) ?? DEFAULT_SEARCH_LIMIT;
  const offset = optionalInteger(payload.offset, 'offset', { min: 0, max: 5000 }) ?? 0;
  const goalId = resolveActiveGoal(api.db, payload.goalId) ?? 'unassigned';
  const materialId = optionalText(payload.materialId, 'materialId', { max: 64 });
  const kind = optionalOneOf(payload.kind, 'kind', KINDS);
  if (goalId !== null && goalId !== 'unassigned' && api.db.get('SELECT id FROM study_goal WHERE id = ?', goalId) === undefined) {
    throw new StudyError('not_found', `找不到目标 ${goalId}`, { goalId });
  }
  if (materialId !== null) materialRow(api.db, materialId);

  const parts = queryPartsOf(query);
  if (parts.length === 0) throw invalid('检索词需要包含文字或数字', { field: 'query', reason: 'query_without_words' });
  if (parts.length > MAX_QUERY_PARTS) throw invalid(`检索词最多 ${MAX_QUERY_PARTS} 段`, { field: 'query', max: MAX_QUERY_PARTS });
  const tokenized = parts.filter(part => part.tokens.length > 0);
  const substringOnly = parts.filter(part => part.tokens.length === 0);
  const matchMode = tokenized.length === 0 ? 'substring' : 'lexical';
  const notice = matchMode === 'substring'
    ? '检索词不足两个字符，已改用整串包含匹配。'
    : substringOnly.length > 0
      ? `「${substringOnly.map(part => part.raw).join('、')}」太短，未进入词法索引，已按包含匹配过滤。`
      : null;

  const conditions = ['m.deleted_at IS NULL', 'm.goal_id IS ?'];
  const parameters = [goalId];
  if (goalId !== null && goalId !== 'unassigned') {
    conditions.push('m.goal_id = ?');
    parameters.push(goalId);
  }
  if (materialId !== null) {
    conditions.push('m.id = ?');
    parameters.push(materialId);
  }
  if (kind !== null) {
    conditions.push('m.kind = ?');
    parameters.push(kind);
  }
  const candidateLimit = Math.min(200, (offset + limit) * 6 + 12);

  let candidates;
  if (matchMode === 'substring') {
    const rows = api.db.all(
      `SELECT c.id AS chunk_id, c.ordinal AS ordinal
       FROM study_material_chunk c JOIN study_material m ON m.id = c.material_id
       WHERE ${conditions.join(' AND ')} AND c.text LIKE ? ESCAPE '\\'
       ORDER BY m.created_at ASC, c.ordinal ASC LIMIT ?`,
      ...parameters, `%${escapeLike(query)}%`, candidateLimit,
    );
    candidates = rows.map(row => ({ chunkId: String(row.chunk_id), bm25: 0, ordinal: Number(row.ordinal) }));
  } else {
    const match = tokenized.map(part => `"${part.tokens.join(' ')}"`).join(' AND ');
    const rows = api.db.all(
      `SELECT chunk_id, bm25(study_material_fts) AS bm25
       FROM study_material_fts
       WHERE study_material_fts MATCH ?
         AND chunk_id IN (
           SELECT c.id FROM study_material_chunk c JOIN study_material m ON m.id = c.material_id
           WHERE ${conditions.join(' AND ')}
         )
       ORDER BY bm25 LIMIT ?`,
      match, ...parameters, candidateLimit,
    );
    candidates = rows.map(row => ({ chunkId: String(row.chunk_id), bm25: Number(row.bm25), ordinal: 0 }));
  }

  const hits = [];
  for (const candidate of candidates) {
    const chunk = api.db.get('SELECT * FROM study_material_chunk WHERE id = ?', candidate.chunkId);
    if (chunk === undefined) continue;
    const material = api.db.get('SELECT * FROM study_material WHERE id = ?', chunk.material_id);
    if (material === undefined || material.deleted_at !== null) continue;
    const normalizedText = normalizeForMatch(String(chunk.text));
    if (!substringOnly.every(part => normalizedText.includes(normalizeForMatch(part.raw)))) continue;
    const matched = parts
      .filter(part => normalizedText.includes(normalizeForMatch(part.raw)))
      .map(part => part.raw);
    hits.push(hitOf(material, chunk, candidate.bm25, matched));
  }
  hits.sort((left, right) => right.matchedTerms.length - left.matchedTerms.length
    || left.bm25 - right.bm25
    || left.ordinal - right.ordinal
    || left.chunkId.localeCompare(right.chunkId));

  const page = hits.slice(offset, offset + limit);
  return {
    query,
    tokens: parts.map(part => part.raw),
    matchMode,
    notice,
    limit,
    offset,
    hasMore: hits.length > offset + limit,
    hits: page,
  };
}

function hitOf(material, chunk, bm25, matchedTerms) {
  const page = chunk.page === null ? null : Number(chunk.page);
  const chapter = chunk.chapter === null ? null : String(chunk.chapter);
  const unverified = [];
  if (page === null) unverified.push('page');
  if (chapter === null) unverified.push('chapter');
  return {
    materialId: String(material.id),
    chunkId: String(chunk.id),
    ordinal: Number(chunk.ordinal),
    title: String(material.title),
    kind: String(material.kind),
    subject: material.subject === null ? null : String(material.subject),
    edition: material.edition === null ? null : String(material.edition),
    citation: citationOf(material, { page, chapter }),
    snippet: snippetOf(String(chunk.text), matchedTerms.map(raw => ({ raw }))),
    matchedTerms,
    bm25,
    locator: {
      page,
      chapter,
      chapterIndex: chunk.chapter_index === null ? null : Number(chunk.chapter_index),
    },
    locatorSource: String(chunk.locator_source),
    unverified,
    sourceDate: String(chunk.source_date),
    verification: String(material.verification),
  };
}

// ---------------------------------------------------------------------------
// Location lookup
// ---------------------------------------------------------------------------

function normalizeChapter(text) {
  return text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** Find the chunk group a requested chapter names, or null when the material cannot prove it. */
function matchChapter(chunks, request) {
  const groups = new Map();
  for (const chunk of chunks) {
    if (chunk.chapter === null) continue;
    const key = `${chunk.chapter_index ?? 'x'}|${chunk.chapter}`;
    if (!groups.has(key)) {
      groups.set(key, {
        title: String(chunk.chapter),
        index: chunk.chapter_index === null ? null : Number(chunk.chapter_index),
        chunks: [],
        firstPage: null,
      });
    }
    const group = groups.get(key);
    group.chunks.push(chunk);
    if (chunk.page !== null && group.firstPage === null) group.firstPage = Number(chunk.page);
  }
  const normalizedRequest = normalizeChapter(request);
  const requestNumber = chapterNumber(request);
  for (const group of groups.values()) {
    const normalizedTitle = normalizeChapter(group.title);
    if (normalizedTitle === normalizedRequest
      || normalizedTitle.startsWith(normalizedRequest)
      || normalizedRequest.startsWith(normalizedTitle)) {
      return group;
    }
    const groupNumber = group.index ?? chapterNumber(group.title);
    if (requestNumber !== null && groupNumber !== null && requestNumber === groupNumber) return group;
  }
  return null;
}

/** Pattern that treats an exercise label as a question number, not as free text. */
function exercisePattern(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:习题|练习|例题|例|第)\\s*${escaped}\\s*题?`, 'u');
}

/**
 * Check a requested chapter, page, or exercise number against the imported text.
 *
 * A field is confirmed only when the material's own text proves it; anything
 * else is listed in `unverified` with a reason, so a plan never gains a page or
 * question number that the student did not provide.
 */
function locateMaterial(payload, api) {
  const materialId = requireText(payload.materialId, 'materialId', { max: 64 });
  const row = materialRow(api.db, materialId);
  const chapterRequest = optionalText(payload.chapter, 'chapter', { max: 200 });
  const pageRequest = optionalInteger(payload.page, 'page', { min: 1, max: 100000 });
  const exerciseRequest = optionalText(payload.exercise, 'exercise', { max: 40 });
  if (chapterRequest === null && pageRequest === null && exerciseRequest === null) {
    throw invalid('locate 需要 chapter、page 或 exercise 至少一个', { field: 'chapter' });
  }

  const chunks = api.db.all('SELECT * FROM study_material_chunk WHERE material_id = ? ORDER BY ordinal ASC', materialId);
  const matches = { chapter: null, page: null, exercise: null };
  const unverified = [];
  const reasons = [];
  let scope = chunks;

  if (chapterRequest !== null) {
    const match = matchChapter(chunks, chapterRequest);
    if (match === null) {
      unverified.push('chapter');
      reasons.push(`导入文本中没有「${chapterRequest}」这一章`);
    } else {
      matches.chapter = {
        requested: chapterRequest,
        title: match.title,
        index: match.index,
        firstPage: match.firstPage,
        chunkCount: match.chunks.length,
        chunkIds: match.chunks.slice(0, 20).map(chunk => String(chunk.id)),
      };
      scope = match.chunks;
    }
  }

  if (pageRequest !== null) {
    const found = chunks.filter(chunk => chunk.page === pageRequest);
    if (found.length > 0) {
      matches.page = {
        requested: pageRequest,
        chunkCount: found.length,
        chunkIds: found.slice(0, 20).map(chunk => String(chunk.id)),
        excerpt: String(found[0].text).slice(0, 80),
      };
    } else {
      unverified.push('page');
      const known = chunks.filter(chunk => chunk.page !== null).map(chunk => Number(chunk.page));
      if (known.length === 0) {
        reasons.push('这份资料没有任何页码定位');
      } else {
        reasons.push(`页码 ${pageRequest} 不在已知页码范围 ${Math.min(...known)}-${Math.max(...known)} 内，或该页没有文字`);
      }
    }
  }

  if (exerciseRequest !== null) {
    const pattern = exercisePattern(exerciseRequest);
    const haystack = scope.length > 0 ? scope : chunks;
    const found = haystack.find(chunk => pattern.test(String(chunk.text)));
    if (found !== undefined) {
      matches.exercise = {
        requested: exerciseRequest,
        chunkId: String(found.id),
        page: found.page === null ? null : Number(found.page),
        chapter: found.chapter === null ? null : String(found.chapter),
        excerpt: String(found.text).slice(0, 120),
      };
    } else {
      unverified.push('exercise');
      reasons.push(`导入文本中没有找到「${exerciseRequest}」；请补充目录或原文后再安排到题号`);
    }
  }

  const verification = unverified.length === 0
    ? 'verified'
    : Object.values(matches).some(Boolean) ? 'partial' : 'unverified';
  return {
    materialId,
    title: row.title,
    requested: { chapter: chapterRequest, page: pageRequest, exercise: exerciseRequest },
    matches,
    unverified,
    verification,
    reason: reasons.length === 0 ? null : reasons.join('；'),
  };
}

// ---------------------------------------------------------------------------
// Writes: update and delete
// ---------------------------------------------------------------------------

const PATCHABLE_COLUMNS = new Map([
  ['title', 'title'],
  ['edition', 'edition'],
  ['subject', 'subject'],
  ['kind', 'kind'],
  ['verification', 'verification'],
  ['toc', 'toc_json'],
]);

/** Change material metadata without re-importing its text; the change log keeps both sides. */
function updateMaterial(payload, api) {
  const materialId = requireText(payload.materialId, 'materialId', { max: 64 });
  const row = materialRow(api.db, materialId);
  const patch = new Map();
  if (payload.title !== undefined) patch.set('title', requireText(payload.title, 'title', { max: 200 }));
  if (payload.edition !== undefined) patch.set('edition', optionalText(payload.edition, 'edition', { max: 120 }));
  if (payload.subject !== undefined) patch.set('subject', optionalText(payload.subject, 'subject', { max: 120 }));
  if (payload.kind !== undefined) patch.set('kind', oneOf(payload.kind, 'kind', KINDS));
  if (payload.verification !== undefined) patch.set('verification', oneOf(payload.verification, 'verification', VERIFICATIONS));
  if (payload.toc !== undefined) patch.set('toc', JSON.stringify(validateToc(payload.toc) ?? []));
  if (patch.size === 0) {
    throw invalid('updateMaterial 没有任何要更新的字段', { fields: ['title', 'edition', 'subject', 'kind', 'verification', 'toc'] });
  }

  const assignments = [];
  const parameters = [];
  for (const [field, value] of patch) {
    assignments.push(`${PATCHABLE_COLUMNS.get(field)} = ?`);
    parameters.push(value);
  }
  const now = api.now().toISOString();
  assignments.push('updated_at = ?');
  parameters.push(now, materialId);
  api.db.run(`UPDATE study_material SET ${assignments.join(', ')} WHERE id = ?`, ...parameters);

  const material = materialSummary(api.db, api.db.get('SELECT * FROM study_material WHERE id = ?', materialId));
  api.change({
    entity: 'material',
    entityId: materialId,
    action: 'update',
    before: materialSummary(api.db, row),
    after: material,
    reason: `更新字段：${[...patch.keys()].join('、')}`,
  });
  return { material };
}

/** Delete a material: chunks and index rows go away, and the material keeps a tombstone. */
function deleteMaterial(payload, api) {
  const materialId = requireText(payload.materialId, 'materialId', { max: 64 });
  const row = materialRow(api.db, materialId, { includeDeleted: true });
  if (row.deleted_at !== null) return { materialId, deleted: true, removedChunks: 0 };

  const removedChunks = Number(api.db.get('SELECT COUNT(*) AS count FROM study_material_chunk WHERE material_id = ?', materialId).count);
  api.db.run('DELETE FROM study_material_fts WHERE material_id = ?', materialId);
  api.db.run('DELETE FROM study_material_chunk WHERE material_id = ?', materialId);
  const now = api.now().toISOString();
  api.db.run('UPDATE study_material SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, materialId);
  api.change({
    entity: 'material',
    entityId: materialId,
    action: 'delete',
    before: { title: row.title, kind: row.kind, chunkCount: removedChunks },
  });
  return { materialId, deleted: true, removedChunks };
}

// ---------------------------------------------------------------------------
// PDF text layer
// ---------------------------------------------------------------------------

const PDF_DELIMITER = /[\s()<>[\]{}/%]/;
const WIN_ANSI = new Map([
  [0x80, '€'], [0x82, '‚'], [0x83, 'ƒ'], [0x84, '„'], [0x85, '…'], [0x86, '†'], [0x87, '‡'],
  [0x88, 'ˆ'], [0x89, '‰'], [0x8a, 'Š'], [0x8b, '‹'], [0x8c, 'Œ'], [0x8e, 'Ž'], [0x91, '‘'],
  [0x92, '’'], [0x93, '“'], [0x94, '”'], [0x95, '•'], [0x96, '–'], [0x97, '—'], [0x98, '˜'],
  [0x99, '™'], [0x9a, 'š'], [0x9b, '›'], [0x9c, 'œ'], [0x9e, 'ž'], [0x9f, 'Ÿ'],
]);

function pdfFailure(reason, message, details = {}) {
  return new StudyError('invalid', message, { reason, ...details });
}

/**
 * Extract the text layer of a PDF, page by page.
 * @param {Buffer} bytes - Whole PDF file.
 * @returns {{ text: string, pageCount: number, warnings: Array<object> }} Page text joined with `\f`, in page order.
 * @throws {StudyError} `invalid` with `details.reason` naming why the text layer cannot be used.
 */
function extractPdfText(bytes) {
  if (bytes.length > MAX_PDF_BYTES) {
    throw pdfFailure('file_too_large', `PDF 超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB，请拆分后再导入`, { bytes: bytes.length });
  }
  const raw = bytes.toString('latin1');
  if (!raw.includes('%PDF-')) {
    throw pdfFailure('pdf_invalid', '这不是有效的 PDF 文件（缺少 %PDF- 头）', { hint: '请确认文件没有损坏。' });
  }

  let objects;
  try {
    objects = parsePdfObjects(raw);
  } catch (error) {
    if (raw.includes('/Encrypt')) {
      throw pdfFailure('pdf_encrypted', '这份 PDF 有打开密码或加密保护，无法读取文字', { hint: '请先去除密码保护，或直接粘贴需要的内容。' });
    }
    throw pdfFailure('pdf_invalid', 'PDF 结构无法解析，文件可能损坏', { hint: '请用阅读器另存为文字版 PDF，或粘贴需要的内容。', detail: error.message });
  }
  if (objects.size === 0) {
    throw pdfFailure('pdf_invalid', 'PDF 中没有可读的对象，文件可能损坏', { hint: '请用阅读器另存为文字版 PDF，或粘贴需要的内容。' });
  }
  if (hasPdfEncryption(objects, raw)) {
    throw pdfFailure('pdf_encrypted', '这份 PDF 有打开密码或加密保护，无法读取文字', { hint: '请先去除密码保护，或直接粘贴需要的内容。' });
  }
  expandPdfObjectStreams(objects, raw);

  let pages;
  try {
    pages = collectPdfPages(objects, raw);
  } catch (error) {
    throw pdfFailure('pdf_invalid', 'PDF 页面结构无法解析', { hint: '请用阅读器另存为文字版 PDF，或粘贴需要的内容。', detail: error.message });
  }
  if (pages.length === 0) {
    throw pdfFailure('pdf_invalid', 'PDF 中没有找到页面', { hint: '请用阅读器另存为文字版 PDF，或粘贴需要的内容。' });
  }
  const truncated = pages.length > MAX_PDF_PAGES;
  if (truncated) pages = pages.slice(0, MAX_PDF_PAGES);

  const extracted = [];
  const failedPages = [];
  let unsupportedFonts = 0;
  for (const [index, page] of pages.entries()) {
    let text = '';
    try {
      const decoded = readPdfPageText(objects, raw, page);
      unsupportedFonts += decoded.unsupported;
      text = tidyPdfText(decoded.text);
    } catch (error) {
      if (error instanceof StudyError && error.details?.reason === 'pdf_unsupported_filter') throw error;
      failedPages.push(index + 1);
      text = '';
    }
    const garbled = garbledRatio(text);
    const usable = text.length > 0 && garbled <= 0.3;
    extracted.push({ index: index + 1, text: usable ? text : '', garbled: text.length > 0 && !usable, hasImage: page.hasImage });
  }

  const usablePages = extracted.filter(page => page.text.length > 0);
  if (usablePages.length === 0) {
    if (unsupportedFonts > 0) {
      throw pdfFailure('pdf_text_encoding_unsupported', '这份 PDF 的文字缺少到 Unicode 的映射，无法可靠还原', {
        pages: extracted.length,
        unsupportedFonts,
        hint: '请补充目录或摘录，或改用文字版 PDF。',
      });
    }
    const garbledPages = extracted.filter(page => page.garbled).map(page => page.index);
    if (garbledPages.length > 0) {
      throw pdfFailure('pdf_text_encoding_unsupported', '这份 PDF 的文字编码无法还原（字体缺少到 Unicode 的映射）', {
        pages: extracted.length,
        garbledPages,
        hint: '请补充目录或摘录，或改用文字版 PDF。',
      });
    }
    if (failedPages.length === extracted.length) {
      throw pdfFailure('pdf_invalid', 'PDF 的页面内容无法解析，文件可能损坏', {
        pages: extracted.length,
        failedPages,
        hint: '请用阅读器另存为文字版 PDF，或粘贴需要的内容。',
      });
    }
    throw pdfFailure('pdf_no_text_layer', `这份 PDF 没有可提取的文字层（${extracted.length} 页全是图片），通常是扫描件`, {
      pages: extracted.length,
      imagePages: extracted.filter(page => page.hasImage).length,
      hint: '扫描件需要先做文字识别，或由学生补充目录与摘录后再导入。',
    });
  }

  const warnings = [];
  const emptyPages = extracted.filter(page => page.text.length === 0).map(page => page.index);
  if (emptyPages.length > 0) {
    warnings.push({
      code: 'pdf_pages_without_text',
      message: `第 ${emptyPages.slice(0, 20).join('、')} 页没有文字层，未导入这些页`,
      pages: emptyPages,
    });
  }
  if (failedPages.length > 0) {
    warnings.push({
      code: 'pdf_pages_unreadable',
      message: `第 ${failedPages.slice(0, 20).join('、')} 页的内容无法解析，未导入这些页`,
      pages: failedPages,
    });
  }
  if (unsupportedFonts > 0) {
    warnings.push({
      code: 'pdf_fonts_without_unicode',
      message: '部分字体缺少到 Unicode 的映射，这些字体排出的文字没有导入；请核对原文',
      fonts: unsupportedFonts,
    });
  }
  if (truncated) {
    warnings.push({ code: 'pdf_page_limit', message: `PDF 页数超过 ${MAX_PDF_PAGES}，只导入了前 ${MAX_PDF_PAGES} 页`, pages: MAX_PDF_PAGES });
  }
  return { text: extracted.map(page => page.text).join('\f'), pageCount: extracted.length, warnings };
}

function skipPdfSpace(raw, cursor) {
  let position = cursor;
  while (position < raw.length) {
    const char = raw[position];
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\0') {
      position += 1;
      continue;
    }
    if (char === '%') {
      while (position < raw.length && raw[position] !== '\n') position += 1;
      continue;
    }
    break;
  }
  return position;
}

function isPdfRef(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.ref === 'number';
}

function isPdfString(value) {
  return value !== null && typeof value === 'object' && typeof value.str === 'string';
}

function isPdfDict(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isPdfRef(value) && !isPdfString(value);
}

/** Follow indirect references to their value; returns undefined for a dangling reference. */
function deref(objects, value) {
  let current = value;
  for (let depth = 0; depth < 8 && isPdfRef(current); depth += 1) {
    const object = objects.get(current.ref);
    if (object === undefined) return undefined;
    current = object.value;
  }
  return current;
}

function parsePdfValue(raw, cursor) {
  const start = skipPdfSpace(raw, cursor);
  const char = raw[start];
  if (char === undefined) throw new Error('unexpected end of value');
  if (char === '<' && raw[start + 1] === '<') return parsePdfDict(raw, start);
  if (char === '<') return parsePdfHexString(raw, start);
  if (char === '(') return parsePdfLiteralString(raw, start);
  if (char === '[') return parsePdfArray(raw, start);
  if (char === '/') return parsePdfName(raw, start);
  if (char === '+' || char === '-' || char === '.' || (char >= '0' && char <= '9')) {
    const tail = raw.slice(start, start + 40);
    const reference = /^(\d{1,10})\s+(\d{1,5})\s+R(?![A-Za-z])/.exec(tail);
    if (reference !== null) return { value: { ref: Number(reference[1]) }, end: start + reference[0].length };
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.exec(tail);
    if (number === null) throw new Error('bad number');
    return { value: Number(number[0]), end: start + number[0].length };
  }
  if (raw.startsWith('true', start)) return { value: true, end: start + 4 };
  if (raw.startsWith('false', start)) return { value: false, end: start + 5 };
  if (raw.startsWith('null', start)) return { value: null, end: start + 4 };
  throw new Error(`unexpected token at ${start}`);
}

function parsePdfName(raw, cursor) {
  let position = cursor + 1;
  let name = '';
  while (position < raw.length) {
    const char = raw[position];
    if (PDF_DELIMITER.test(char)) break;
    if (char === '#' && /^[0-9A-Fa-f]{2}$/.test(raw.slice(position + 1, position + 3))) {
      name += String.fromCharCode(parseInt(raw.slice(position + 1, position + 3), 16));
      position += 3;
      continue;
    }
    name += char;
    position += 1;
  }
  return { value: name, end: position };
}

function parsePdfDict(raw, cursor) {
  let position = cursor + 2;
  const dict = {};
  while (true) {
    position = skipPdfSpace(raw, position);
    if (raw[position] === '>' && raw[position + 1] === '>') return { value: dict, end: position + 2 };
    if (raw[position] === undefined) throw new Error('unterminated dictionary');
    const key = parsePdfName(raw, position);
    const value = parsePdfValue(raw, key.end);
    dict[key.value] = value.value;
    position = value.end;
  }
}

function parsePdfArray(raw, cursor) {
  let position = cursor + 1;
  const items = [];
  while (true) {
    position = skipPdfSpace(raw, position);
    if (raw[position] === ']') return { value: items, end: position + 1 };
    if (raw[position] === undefined) throw new Error('unterminated array');
    const item = parsePdfValue(raw, position);
    items.push(item.value);
    position = item.end;
  }
}

function parsePdfHexString(raw, cursor) {
  const end = raw.indexOf('>', cursor + 1);
  if (end === -1) throw new Error('unterminated hex string');
  let hex = raw.slice(cursor + 1, end).replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length % 2 === 1) hex += '0';
  let bytes = '';
  for (let index = 0; index < hex.length; index += 2) {
    bytes += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
  }
  return { value: { str: bytes }, end: end + 1 };
}

function parsePdfLiteralString(raw, cursor) {
  let position = cursor + 1;
  let depth = 1;
  let bytes = '';
  while (position < raw.length) {
    const char = raw[position];
    if (char === '\\') {
      const next = raw[position + 1];
      position += 2;
      if (next === 'n') bytes += '\n';
      else if (next === 'r') bytes += '\r';
      else if (next === 't') bytes += '\t';
      else if (next === 'b') bytes += '\b';
      else if (next === 'f') bytes += '\f';
      else if (next === '\n') { /* Line continuation: drop the newline. */ }
      else if (next === '\r') {
        if (raw[position] === '\n') position += 1;
      } else if (next >= '0' && next <= '7') {
        let octal = next;
        while (octal.length < 3 && raw[position] >= '0' && raw[position] <= '7') {
          octal += raw[position];
          position += 1;
        }
        bytes += String.fromCharCode(parseInt(octal, 8) & 0xff);
      } else {
        bytes += next ?? '';
      }
      continue;
    }
    if (char === '(') {
      depth += 1;
      bytes += char;
      position += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      position += 1;
      if (depth === 0) return { value: { str: bytes }, end: position };
      bytes += char;
      continue;
    }
    bytes += char;
    position += 1;
  }
  throw new Error('unterminated string');
}

/** Whether `/Encrypt` appears outside a stream, which is where an encrypted PDF declares it. */
function hasPdfEncryption(objects, raw) {
  const streams = [...objects.values()].filter(object => object.stream !== null).map(object => object.stream);
  let index = raw.indexOf('/Encrypt');
  while (index !== -1) {
    if (!streams.some(stream => index >= stream.start && index < stream.end)) return true;
    index = raw.indexOf('/Encrypt', index + 1);
  }
  return false;
}

/** Collect every `N G obj` definition, skipping over stream payloads. */
function parsePdfObjects(raw) {
  const objects = new Map();
  const header = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let match;
  while ((match = header.exec(raw)) !== null) {
    const number = Number(match[1]);
    let cursor = match.index + match[0].length;
    let parsed;
    try {
      parsed = parsePdfValue(raw, cursor);
    } catch {
      header.lastIndex = match.index + match[0].length;
      continue;
    }
    cursor = skipPdfSpace(raw, parsed.end);
    let stream = null;
    if (raw.startsWith('stream', cursor)) {
      cursor += 'stream'.length;
      if (raw[cursor] === '\r') cursor += 1;
      if (raw[cursor] === '\n') cursor += 1;
      const dataStart = cursor;
      let dataEnd = null;
      const declared = isPdfDict(parsed.value) && Number.isSafeInteger(parsed.value.Length) ? parsed.value.Length : null;
      if (declared !== null && declared >= 0 && raw.startsWith('endstream', skipPdfSpace(raw, dataStart + declared))) {
        dataEnd = dataStart + declared;
      }
      if (dataEnd === null) {
        const found = raw.indexOf('endstream', dataStart);
        if (found === -1) throw new Error('missing endstream');
        dataEnd = found;
        while (dataEnd > dataStart && (raw[dataEnd - 1] === '\n' || raw[dataEnd - 1] === '\r')) dataEnd -= 1;
      }
      stream = { start: dataStart, end: dataEnd };
      const after = raw.indexOf('endstream', dataEnd);
      cursor = after === -1 ? dataEnd : after + 'endstream'.length;
    }
    if (!objects.has(number)) objects.set(number, { number, value: parsed.value, stream });
    header.lastIndex = Math.max(header.lastIndex, cursor);
  }
  return objects;
}

/** Add objects that live inside compressed object streams (PDF 1.5+). */
function expandPdfObjectStreams(objects, raw) {
  for (const object of [...objects.values()]) {
    if (!isPdfDict(object.value) || object.value.Type !== 'ObjStm' || object.stream === null) continue;
    let data;
    try {
      data = decodePdfStream(objects, raw, object);
    } catch {
      continue;
    }
    const text = data.toString('latin1');
    const count = Number(object.value.N);
    const first = Number(object.value.First);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(first) || first < 0 || first > text.length) continue;
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let index = 0; index + 1 < header.length && index / 2 < count; index += 2) {
      const number = header[index];
      const offset = header[index + 1];
      if (!Number.isSafeInteger(number) || !Number.isSafeInteger(offset) || objects.has(number)) continue;
      try {
        const parsed = parsePdfValue(text, first + offset);
        objects.set(number, { number, value: parsed.value, stream: null });
      } catch { /* One unreadable object inside a stream is skipped, not fatal. */ }
    }
  }
}

function decodePdfStream(objects, raw, object) {
  let bytes = Buffer.from(raw.slice(object.stream.start, object.stream.end), 'latin1');
  const filterValue = deref(objects, object.value.Filter);
  const filters = filterValue === undefined
    ? []
    : Array.isArray(filterValue) ? filterValue.map(entry => String(deref(objects, entry))) : [String(filterValue)];
  for (const filter of filters) {
    switch (filter) {
      case 'FlateDecode':
      case 'Fl':
        bytes = inflatePdf(bytes);
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        bytes = asciiHexDecode(bytes);
        break;
      case 'ASCII85Decode':
      case 'A85':
        bytes = ascii85Decode(bytes);
        break;
      default:
        throw pdfFailure('pdf_unsupported_filter', `PDF 使用了不支持的压缩方式 ${filter}`, { filter, hint: '请用阅读器另存为文字版 PDF，或粘贴需要的内容。' });
    }
  }
  return bytes;
}

function inflatePdf(bytes) {
  try {
    return inflateSync(bytes);
  } catch { /* Fall through to a raw deflate stream, which some writers produce. */ }
  try {
    return inflateRawSync(bytes);
  } catch (error) {
    throw pdfFailure('pdf_invalid', 'PDF 内容流解压失败，文件可能损坏', { hint: '请用阅读器另存为文字版 PDF，或粘贴需要的内容。', detail: error.message });
  }
}

function asciiHexDecode(bytes) {
  const text = bytes.toString('latin1');
  const end = text.indexOf('>');
  let hex = (end === -1 ? text : text.slice(0, end)).replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length % 2 === 1) hex += '0';
  const out = Buffer.alloc(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) out[index / 2] = parseInt(hex.slice(index, index + 2), 16);
  return out;
}

function ascii85Decode(bytes) {
  const text = bytes.toString('latin1').replace(/\s+/g, '');
  const out = [];
  let group = [];
  for (const char of text) {
    if (char === '~') break;
    if (char === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    group.push(code);
    if (group.length === 5) {
      let value = 0;
      for (const digit of group) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group = [];
    }
  }
  if (group.length > 0) {
    const missing = 5 - group.length;
    for (let index = 0; index < missing; index += 1) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const decoded = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...decoded.slice(0, 4 - missing));
  }
  return Buffer.from(out);
}

function collectPdfPages(objects) {
  const pages = [];
  const visit = (ref, inheritedResources, depth) => {
    if (depth > 64 || pages.length > MAX_PDF_PAGES * 2) return;
    const dict = isPdfRef(ref) ? deref(objects, ref) : ref;
    if (!isPdfDict(dict)) return;
    const resources = dict.Resources !== undefined ? deref(objects, dict.Resources) : inheritedResources;
    const kids = deref(objects, dict.Kids);
    if (Array.isArray(kids)) {
      for (const kid of kids) visit(kid, resources, depth + 1);
      return;
    }
    pages.push({ dict, resources, hasImage: pdfPageHasImage(objects, resources) });
  };
  const catalog = [...objects.values()].find(object => isPdfDict(object.value) && object.value.Type === 'Catalog');
  if (catalog !== undefined && catalog.value.Pages !== undefined) visit(catalog.value.Pages, undefined, 0);
  if (pages.length === 0) {
    for (const object of objects.values()) {
      if (!isPdfDict(object.value) || object.value.Type !== 'Page') continue;
      const resources = deref(objects, object.value.Resources);
      pages.push({ dict: object.value, resources, hasImage: pdfPageHasImage(objects, resources) });
    }
  }
  return pages;
}

function pdfPageHasImage(objects, resources) {
  const xobjects = deref(objects, resources?.XObject);
  if (!isPdfDict(xobjects)) return false;
  return Object.values(xobjects).some(value => {
    const dict = deref(objects, value);
    return isPdfDict(dict) && dict.Subtype === 'Image';
  });
}

function readPdfPageText(objects, raw, page) {
  const contents = page.dict.Contents;
  const refs = Array.isArray(contents) ? contents : [contents];
  const buffers = [];
  for (const ref of refs) {
    if (!isPdfRef(ref)) continue;
    const object = objects.get(ref.ref);
    if (object === undefined || object.stream === null) continue;
    buffers.push(decodePdfStream(objects, raw, object));
  }
  if (buffers.length === 0) return { text: '', unsupported: 0 };
  return interpretPdfContent(Buffer.concat(buffers), pdfFontDecoders(objects, raw, page.resources));
}

function pdfFontDecoders(objects, raw, resources) {
  const fonts = new Map();
  const fontDict = deref(objects, resources?.Font);
  if (!isPdfDict(fontDict)) return fonts;
  for (const [name, ref] of Object.entries(fontDict)) {
    const dict = deref(objects, ref);
    if (!isPdfDict(dict)) continue;
    const twoByte = dict.Subtype === 'Type0';
    let cmap = null;
    if (isPdfRef(dict.ToUnicode)) {
      const stream = objects.get(dict.ToUnicode.ref);
      if (stream !== undefined && stream.stream !== null) {
        try {
          cmap = parsePdfCMap(decodePdfStream(objects, raw, stream).toString('latin1'));
        } catch {
          cmap = null;
        }
      }
    }
    fonts.set(name, { twoByte, cmap, unsupported: twoByte && cmap === null });
  }
  return fonts;
}

function hexToUnicodeText(hex) {
  let output = '';
  const even = hex.length % 2 === 1 ? `${hex}0` : hex;
  for (let index = 0; index < even.length; index += 4) {
    output += String.fromCharCode(parseInt(even.slice(index, index + 4).padEnd(4, '0'), 16));
  }
  return output;
}

function parsePdfCMap(text) {
  const map = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), hexToUnicodeText(pair[2]));
    }
  }
  const rangePattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g;
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const entry of block[1].matchAll(rangePattern)) {
      const low = parseInt(entry[1], 16);
      const high = parseInt(entry[2], 16);
      if (high < low || high - low > 65535) continue;
      if (entry[4] !== undefined) {
        const items = [...entry[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map(item => hexToUnicodeText(item[1]));
        for (let code = low; code <= high && code - low < items.length; code += 1) map.set(code, items[code - low]);
        continue;
      }
      const base = [...hexToUnicodeText(entry[3])];
      if (base.length === 0) continue;
      const head = base.slice(0, -1).join('');
      const last = base[base.length - 1].codePointAt(0);
      for (let code = low; code <= high; code += 1) map.set(code, head + String.fromCharCode(last + (code - low)));
    }
  }
  return map.size === 0 ? null : map;
}

function latin1Text(bytes) {
  let output = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const code = bytes.charCodeAt(index);
    if (code === 10 || code === 13) output += '\n';
    else if (code < 32 || (code >= 127 && code <= 159)) output += WIN_ANSI.get(code) ?? '';
    else output += String.fromCharCode(code);
  }
  return output;
}

function decodePdfString(bytes, font, onUnsupported) {
  if (font === undefined) return latin1Text(bytes);
  if (font.unsupported) {
    onUnsupported();
    return '';
  }
  let output = '';
  if (font.twoByte) {
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      const code = (bytes.charCodeAt(index) << 8) | bytes.charCodeAt(index + 1);
      output += font.cmap?.get(code) ?? '';
    }
    return output;
  }
  for (let index = 0; index < bytes.length; index += 1) {
    const code = bytes.charCodeAt(index);
    if (font.cmap !== null) {
      output += font.cmap.get(code) ?? latin1Text(bytes.charAt(index));
      continue;
    }
    output += latin1Text(bytes.charAt(index));
  }
  return output;
}

function readPdfContentTokens(raw) {
  const tokens = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const char = raw[cursor];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    if (char === '%') {
      while (cursor < raw.length && raw[cursor] !== '\n') cursor += 1;
      continue;
    }
    if (char === '(') {
      const value = parsePdfLiteralString(raw, cursor);
      cursor = value.end;
      tokens.push({ type: 'string', value: value.value.str });
      continue;
    }
    if (char === '<' && raw[cursor + 1] === '<') {
      const value = parsePdfValue(raw, cursor);
      cursor = value.end;
      tokens.push({ type: 'dict' });
      continue;
    }
    if (char === '<') {
      const value = parsePdfHexString(raw, cursor);
      cursor = value.end;
      tokens.push({ type: 'string', value: value.value.str });
      continue;
    }
    if (char === '[') {
      const value = parsePdfValue(raw, cursor);
      cursor = value.end;
      tokens.push({
        type: 'array',
        items: value.value.map(item => (isPdfString(item) ? { type: 'string', value: item.str } : { type: 'number', value: typeof item === 'number' ? item : 0 })),
      });
      continue;
    }
    if (char === '/') {
      const value = parsePdfName(raw, cursor);
      cursor = value.end;
      tokens.push({ type: 'name', value: value.value });
      continue;
    }
    if (char === '+' || char === '-' || char === '.' || (char >= '0' && char <= '9')) {
      const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.exec(raw.slice(cursor, cursor + 24));
      if (number !== null) {
        tokens.push({ type: 'number', value: Number(number[0]) });
        cursor += number[0].length;
        continue;
      }
    }
    let operator = '';
    while (cursor < raw.length) {
      const current = raw[cursor];
      if (PDF_DELIMITER.test(current)) break;
      operator += current;
      cursor += 1;
    }
    if (operator.length === 0) {
      cursor += 1;
      continue;
    }
    if (operator === 'BI') {
      const end = raw.indexOf('EI', cursor);
      cursor = end === -1 ? raw.length : end + 2;
      continue;
    }
    tokens.push({ type: 'operator', value: operator });
  }
  return tokens;
}

function interpretPdfContent(bytes, fonts) {
  const raw = bytes.toString('latin1');
  let text = '';
  let font;
  let unsupported = 0;
  const newline = () => {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  };
  const append = value => { text += value; };
  const show = value => append(decodePdfString(value, font, () => { unsupported += 1; }));
  let operands = [];
  for (const token of readPdfContentTokens(raw)) {
    if (token.type !== 'operator') {
      operands.push(token);
      continue;
    }
    switch (token.value) {
      case 'Tf': {
        const name = operands.findLast(item => item.type === 'name');
        font = name === undefined ? undefined : fonts.get(name.value);
        break;
      }
      case 'BT':
      case 'ET':
      case 'Td':
      case 'TD':
      case 'T*':
      case 'Tm':
        newline();
        break;
      case 'Tj': {
        const item = operands.findLast(value => value.type === 'string');
        if (item !== undefined) show(item.value);
        break;
      }
      case "'": {
        newline();
        const item = operands.findLast(value => value.type === 'string');
        if (item !== undefined) show(item.value);
        break;
      }
      case '"': {
        newline();
        const item = operands.findLast(value => value.type === 'string');
        if (item !== undefined) show(item.value);
        break;
      }
      case 'TJ': {
        const array = operands.findLast(value => value.type === 'array');
        if (array !== undefined) {
          for (const entry of array.items) {
            if (entry.type === 'string') show(entry.value);
            else if (entry.type === 'number' && entry.value <= -180) append(' ');
          }
        }
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  return { text, unsupported };
}

function tidyPdfText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function garbledRatio(text) {
  if (text.length === 0) return 0;
  let garbled = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (char === '\uFFFD' || (code >= 0xe000 && code <= 0xf8ff) || (code < 32 && char !== '\n' && char !== '\t')) {
      garbled += 1;
    }
  }
  return garbled / [...text].length;
}
