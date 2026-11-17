/**
 * Rule summaries of one 04:00 study-day window, and the rolling subject
 * threads they feed.
 *
 * No model is called: the summary is a deterministic aggregate of the window's
 * Q&A units (opened inside `[start, end)`, not merged) plus a Chinese template.
 * The structured data is what later increments may reuse; `text` is only the
 * rendered line.
 *
 * Rebuilding is hash-safe: when the same evidence produces the same
 * `input_hash`, the existing summary row is reused. A real change inserts a new
 * row and points the previous current row's `superseded_by` at it, so history is
 * never overwritten.
 */
import { createHash, randomUUID } from 'node:crypto';
import { StudyError } from '../../../../packages/study-contracts/index.mjs';
import { isBeforeBackfill, studyDay } from './window.mjs';

/** Day-level summaries only in this increment. */
const SUMMARY_LEVEL = 'day';

/** Template version stored beside each rule summary. */
const PROMPT_VERSION = 'rule-v1';

/** Rolling subject thread horizon. */
const THREAD_DAYS = 30;

/** Structured evidence limits, so one messy day cannot bloat the row. */
const MAX_OPEN_PROBLEMS = 5;
const MAX_CONFUSIONS = 5;
const TEXT_PROBLEM_CHARS = 80;
const TEMPLATE_PROBLEM_CHARS = 40;
const TEMPLATE_OPEN_PROBLEMS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const UNCLASSIFIED = '未分类';

/**
 * Summarize one sealed window. An empty window is marked summarized with no
 * summary row; a too-old window is marked failed instead of rebuilt.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{
 *   id: string,
 *   now: Date,
 *   change?: (entry: object) => void,
 * }} entry - Window id, clock, and the kernel change recorder.
 * @returns {object} Summary result; `status` mirrors the resulting window state.
 */
export function summarizeWindowRow(db, { id, now, change }) {
  const row = db.get('SELECT * FROM study_window WHERE id = ?', id);
  if (row === undefined) throw new StudyError('not_found', `没有 id 为 ${id} 的学习窗口`, { id });
  if (String(row.kind) !== 'day') throw new StudyError('invalid', 'S2 只支持日窗口摘要', { kind: String(row.kind), id });
  const status = String(row.status);
  if (status === 'open') {
    throw new StudyError('conflict', '窗口尚未封口，不能生成摘要', { id, status });
  }
  if (status === 'failed') return failedResult(row);
  const existingSummaryId = row.summary_id === null || row.summary_id === undefined ? null : String(row.summary_id);
  if (isBeforeBackfill(String(row.start_at), now) && existingSummaryId === null && !hasSummary(db, id)) {
    return markFailed(db, row, now, change);
  }

  const bounds = { startAt: String(row.start_at), endAt: String(row.end_at) };
  const episodes = windowEpisodes(db, String(row.goal_id), bounds);
  if (episodes.length === 0) {
    db.run(
      "UPDATE study_window SET status = 'summarized', summary_id = NULL, cursor_json = ? WHERE id = ?",
      JSON.stringify({ ...parseCursor(row.cursor_json), empty: true, summarizedAt: now.toISOString() }),
      id,
    );
    change?.({ entity: 'window', entityId: id, action: 'summarize_empty', before: { status }, after: { status: 'summarized' } });
    return {
      status: 'summarized',
      windowId: id,
      summaryId: null,
      text: null,
      data: null,
      evidence: [],
      inputHash: null,
      reused: false,
      empty: true,
    };
  }

  const hash = inputHashOf(episodes);
  const prior = db.get(
    'SELECT * FROM study_window_summary WHERE window_id = ? AND input_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    id,
    hash,
  );
  if (prior !== undefined) {
    db.run("UPDATE study_window SET status = 'summarized', summary_id = ? WHERE id = ?", prior.id, id);
    updateTopicThreads(db, now);
    change?.({ entity: 'window', entityId: id, action: 'summarize_reuse', before: { status }, after: { status: 'summarized', summaryId: String(prior.id) } });
    return {
      status: 'summarized',
      windowId: id,
      summaryId: String(prior.id),
      text: String(prior.text),
      data: parseJson(prior.data_json),
      evidence: parseJson(prior.evidence_json) ?? [],
      inputHash: String(prior.input_hash),
      reused: true,
      empty: false,
    };
  }

  const data = aggregateWindow(db, episodes);
  const summaryId = `sum_${randomUUID()}`;
  const evidence = episodes.map(episode => String(episode.id));
  const text = summaryText(data, { day: studyDay(new Date(String(row.start_at))), now });
  db.run(
    `INSERT INTO study_window_summary
      (id, window_id, level, text, data_json, evidence_json, input_hash, model, prompt_version, superseded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
    summaryId,
    id,
    SUMMARY_LEVEL,
    text,
    JSON.stringify(data),
    JSON.stringify(evidence),
    hash,
    PROMPT_VERSION,
    now.toISOString(),
  );
  db.run(
    'UPDATE study_window_summary SET superseded_by = ? WHERE window_id = ? AND superseded_by IS NULL AND id <> ?',
    summaryId,
    id,
    summaryId,
  );
  db.run("UPDATE study_window SET status = 'summarized', summary_id = ? WHERE id = ?", summaryId, id);
  updateTopicThreads(db, now);
  change?.({
    entity: 'window_summary',
    entityId: summaryId,
    action: 'create',
    before: null,
    after: { windowId: id, level: SUMMARY_LEVEL, inputHash: hash, text },
  });
  return {
    status: 'summarized',
    windowId: id,
    summaryId,
    text,
    data,
    evidence,
    inputHash: hash,
    reused: false,
    empty: false,
  };
}

/**
 * Day summaries in one range plus the current subject threads.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ from?: string, to?: string, limit: number }} filters - ISO bounds (inclusive) and page size.
 * @returns {{ items: object[], threads: object[], total: number }} Summaries newest first.
 */
export function summariesData(db, { from, to, limit }) {
  const clauses = ["s.superseded_by IS NULL", "w.kind = 'day'"];
  const params = [];
  if (from !== undefined) {
    clauses.push('w.start_at >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    clauses.push('w.start_at <= ?');
    params.push(to);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db.all(
    `SELECT s.*, w.goal_id, w.start_at, w.end_at
       FROM study_window_summary s JOIN study_window w ON w.id = s.window_id
       ${where}
      ORDER BY w.start_at DESC LIMIT ?`,
    ...params,
    limit,
  );
  const total = Number(db.get(
    `SELECT COUNT(*) AS total FROM study_window_summary s JOIN study_window w ON w.id = s.window_id ${where}`,
    ...params,
  ).total);
  const threads = db.all(
    `SELECT t.* FROM study_topic_thread t
       JOIN (SELECT topic_id, MAX(version) AS version FROM study_topic_thread GROUP BY topic_id) latest
         ON latest.topic_id = t.topic_id AND latest.version = t.version
      ORDER BY t.topic_id ASC`,
  );
  return {
    items: rows.map(row => ({
      windowId: String(row.window_id),
      goalId: String(row.goal_id),
      level: String(row.level),
      day: studyDay(new Date(String(row.start_at))),
      startAt: String(row.start_at),
      endAt: String(row.end_at),
      summaryId: String(row.id),
      text: String(row.text),
      data: parseJson(row.data_json),
      evidence: parseJson(row.evidence_json) ?? [],
      inputHash: String(row.input_hash),
      createdAt: String(row.created_at),
    })),
    threads: threads.map(row => ({
      topicId: String(row.topic_id),
      subject: threadSubject(String(row.topic_id)),
      version: Number(row.version),
      text: String(row.text),
      data: parseJson(row.data_json),
      updatedAt: String(row.updated_at),
    })),
    total,
  };
}

/**
 * Aggregate one window's units into the structured summary.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {Array<Record<string, unknown>>} episodes - Units opened inside the window.
 * @returns {{ counts: object, subjects: object[], openProblems: object[], confusions: object[] }} Summary data.
 */
export function aggregateWindow(db, episodes) {
  const problems = problemsOfEpisodes(db, episodes.map(episode => String(episode.id)));
  const problemsByEpisode = new Map();
  for (const problem of problems) {
    const key = String(problem.episode_id);
    const list = problemsByEpisode.get(key) ?? [];
    list.push(problem);
    problemsByEpisode.set(key, list);
  }
  const unresolved = episodes.filter(episode => episode.resolution === 'unresolved');
  const openProblems = [];
  const confusions = [];
  for (const episode of unresolved) {
    const episodeId = String(episode.id);
    const subject = episode.subject === null || episode.subject === undefined ? UNCLASSIFIED : String(episode.subject);
    const list = problemsByEpisode.get(episodeId) ?? [];
    if (openProblems.length < MAX_OPEN_PROBLEMS) {
      for (const problem of list) {
        if (openProblems.length >= MAX_OPEN_PROBLEMS) break;
        if (problem.text === null || problem.text === undefined) continue;
        openProblems.push({ problemId: String(problem.id), text: truncateText(String(problem.text), TEXT_PROBLEM_CHARS), episodeId });
      }
    }
    if (confusions.length < MAX_CONFUSIONS) {
      confusions.push({ episodeId, subject, text: confusionText(db, episodeId, list) });
    }
  }

  const subjects = new Map();
  for (const episode of episodes) {
    const subject = episode.subject === null || episode.subject === undefined ? UNCLASSIFIED : String(episode.subject);
    const entry = subjects.get(subject) ?? { subject, episodes: 0, problems: 0 };
    entry.episodes += 1;
    entry.problems += (problemsByEpisode.get(String(episode.id)) ?? []).length;
    subjects.set(subject, entry);
  }
  return {
    counts: {
      episodes: episodes.length,
      problems: problems.length,
      resolved: episodes.filter(episode => episode.resolution === 'understood').length,
      unresolved: unresolved.length,
      reasks: problems.filter(problem => problem.reasked_from !== null && problem.reasked_from !== undefined).length,
    },
    subjects: [...subjects.values()].sort((left, right) => right.episodes - left.episodes
      || (left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0)),
    openProblems,
    confusions,
  };
}

/**
 * Render the Chinese template for one day's data.
 * @param {object} data - Result of {@link aggregateWindow}.
 * @param {{ day: string, now: Date }} context - Window day and current instant.
 * @returns {string} One paragraph.
 */
export function summaryText(data, { day, now }) {
  const { counts, subjects, openProblems } = data;
  const label = studyDay(now) === day ? '今天' : `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日`;
  const head = `${label} ${counts.episodes} 次问答、${counts.problems} 道题，`
    + `${counts.resolved} 次闭环、${counts.unresolved} 次未闭环；重问 ${counts.reasks} 次。`;
  const subjectText = subjects.length === 0
    ? ''
    : `${subjects.map(item => `${item.subject} ${item.episodes} 次（${item.problems} 道题）`).join('、')}。`;
  const openText = openProblems.length === 0
    ? ''
    : `未闭环：《${openProblems.slice(0, TEMPLATE_OPEN_PROBLEMS).map(problem => truncateText(problem.text, TEMPLATE_PROBLEM_CHARS)).join('》《')}》。`;
  return `${head}${subjectText}${openText}`;
}

/**
 * Evidence hash: the sorted unit ids with their `updated_at`, so any edit to a
 * unit forces a new summary while a repeated tick reuses the same row.
 * @param {Array<Record<string, unknown>>} episodes - Window units.
 * @returns {string} SHA-256 hex digest.
 */
export function inputHashOf(episodes) {
  const evidence = episodes
    .map(episode => `${String(episode.id)}:${String(episode.updated_at)}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(evidence).digest('hex');
}

/**
 * Refresh the rolling subject threads from the last 30 days. Each refresh
 * appends a new versioned row, so earlier text stays auditable.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {Date} now - Current instant.
 * @returns {number} Number of threads written.
 */
export function updateTopicThreads(db, now) {
  const since = new Date(now.getTime() - THREAD_DAYS * DAY_MS).toISOString();
  const rows = db.all(
    `SELECT COALESCE(e.subject, ?) AS subject,
            COUNT(DISTINCT e.id) AS episodes,
            COUNT(p.id) AS problems,
            COALESCE(SUM(CASE WHEN p.reasked_from IS NOT NULL THEN 1 ELSE 0 END), 0) AS reasks,
            MAX(e.opened_at) AS last_at
       FROM study_episode e LEFT JOIN study_episode_problem p ON p.episode_id = e.id
      WHERE e.status <> 'merged' AND e.opened_at >= ?
      GROUP BY COALESCE(e.subject, ?)
      ORDER BY episodes DESC, subject ASC`,
    UNCLASSIFIED,
    since,
    UNCLASSIFIED,
  );
  for (const row of rows) {
    const subject = String(row.subject);
    const topicId = `subject:${subject}`;
    const data = {
      subject,
      episodes: Number(row.episodes),
      problems: Number(row.problems),
      reasks: Number(row.reasks),
      lastAt: row.last_at === null || row.last_at === undefined ? null : String(row.last_at),
      since,
    };
    const latest = db.get('SELECT MAX(version) AS version FROM study_topic_thread WHERE topic_id = ?', topicId);
    const version = Number(latest?.version ?? 0) + 1;
    const text = threadText(data);
    db.run(
      `INSERT INTO study_topic_thread (id, topic_id, version, text, data_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      `thread_${randomUUID()}`,
      topicId,
      version,
      text,
      JSON.stringify(data),
      now.toISOString(),
    );
  }
  return rows.length;
}

/**
 * Units opened inside the window and still standing.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {string} goalId - Owning goal.
 * @param {{ startAt: string, endAt: string }} bounds - Half-open ISO range.
 * @returns {Array<Record<string, unknown>>} Unit rows oldest first.
 */
export function windowEpisodes(db, goalId, bounds) {
  return db.all(
    `SELECT * FROM study_episode
      WHERE goal_id = ? AND opened_at >= ? AND opened_at < ? AND status <> 'merged'
      ORDER BY opened_at ASC, rowid ASC`,
    goalId,
    bounds.startAt,
    bounds.endAt,
  );
}

/* ---------------------------------------------------------------- internals */

function problemsOfEpisodes(db, episodeIds) {
  if (episodeIds.length === 0) return [];
  const placeholders = episodeIds.map(() => '?').join(', ');
  return db.all(
    `SELECT * FROM study_episode_problem WHERE episode_id IN (${placeholders})
      ORDER BY created_at ASC, rowid ASC`,
    ...episodeIds,
  );
}

/**
 * One confused unit's line: the last turn that still has text, else its first
 * problem. A 90-day cleanup may have removed the texts, so both are optional.
 */
function confusionText(db, episodeId, problems) {
  const turn = db.get(
    `SELECT t.text, t.at FROM study_episode_turn et JOIN study_turn t ON t.id = et.turn_id
      WHERE et.episode_id = ? AND t.text IS NOT NULL
      ORDER BY et.position DESC LIMIT 1`,
    episodeId,
  );
  if (turn !== undefined && turn.text !== null && turn.text !== undefined) {
    return truncateText(String(turn.text), TEXT_PROBLEM_CHARS);
  }
  const first = problems.find(problem => problem.text !== null && problem.text !== undefined);
  return first === undefined ? '' : truncateText(String(first.text), TEXT_PROBLEM_CHARS);
}

function threadText(data) {
  const last = data.lastAt === null
    ? ''
    : `，最近 ${Number(data.lastAt.slice(5, 7))} 月 ${Number(data.lastAt.slice(8, 10))} 日`;
  const reask = data.reasks === 0 ? '' : `，重问 ${data.reasks} 次`;
  return `${data.subject}：近 30 天 ${data.episodes} 次问答、${data.problems} 道题${reask}${last}。`;
}

function threadSubject(topicId) {
  return topicId.startsWith('subject:') ? topicId.slice('subject:'.length) : topicId;
}

function markFailed(db, row, now, change) {
  const at = now.toISOString();
  db.run(
    `UPDATE study_window SET status = 'failed', attempts = attempts + 1, closed_at = COALESCE(closed_at, ?),
       cursor_json = ? WHERE id = ?`,
    at,
    JSON.stringify({ ...parseCursor(row.cursor_json), failure: 'backfill_limit', failedAt: at }),
    String(row.id),
  );
  change?.({
    entity: 'window',
    entityId: String(row.id),
    action: 'summarize_failed',
    before: { status: String(row.status) },
    after: { status: 'failed', reason: 'backfill_limit' },
  });
  return {
    status: 'failed',
    windowId: String(row.id),
    summaryId: null,
    text: null,
    data: null,
    evidence: [],
    inputHash: null,
    reused: false,
    empty: false,
    reason: 'backfill_limit',
  };
}

function failedResult(row) {
  return {
    status: 'failed',
    windowId: String(row.id),
    summaryId: null,
    text: null,
    data: null,
    evidence: [],
    inputHash: null,
    reused: false,
    empty: false,
    reason: 'backfill_limit',
  };
}

function hasSummary(db, windowId) {
  return db.get('SELECT id FROM study_window_summary WHERE window_id = ? LIMIT 1', windowId) !== undefined;
}

function parseCursor(raw) {
  if (raw === null || raw === undefined) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJson(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function truncateText(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
