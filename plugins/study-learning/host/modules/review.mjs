/**
 * Review module: rule-based weekly and monthly learning reports.
 *
 * A report is a deterministic template over `learning.stats`, the clustered
 * topics, the method signals, the day summaries, and the memory change log.
 * Numbers come from those tools; conclusions cite problem / summary ids and
 * never contain an ability or mental-health diagnosis.
 *
 * `week` and `month` generate and (by default) store one active report per
 * period. Re-generating the same evidence returns the existing row; changed
 * evidence inserts a new version and points the old row's `superseded_by` at
 * it. `save` stores a caller-provided Markdown report with the same versioning.
 */
import { createHash, randomUUID } from 'node:crypto';
import { resolveActiveGoal } from '../../../../packages/study-model/facts.mjs';
import { StudyError, isPlainObject } from '../../../../packages/study-contracts/index.mjs';
import { statsData } from '../learning/repo.mjs';
import { summariesData } from '../learning/summary.mjs';
import {
  buildEvidencePackage,
  methodSignals,
  periodRange,
  studyDateOf,
  weakTopics,
} from '../learning/analysis.mjs';
import { refreshTopics } from '../learning/topics.mjs';

/** Module id; matches the `review` service namespace. */
export const id = 'review';

/** Reports read learning data, so the evidence tables must be applied first. */
export const deps = ['learning'];

/** First layout of the report table. */
export const schemaVersion = 1;

/** The report table is the only storage this module owns. */
export const schema = [
  `CREATE TABLE IF NOT EXISTS study_learning_review (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    period TEXT NOT NULL,
    kind TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    report_md TEXT NOT NULL,
    actions_json TEXT,
    created_at TEXT NOT NULL,
    superseded_by TEXT
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_review_period ON study_learning_review (goal_id, kind, period)',
];

const REPORT_KINDS = Object.freeze(['week', 'month']);
const WRITE_METHODS = Object.freeze(['week', 'month', 'save']);
const REPORT_KEYS = new Set(['date', 'save']);
const LIST_KEYS = new Set(['kind', 'date', 'period', 'limit']);
const SAVE_KEYS = new Set(['kind', 'date', 'period', 'reportMd', 'evidence', 'actions']);
const MAX_LIST = 50;
const MAX_REPORT_CHARS = 20_000;
const ISO_WEEK = /^\d{4}-W\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/**
 * Register the `review` namespace.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {{ database: import('../db.mjs').StudyDatabase }} kernel - Kernel handle.
 */
export function apply(ctx, kernel) {
  ctx.effect(() => ctx.study.register('review', {
    methods: {
      week: (payload, api) => generate(payload, api, 'week'),
      month: (payload, api) => generate(payload, api, 'month'),
      list: (payload, api) => listReports(payload, api),
      save: (payload, api) => saveReport(payload, api),
    },
    writes: WRITE_METHODS,
  }), 'study: review namespace');
}

/**
 * Generate one report and optionally store it.
 * @param {object} payload - `{ date?, save? }`.
 * @param {object} api - Kernel call context.
 * @param {'week'|'month'} kind - Report kind.
 * @returns {object} Stored or unsaved report.
 */
function generate(payload, api, kind) {
  assertPayload(payload, REPORT_KEYS, kind);
  if (payload.save !== undefined && typeof payload.save !== 'boolean') {
    throw new StudyError('invalid', 'save 必须是布尔值', { field: 'save' });
  }
  const now = api.now();
  const date = studyDateOf(payload.date, now);
  return buildReport(api.db, {
    kind,
    date,
    now,
    save: payload.save !== false,
    change: api.change,
  });
}

/**
 * Build one report; store it unless `save` is false. The topic clustering is a
 * write, so this function only runs inside a write method.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ kind: 'week'|'month', date: string, now: Date, save: boolean, change?: Function }} options
 *   Report scope and storage flag.
 * @returns {object} Report view.
 */
export function buildReport(db, { kind, date, now, save, change }) {
  const goalId = resolveActiveGoal(db) ?? 'unassigned';
  const range = periodRange(date, kind);
  refreshTopics(db, { goalId, now, change });
  const stats = statsData(db, { from: range.startIso, to: range.endIsoInclusive });
  const weak = weakTopics(db, { goalId, now, limit: 5 });
  const signals = methodSignals(db, { goalId, now });
  const summaries = summariesData(db, { from: range.startIso, to: range.endIsoInclusive, limit: 7 });
  const profileChanges = Number(db.get(
    "SELECT COUNT(*) AS count FROM change_log WHERE entity = 'memory' AND at >= ? AND at < ?",
    range.startIso,
    range.endIso,
  ).count);
  const weeklyReports = kind === 'month' ? weeklyReportsIn(db, { goalId, range }) : [];
  const report = renderReport({
    kind,
    range,
    stats,
    weak,
    signals,
    summaries,
    profileChanges,
    weeklyReports,
  });
  const inputHash = hashInput({
    kind,
    period: range.period,
    stats,
    weak: weak.items.map(item => ({
      topicId: item.topicId,
      score: item.score,
      n: item.n,
      reaskCount: item.reaskCount,
      state: item.state,
      evidence: item.evidence.map(entry => entry.refId),
    })),
    signals: signals.signals.map(signal => ({
      kind: signal.kind,
      evidence: signal.evidence.map(entry => entry.refId),
      detail: signal.detail,
    })),
    summaries: summaries.items.map(item => item.summaryId),
    profileChanges,
    weeklyReports: weeklyReports.map(item => item.id),
  });
  const evidence = {
    kind,
    period: range.period,
    from: range.from,
    to: range.to,
    generatedAt: now.toISOString(),
    goalId,
    inputHash,
    bullets: report.bullets,
    citations: report.citations,
    stats: {
      episodes: stats.episodes,
      problems: stats.problems,
      resolved: stats.resolved,
      unresolved: stats.unresolved,
      reaskRate: stats.problems === 0 ? 0 : round4(stats.reaskedProblems / stats.problems),
    },
    weakTopics: weak,
    signals: signals.signals,
    summaries: summaries.items.map(item => ({
      day: item.day,
      summaryId: item.summaryId,
      text: item.text,
    })),
    profileChanges,
    weeklyReports: weeklyReports.map(item => ({
      period: item.period,
      id: item.id,
      bullets: item.bullets,
    })),
    evidencePackage: buildEvidencePackage(db, { goalId, now, date, kind }),
  };

  if (!save) {
    return {
      id: null,
      kind,
      period: range.period,
      from: range.from,
      to: range.to,
      reportMd: report.reportMd,
      bullets: report.bullets,
      actions: report.actions,
      evidence,
      createdAt: now.toISOString(),
      supersededBy: null,
      reused: false,
      saved: false,
    };
  }

  const active = activeReport(db, { goalId, kind, period: range.period });
  if (active !== undefined && sameInput(active, inputHash)) {
    return mapRow(active, { reused: true });
  }
  const id = `rev_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const createdAt = now.toISOString();
  db.run(
    `INSERT INTO study_learning_review
      (id, goal_id, period, kind, evidence_json, report_md, actions_json, created_at, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id,
    goalId,
    range.period,
    kind,
    JSON.stringify(evidence),
    report.reportMd,
    JSON.stringify(report.actions),
    createdAt,
  );
  if (active !== undefined) {
    db.run('UPDATE study_learning_review SET superseded_by = ? WHERE id = ?', id, String(active.id));
  }
  change?.({
    entity: 'review',
    entityId: id,
    action: 'create',
    before: active === undefined ? null : { id: String(active.id), period: String(active.period) },
    after: { kind, period: range.period, bullets: report.bullets.length },
  });
  return {
    id,
    kind,
    period: range.period,
    from: range.from,
    to: range.to,
    reportMd: report.reportMd,
    bullets: report.bullets,
    actions: report.actions,
    evidence,
    createdAt,
    supersededBy: null,
    reused: false,
    saved: true,
  };
}

/**
 * Read active reports, optionally filtered to one period.
 * @param {object} payload - `{ kind?, date?, period?, limit? }`.
 * @param {object} api - Kernel call context.
 * @returns {{ kind: string, period: string|null, items: object[] }} Reports newest first.
 */
function listReports(payload, api) {
  assertPayload(payload, LIST_KEYS, 'list');
  const kind = normalizeKind(payload.kind);
  const now = api.now();
  const date = payload.date === undefined ? null : studyDateOf(payload.date, now);
  const derived = date === null ? null : periodRange(date, kind).period;
  if (payload.period !== undefined && (typeof payload.period !== 'string' || !validPeriod(payload.period, kind))) {
    throw new StudyError('invalid', `period 必须是 ${kind === 'week' ? 'YYYY-Www' : 'YYYY-MM'}`, { field: 'period' });
  }
  if (payload.period !== undefined && derived !== null && payload.period !== derived) {
    throw new StudyError('invalid', 'date 与 period 指向不同的周期', { field: 'period' });
  }
  const period = payload.period ?? derived;
  const limit = payload.limit === undefined ? 10 : requireInteger(payload.limit, 'limit', 1, MAX_LIST);
  const goalId = resolveActiveGoal(api.db) ?? 'unassigned';
  const params = [goalId, kind];
  let filter = "goal_id = ? AND kind = ? AND superseded_by IS NULL";
  if (period !== null) {
    filter += ' AND period = ?';
    params.push(period);
  }
  const rows = api.db.all(
    `SELECT * FROM study_learning_review WHERE ${filter}
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ...params,
    limit,
  );
  return { kind, period, items: rows.map(row => mapRow(row, { reused: false })) };
}

/**
 * Store a caller-provided report, or generate one when `reportMd` is absent.
 * @param {object} payload - `{ kind, date?, period?, reportMd?, evidence?, actions? }`.
 * @param {object} api - Kernel call context.
 * @returns {object} Stored report.
 */
function saveReport(payload, api) {
  assertPayload(payload, SAVE_KEYS, 'save');
  const kind = normalizeKind(payload.kind);
  const now = api.now();
  const date = payload.date === undefined
    ? (payload.period === undefined ? studyDateOf(undefined, now) : dateOfPeriod(payload.period, kind))
    : studyDateOf(payload.date, now);
  if (payload.period !== undefined) {
    if (typeof payload.period !== 'string' || !validPeriod(payload.period, kind)) {
      throw new StudyError('invalid', `period 必须是 ${kind === 'week' ? 'YYYY-Www' : 'YYYY-MM'}`, { field: 'period' });
    }
    const derived = periodRange(date, kind).period;
    if (derived !== payload.period) {
      throw new StudyError('invalid', 'date 与 period 指向不同的周期', { field: 'period' });
    }
  }
  if (payload.reportMd === undefined) {
    return buildReport(api.db, { kind, date, now, save: true, change: api.change });
  }
  if (typeof payload.reportMd !== 'string' || payload.reportMd.trim() === '') {
    throw new StudyError('invalid', 'reportMd 必须是非空字符串', { field: 'reportMd' });
  }
  if (payload.reportMd.length > MAX_REPORT_CHARS) {
    throw new StudyError('invalid', `reportMd 不能超过 ${MAX_REPORT_CHARS} 字`, { field: 'reportMd', length: payload.reportMd.length });
  }
  if (payload.evidence !== undefined && !isPlainObject(payload.evidence)) {
    throw new StudyError('invalid', 'evidence 必须是对象', { field: 'evidence' });
  }
  const actions = normalizeActions(payload.actions);
  const range = periodRange(date, kind);
  const goalId = resolveActiveGoal(api.db) ?? 'unassigned';
  const evidence = {
    ...(payload.evidence ?? {}),
    kind,
    period: range.period,
    from: range.from,
    to: range.to,
    generatedAt: now.toISOString(),
    goalId,
    inputHash: hashInput({ kind, period: range.period, reportMd: payload.reportMd, actions }),
    bullets: extractBullets(payload.reportMd),
  };
  const active = activeReport(api.db, { goalId, kind, period: range.period });
  if (active !== undefined && sameInput(active, evidence.inputHash)) {
    return mapRow(active, { reused: true });
  }
  const id = `rev_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const createdAt = now.toISOString();
  api.db.run(
    `INSERT INTO study_learning_review
      (id, goal_id, period, kind, evidence_json, report_md, actions_json, created_at, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    id,
    goalId,
    range.period,
    kind,
    JSON.stringify(evidence),
    payload.reportMd,
    JSON.stringify(actions),
    createdAt,
  );
  if (active !== undefined) {
    api.db.run('UPDATE study_learning_review SET superseded_by = ? WHERE id = ?', id, String(active.id));
  }
  api.change({
    entity: 'review',
    entityId: id,
    action: 'save',
    before: active === undefined ? null : { id: String(active.id), period: String(active.period) },
    after: { kind, period: range.period },
  });
  return {
    id,
    kind,
    period: range.period,
    from: range.from,
    to: range.to,
    reportMd: payload.reportMd,
    bullets: evidence.bullets,
    actions,
    evidence,
    createdAt,
    supersededBy: null,
    reused: false,
    saved: true,
  };
}

/**
 * Render the four-section Markdown report and the three card bullets.
 * @param {object} input - Aggregated evidence.
 * @returns {{ reportMd: string, bullets: string[], actions: object[], citations: object[] }} Report pieces.
 */
export function renderReport({ kind, range, stats, weak, signals, summaries, profileChanges, weeklyReports }) {
  const label = kind === 'week' ? '本周' : '本月';
  const topWeak = weak.items[0] ?? null;
  const topSignal = signals.signals[0] ?? null;
  const citations = [];
  const bullets = [
    `${label} ${stats.episodes} 次问答、${stats.problems} 道题，闭环 ${stats.resolved} 次，未闭环 ${stats.unresolved} 次。`,
    topWeak === null
      ? `主题证据还不足（每个主题至少 3 道题才排序）。`
      : `重问集中在「${topWeak.name}」：${topWeak.n} 道题，重问 ${topWeak.reaskCount} 道。`,
    topSignal === null
      ? `${summaries.total} 天留有日摘要记录。`
      : `${topSignal.title}：${topSignal.detail}`,
  ];

  const seen = [];
  seen.push(`- ${bullets[0]}`);
  if (summaries.items.length > 0) {
    const latest = summaries.items[0];
    seen.push(`- 最近一份日摘要（${latest.day}，${latest.summaryId}）：${truncate(latest.text, 120)}`);
    citations.push({ kind: 'summary', refId: latest.summaryId, at: latest.createdAt });
  }
  if (topWeak !== null) {
    const examples = topWeak.evidence.slice(0, 3)
      .map(entry => `${entry.refId}（${entry.at.slice(0, 10)}）`)
      .join('、');
    seen.push(`- 「${topWeak.name}」共 ${topWeak.n} 道题，重问 ${topWeak.reaskCount} 道、未闭环 ${topWeak.unresolvedCount} 道；`
      + `最近例子：${examples}。薄弱度 ${topWeak.score}，状态：${topWeak.stateLabel}。`);
    citations.push(...topWeak.evidence.slice(0, 3));
  } else if (weak.status === 'insufficient') {
    seen.push(`- ${weak.reason}`);
  }
  if (topSignal !== null) {
    const refs = topSignal.evidence.map(entry => `${entry.refId}（${entry.at.slice(0, 10)}）`).join('、');
    seen.push(`- 方法信号「${topSignal.title}」：${topSignal.detail} 依据：${refs}。`);
    citations.push(...topSignal.evidence);
  }
  if (stats.episodes === 0) {
    seen.length = 1;
    seen.push('- 这个周期没有问答记录，下面的判断不成立。');
  }

  const confidence = topWeak === null ? '低'
    : (topWeak.n >= 5 && topWeak.score >= 0.7 ? '高' : '中');
  const explanation = topWeak === null
    ? '- 证据还不够，不能据此判断薄弱点；这可能只是这个周期练习量少，或题目还没有形成主题。'
    : `- 你可能停在“看懂步骤”，还没有独立做一遍；置信度：${confidence}。`
      + '另一种解释是这个周期练习量少，或题目本身偏难。';

  const actions = [];
  if (topWeak !== null) {
    actions.push({
      text: `挑 1 道「${topWeak.name}」的旧题，合上答案独立做 10 分钟；卡住就记录卡在第几步。`,
      verify: '能独立做完并说出关键步骤，算这次有效。',
    });
  }
  if (topSignal?.kind === 'same_topic_reask') {
    actions.push({
      text: '把最近 3 道重问题分散到 3 天，每天先独立做 1 道，再看答案。',
      verify: '3 天后仍不需要重问，算有效。',
    });
  } else if (topSignal?.kind === 'backlog') {
    actions.push({
      text: '先清理最早的一道未闭环题：重做一遍，然后标记“闭环”或“仍未闭环”。',
      verify: '未闭环数量比本周少 1 道，算有效。',
    });
  } else if (topSignal?.kind === 'burst') {
    actions.push({
      text: '把下一次同类练习拆成 3 天，每天 20 分钟，而不是一次做完。',
      verify: '连续 3 天都有记录，算有效。',
    });
  }
  if (actions.length === 0) {
    actions.push({
      text: '这个周期每次看完例题，合上答案独立做 1 道同类题，记录是否卡住。',
      verify: '能独立完成且 7 天内不重问，算有效。',
    });
  }
  if (actions.length < 3 && topWeak !== null) {
    actions.push({
      text: `一周后用 1 道新的「${topWeak.name}」题自测，先不看答案。`,
      verify: '能独立完成，说明薄弱点在下降。',
    });
  }
  const actionText = actions.slice(0, 3)
    .map((action, index) => `${index + 1}. ${action.text}（怎么判断：${action.verify}）`)
    .join('\n');

  const profileLine = profileChanges > 0
    ? `\n\n${label}对你的了解更新了 ${profileChanges} 处（在记忆页的“画像”里可查看）。`
    : '';
  const reportMd = [
    '## 我看到的',
    seen.join('\n'),
    '## 我的解释',
    explanation,
    '## 建议你试的',
    actionText,
    '## 需要你确认的',
    topWeak === null
      ? '- 这个周期你觉得最卡的是哪一类题？告诉我，我下次从那里开始分析。'
      : `- 「${topWeak.name}」更像是没练够，还是这类题本身太难？这个判断符合你的感受吗？`,
  ].join('\n') + profileLine;

  return {
    reportMd,
    bullets: bullets.map(bullet => truncate(bullet, 120)),
    actions,
    citations,
  };
}

/** Month report's weekly inputs, newest first. */
function weeklyReportsIn(db, { goalId, range }) {
  const rows = db.all(
    `SELECT * FROM study_learning_review
      WHERE goal_id = ? AND kind = 'week' AND superseded_by IS NULL
        AND evidence_json LIKE ?
      ORDER BY period ASC`,
    goalId,
    `%${range.period}%`,
  );
  return rows.map(row => mapRow(row, { reused: false })).filter(row => {
    const from = row.evidence?.from;
    const to = row.evidence?.to;
    return typeof from === 'string' && typeof to === 'string' && to >= range.from && from <= range.to;
  });
}

function activeReport(db, { goalId, kind, period }) {
  return db.get(
    `SELECT * FROM study_learning_review
      WHERE goal_id = ? AND kind = ? AND period = ? AND superseded_by IS NULL
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    goalId,
    kind,
    period,
  );
}

function sameInput(row, inputHash) {
  try {
    const evidence = JSON.parse(String(row.evidence_json));
    return evidence?.inputHash === inputHash;
  } catch {
    return false;
  }
}

function mapRow(row, { reused }) {
  const evidence = parseJson(row.evidence_json);
  return {
    id: String(row.id),
    kind: String(row.kind),
    period: String(row.period),
    from: evidence?.from ?? null,
    to: evidence?.to ?? null,
    reportMd: String(row.report_md),
    bullets: Array.isArray(evidence?.bullets) ? evidence.bullets : extractBullets(String(row.report_md)),
    actions: parseJson(row.actions_json) ?? [],
    evidence,
    createdAt: String(row.created_at),
    supersededBy: row.superseded_by === null ? null : String(row.superseded_by),
    reused,
    saved: true,
  };
}

function hashInput(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function extractBullets(reportMd) {
  const lines = String(reportMd).split('\n');
  const start = lines.findIndex(line => line.trim() === '## 我看到的');
  if (start < 0) return [];
  const bullets = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) bullets.push(line.slice(2).trim());
  }
  return bullets.slice(0, 3);
}

function normalizeKind(value) {
  const kind = value === undefined ? 'week' : value;
  if (!REPORT_KINDS.includes(kind)) {
    throw new StudyError('invalid', 'kind 必须是 week 或 month', { field: 'kind' });
  }
  return kind;
}

function validPeriod(value, kind) {
  return kind === 'week' ? ISO_WEEK.test(value) : MONTH.test(value);
}

function dateOfPeriod(period, kind) {
  if (kind === 'month') {
    if (!MONTH.test(String(period))) throw new StudyError('invalid', 'period 必须是 YYYY-MM', { field: 'period' });
    return `${period}-01`;
  }
  if (!ISO_WEEK.test(String(period))) throw new StudyError('invalid', 'period 必须是 YYYY-Www', { field: 'period' });
  const [year, week] = String(period).split('-W').map(Number);
  if (week < 1 || week > 53) throw new StudyError('invalid', 'ISO 周必须在 01-53', { field: 'period' });
  const january4 = new Date(Date.UTC(year, 0, 4));
  const weekday = january4.getUTCDay() || 7;
  const monday = new Date(january4.getTime() - (weekday - 1) * 86_400_000 + (week - 1) * 7 * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

function normalizeActions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) {
    throw new StudyError('invalid', 'actions 必须是最多 3 条的数组', { field: 'actions' });
  }
  return value.map((entry, index) => {
    if (typeof entry === 'string') return { text: entry, verify: '' };
    if (!isPlainObject(entry) || typeof entry.text !== 'string' || entry.text.trim() === '') {
      throw new StudyError('invalid', `actions[${index}] 需要非空 text`, { field: 'actions' });
    }
    return {
      text: entry.text,
      verify: typeof entry.verify === 'string' ? entry.verify : '',
    };
  });
}

function assertPayload(payload, allowed, method) {
  if (!isPlainObject(payload)) throw new StudyError('invalid', `${method} 的载荷必须是对象`);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new StudyError('invalid', `${method} 不接受字段 ${key}`, { field: key });
  }
}

function requireInteger(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new StudyError('invalid', `${field} 必须是 ${min}-${max} 的整数`, { field });
  }
  return value;
}

function parseJson(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
