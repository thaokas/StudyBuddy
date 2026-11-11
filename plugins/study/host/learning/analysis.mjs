/**
 * Deterministic learning analysis: weak topics, method signals, and the
 * evidence package a weekly report is built from.
 *
 * The formulas and thresholds are constants so tests and the delivery record
 * can pin them. No model is called and no conclusion is inferred from a single
 * answer: a topic needs at least three problems before it is ranked, and every
 * signal carries both supporting evidence and a counter-explanation.
 */
import { StudyError } from '../registry.mjs';
import { statsData } from './repo.mjs';
import { summariesData } from './summary.mjs';
import { studyDay } from './window.mjs';
import { evaluateAllTraits } from '../memory/traits.mjs';
import { subjectOfAliases } from './topics.mjs';

/** Minimum problems per topic before any ranking happens. */
export const MIN_TOPIC_SAMPLE = 3;

/** Weakness at or above this value is reported as "薄弱" when a failure exists. */
export const WEAK_SCORE = 0.5;

/** A topic that was once closed and re-asked within this window is "遗忘". */
export const FORGOTTEN_REASK_DAYS = 30;

/** Recency is capped at three weeks. */
export const RECENCY_DAYS = 21;

/** No self-rated difficulty source exists in this increment; the formula's fallback. */
export const SELF_DIFFICULTY_DEFAULT = 0.5;

/** Same-topic re-asks inside this window trigger the "同类反复" signal. */
export const REASK_SIGNAL_DAYS = 7;
export const REASK_SIGNAL_COUNT = 3;

/** Night-study window (local time) and the minimum gap over daytime. */
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 2;
export const NIGHT_MIN_PROBLEMS = 3;
export const NIGHT_RATE_GAP = 0.2;
export const SIGNAL_LOOKBACK_DAYS = 30;

/** A burst day has at least this many units and is followed by three quiet days. */
export const BURST_UNITS = 5;
export const BURST_QUIET_DAYS = 3;

/** A backlog needs this many unresolved problems, older than this many days. */
export const BACKLOG_COUNT = 5;
export const BACKLOG_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rank the topics of one goal by the deterministic weakness score.
 *
 * `n < 3` topics are excluded and counted as `skipped`; if no topic reaches the
 * sample gate the whole result is `insufficient` rather than a ranking.
 *
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, now: Date, limit?: number }} options - Scope and clock.
 * @returns {{
 *   status: 'ok' | 'insufficient',
 *   items: object[],
 *   considered: number,
 *   skipped: number,
 *   reason: string | null,
 * }} Ranking and gate details.
 */
export function weakTopics(db, { goalId, now, limit = 5 }) {
  const cap = Math.max(1, Math.min(Number(limit) || 5, 10));
  const topics = db.all(
    `SELECT id, name, aliases_json FROM study_topic WHERE goal_id = ? ORDER BY created_at ASC, id ASC`,
    goalId,
  );
  const items = [];
  let skipped = 0;
  for (const topic of topics) {
    const rows = db.all(
      `SELECT p.id, p.created_at, p.reasked_from, p.reask_count, p.status,
              e.id AS episode_id, e.resolution, e.closed_at, e.opened_at, e.updated_at
         FROM study_episode_topic et
         JOIN study_episode_problem p ON p.episode_id = et.episode_id
         JOIN study_episode e ON e.id = p.episode_id
        WHERE et.topic_id = ? AND e.status <> 'merged'
        ORDER BY p.created_at DESC, p.id DESC`,
      String(topic.id),
    );
    const n = rows.length;
    if (n < MIN_TOPIC_SAMPLE) {
      if (n > 0) skipped += 1;
      continue;
    }
    const reasked = rows.filter(row => Number(row.reask_count) > 0 || row.reasked_from !== null);
    const unresolved = rows.filter(row => String(row.resolution) === 'unresolved' || String(row.status) === 'abandoned');
    const successes = rows
      .filter(row => String(row.resolution) === 'understood')
      .map(row => String(row.closed_at ?? row.updated_at ?? row.opened_at));
    const lastSuccess = successes.length === 0 ? null : successes.sort().at(-1);
    const recentReasks = reasked.filter(row => {
      const at = Date.parse(String(row.created_at));
      return Number.isFinite(at) && at >= now.getTime() - FORGOTTEN_REASK_DAYS * DAY_MS;
    });
    const reaskRate = reasked.length / n;
    const unresolvedRate = unresolved.length / n;
    const recency = lastSuccess === null ? 1 : Math.min(1, ageDays(now, lastSuccess) / RECENCY_DAYS);
    const selfDifficulty = SELF_DIFFICULTY_DEFAULT;
    const score = weaknessScore({ n, reaskRate, unresolvedRate, recency, selfDifficulty });
    const failure = reasked.length > 0 || unresolved.length > 0;
    const state = successes.length > 0 && recentReasks.length >= 1
      ? 'forgotten'
      : (score >= WEAK_SCORE && failure ? 'weak' : 'stable');
    const evidence = rows.slice(0, 3).map(row => ({
      kind: 'problem',
      refId: String(row.id),
      episodeId: String(row.episode_id),
      at: String(row.created_at),
      label: `题目 ${String(row.id)}`,
    }));
    items.push({
      topicId: String(topic.id),
      name: String(topic.name),
      subject: subjectOfAliases(topic.aliases_json),
      score: round4(score),
      n,
      reaskCount: reasked.length,
      unresolvedCount: unresolved.length,
      reaskRate: round4(reaskRate),
      unresolvedRate: round4(unresolvedRate),
      recency: round4(recency),
      selfDifficulty,
      state,
      stateLabel: stateLabel(state),
      evidence,
      suggestion: suggestionOf(state, String(topic.name)),
      lastSuccessAt: lastSuccess,
    });
  }
  items.sort((left, right) => right.score - left.score
    || right.n - left.n
    || left.name.localeCompare(right.name));
  const ranked = items.slice(0, cap);
  return {
    status: ranked.length === 0 ? 'insufficient' : 'ok',
    items: ranked,
    considered: topics.length,
    skipped,
    reason: ranked.length === 0
      ? `每个主题至少需要 ${MIN_TOPIC_SAMPLE} 道题才能排序；当前证据不足。`
      : null,
  };
}

/**
 * The deterministic weakness formula from the increment plan.
 * @param {{ n: number, reaskRate: number, unresolvedRate: number, recency: number, selfDifficulty: number }} input
 *   Normalized factors.
 * @returns {number} 0-1 score.
 */
export function weaknessScore({ n, reaskRate, unresolvedRate, recency, selfDifficulty }) {
  const sample = n / (n + 3);
  return sample * (0.4 * reaskRate + 0.3 * unresolvedRate + 0.2 * recency + 0.1 * selfDifficulty);
}

/**
 * Build the rule-based method signals with evidence and counter-evidence.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, now: Date }} options - Scope and clock.
 * @returns {{ signals: object[], examined: object, thresholds: object }} Signals and inputs.
 */
export function methodSignals(db, { goalId, now }) {
  const since = new Date(now.getTime() - SIGNAL_LOOKBACK_DAYS * DAY_MS).toISOString();
  const signals = [
    sameTopicReaskSignal(db, { goalId, now }),
    nightInefficiencySignal(db, { goalId, now, since }),
    burstSignal(db, { goalId, now, since }),
    backlogSignal(db, { goalId, now }),
  ].filter(signal => signal !== null);
  return {
    signals,
    examined: {
      since,
      topics: Number(db.get('SELECT COUNT(*) AS count FROM study_topic WHERE goal_id = ?', goalId).count),
      episodes: Number(db.get(
        "SELECT COUNT(*) AS count FROM study_episode WHERE goal_id = ? AND status <> 'merged' AND opened_at >= ?",
        goalId,
        since,
      ).count),
      problems: Number(db.get(
        `SELECT COUNT(*) AS count FROM study_episode_problem p JOIN study_episode e ON e.id = p.episode_id
          WHERE e.goal_id = ? AND e.status <> 'merged' AND p.created_at >= ?`,
        goalId,
        since,
      ).count),
    },
    thresholds: {
      reaskDays: REASK_SIGNAL_DAYS,
      reaskCount: REASK_SIGNAL_COUNT,
      nightStartHour: NIGHT_START_HOUR,
      nightEndHour: NIGHT_END_HOUR,
      nightMinProblems: NIGHT_MIN_PROBLEMS,
      nightRateGap: NIGHT_RATE_GAP,
      burstUnits: BURST_UNITS,
      burstQuietDays: BURST_QUIET_DAYS,
      backlogCount: BACKLOG_COUNT,
      backlogDays: BACKLOG_DAYS,
    },
  };
}

/**
 * Compact evidence package: profile parameters, four recent period aggregates,
 * top weak topics with examples, signals, and the latest day summaries.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, now: Date, date: string, kind: 'week' | 'month' }} options - Scope and target period.
 * @returns {object} Bounded evidence package.
 */
export function buildEvidencePackage(db, { goalId, now, date, kind }) {
  const range = periodRange(date, kind);
  const periods = previousPeriods(date, kind, 4).map(period => {
    const stats = statsData(db, { from: period.startIso, to: period.endIsoInclusive });
    return {
      period: period.period,
      from: period.from,
      to: period.to,
      episodes: stats.episodes,
      problems: stats.problems,
      resolved: stats.resolved,
      unresolved: stats.unresolved,
      reaskRate: stats.problems === 0 ? 0 : round4(stats.reaskedProblems / stats.problems),
    };
  });
  const weak = weakTopics(db, { goalId, now, limit: 5 });
  const signals = methodSignals(db, { goalId, now });
  const summaries = summariesData(db, { from: range.startIso, to: range.endIsoInclusive, limit: 3 });
  const traits = evaluateAllTraits({ db, goalId, now }).map(trait => ({
    key: trait.spec.key,
    level: trait.level,
    active: trait.active,
    text: trait.text,
  }));
  return {
    kind,
    period: range.period,
    from: range.from,
    to: range.to,
    generatedAt: now.toISOString(),
    profile: traits,
    periods,
    weakTopics: {
      status: weak.status,
      reason: weak.reason,
      items: weak.items.map(item => ({
        topicId: item.topicId,
        name: item.name,
        subject: item.subject,
        score: item.score,
        n: item.n,
        state: item.state,
        evidence: item.evidence,
      })),
    },
    signals: signals.signals,
    summaries: summaries.items.map(item => ({
      day: item.day,
      summaryId: item.summaryId,
      text: item.text,
    })),
  };
}

/**
 * Calendar range of one report period, using the 04:00 study-day boundary.
 * @param {string} dateText - A study day (`YYYY-MM-DD`).
 * @param {'week'|'month'} kind - Period kind.
 * @returns {{ period: string, from: string, to: string, startIso: string, endIso: string, endIsoInclusive: string }}
 *   Local days and ISO bounds; `endIso` is exclusive.
 */
export function periodRange(dateText, kind) {
  if (kind === 'week') {
    const from = weekStartOf(dateText);
    const to = addDays(from, 6);
    const startIso = boundaryIso(from, 4);
    const endIso = boundaryIso(addDays(to, 1), 4);
    return {
      period: isoWeekOf(from),
      from,
      to,
      startIso,
      endIso,
      endIsoInclusive: new Date(Date.parse(endIso) - 1).toISOString(),
    };
  }
  if (kind === 'month') {
    const from = monthStartOf(dateText);
    const to = monthEndOf(from);
    const startIso = boundaryIso(from, 4);
    const endIso = boundaryIso(addDays(to, 1), 4);
    return {
      period: from.slice(0, 7),
      from,
      to,
      startIso,
      endIso,
      endIsoInclusive: new Date(Date.parse(endIso) - 1).toISOString(),
    };
  }
  throw new StudyError('invalid', `报告周期必须是 week 或 month，收到 ${JSON.stringify(kind)}`, { field: 'kind' });
}

/**
 * The last `count` periods ending at `dateText`, newest first.
 * @param {string} dateText - Study day.
 * @param {'week'|'month'} kind - Period kind.
 * @param {number} count - How many periods.
 * @returns {Array<ReturnType<typeof periodRange>>} Ranges.
 */
export function previousPeriods(dateText, kind, count) {
  const ranges = [];
  let cursor = dateText;
  for (let index = 0; index < count; index += 1) {
    const range = periodRange(cursor, kind);
    ranges.push(range);
    cursor = addDays(range.from, -1);
  }
  return ranges;
}

/**
 * Normalize a payload date or instant to the local study day. A date-only value
 * is already a study day; an ISO instant is mapped through the 04:00 rule.
 * @param {unknown} value - Optional input.
 * @param {Date} now - Fallback clock.
 * @returns {string} `YYYY-MM-DD`.
 */
export function studyDateOf(value, now) {
  if (value === undefined || value === null) return studyDay(now);
  if (typeof value !== 'string') throw new StudyError('invalid', 'date 必须是 YYYY-MM-DD 或 ISO 时间', { field: 'date' });
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00`);
    if (Number.isNaN(parsed.getTime()) || localDateOf(parsed) !== text) {
      throw new StudyError('invalid', `无效日期 ${text}`, { field: 'date' });
    }
    return text;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new StudyError('invalid', `无效时间 ${text}`, { field: 'date' });
  return studyDay(parsed);
}

/** Local `YYYY-MM-DD` of an instant. */
export function localDateOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Monday of the week containing a local date. */
export function weekStartOf(dateText) {
  const weekday = weekdayOf(dateText);
  return addDays(dateText, 1 - weekday);
}

/** First local day of the month containing a local date. */
export function monthStartOf(dateText) {
  return `${dateText.slice(0, 7)}-01`;
}

/** Last local day of the month containing a local date. */
export function monthEndOf(dateText) {
  const [year, month] = dateText.split('-').map(Number);
  return addDays(new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10), 0);
}

/** Add whole days to a local date string. */
export function addDays(dateText, delta) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + delta)).toISOString().slice(0, 10);
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function weekdayOf(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** ISO-8601 week identifier (`2026-W46`). */
export function isoWeekOf(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((date - yearStart) / DAY_MS) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** ISO instant of a local wall-clock boundary on a date. */
export function boundaryIso(dateText, hour) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(year, month - 1, day, hour, 0, 0, 0).toISOString();
}

function sameTopicReaskSignal(db, { goalId, now }) {
  const since = new Date(now.getTime() - REASK_SIGNAL_DAYS * DAY_MS).toISOString();
  const rows = db.all(
    `SELECT t.id, t.name, COUNT(DISTINCT p.id) AS reasks, MIN(p.created_at) AS first_at, MAX(p.created_at) AS last_at
       FROM study_topic t
       JOIN study_episode_topic et ON et.topic_id = t.id
       JOIN study_episode_problem p ON p.episode_id = et.episode_id
       JOIN study_episode e ON e.id = p.episode_id
      WHERE t.goal_id = ? AND e.status <> 'merged'
        AND p.reasked_from IS NOT NULL AND p.created_at >= ?
      GROUP BY t.id
     HAVING reasks >= ?
      ORDER BY reasks DESC, t.name ASC`,
    goalId,
    since,
    REASK_SIGNAL_COUNT,
  );
  const topic = rows[0];
  if (topic === undefined) return null;
  const examples = db.all(
    `SELECT p.id, p.created_at FROM study_episode_problem p
       JOIN study_episode_topic et ON et.episode_id = p.episode_id AND et.topic_id = ?
      WHERE p.reasked_from IS NOT NULL AND p.created_at >= ?
      ORDER BY p.created_at DESC, p.id DESC LIMIT 3`,
    String(topic.id),
    since,
  );
  return {
    kind: 'same_topic_reask',
    title: '同类反复',
    detail: `最近 ${REASK_SIGNAL_DAYS} 天里，「${String(topic.name)}」有 ${Number(topic.reasks)} 道题被重问，`
      + '可能停在“看懂”但还没到“会做”。',
    evidence: examples.map(row => ({
      kind: 'problem',
      refId: String(row.id),
      at: String(row.created_at),
      label: `题目 ${String(row.id)}`,
    })),
    counterEvidence: '也可能是你按复习安排重做，而不是没学会；若这些题当时已独立做对，这条信号不成立。',
    confidence: round4(Math.min(0.85, 0.6 + 0.05 * (Number(topic.reasks) - REASK_SIGNAL_COUNT))),
  };
}

function nightInefficiencySignal(db, { goalId, now, since }) {
  const rows = db.all(
    `SELECT p.id, p.created_at, p.reasked_from
       FROM study_episode_problem p JOIN study_episode e ON e.id = p.episode_id
      WHERE e.goal_id = ? AND e.status <> 'merged' AND p.created_at >= ?`,
    goalId,
    since,
  );
  let nightTotal = 0;
  let nightReasks = 0;
  let dayTotal = 0;
  let dayReasks = 0;
  for (const row of rows) {
    const hour = new Date(String(row.created_at)).getHours();
    const night = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
    if (night) {
      nightTotal += 1;
      if (row.reasked_from !== null) nightReasks += 1;
    } else {
      dayTotal += 1;
      if (row.reasked_from !== null) dayReasks += 1;
    }
  }
  if (nightTotal < NIGHT_MIN_PROBLEMS || dayTotal === 0) return null;
  const nightRate = nightReasks / nightTotal;
  const dayRate = dayReasks / dayTotal;
  if (nightRate - dayRate < NIGHT_RATE_GAP) return null;
  return {
    kind: 'night_inefficiency',
    title: '时段低效',
    detail: `22:00–02:00 重问率 ${Math.round(nightRate * 100)}%，日间 ${Math.round(dayRate * 100)}%，`
      + `高出 ${Math.round((nightRate - dayRate) * 100)} 个百分点。`,
    evidence: [
      { kind: 'window', refId: 'night', at: now.toISOString(), label: `夜间 ${nightReasks}/${nightTotal} 道重问` },
      { kind: 'window', refId: 'day', at: now.toISOString(), label: `日间 ${dayReasks}/${dayTotal} 道重问` },
    ],
    counterEvidence: `夜间样本只有 ${nightTotal} 道题，可能只是偶然；也可能与当天任务难度或疲劳有关。`,
    confidence: round4(Math.min(0.8, 0.55 + 0.03 * nightTotal)),
  };
}

function burstSignal(db, { goalId, now, since }) {
  const rows = db.all(
    `SELECT opened_at FROM study_episode
      WHERE goal_id = ? AND status <> 'merged' AND opened_at >= ?
      ORDER BY opened_at ASC`,
    goalId,
    since,
  );
  const counts = new Map();
  for (const row of rows) {
    const day = studyDay(new Date(String(row.opened_at)));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const days = [...counts.keys()].sort();
  for (const day of days.reverse()) {
    if ((counts.get(day) ?? 0) < BURST_UNITS) continue;
    let quiet = true;
    for (let offset = 1; offset <= BURST_QUIET_DAYS; offset += 1) {
      if ((counts.get(addDays(day, offset)) ?? 0) !== 0) {
        quiet = false;
        break;
      }
    }
    if (!quiet) continue;
    return {
      kind: 'burst',
      title: '集中突击',
      detail: `${day} 一天有 ${counts.get(day)} 个问答单元，随后 ${BURST_QUIET_DAYS} 天没有记录。`,
      evidence: [{ kind: 'day', refId: day, at: boundaryIso(day, 4), label: `${day}：${counts.get(day)} 个单元` }],
      counterEvidence: '也可能是一次专题突破，之后本来就需要消化；如果那几天你在别处练习，这条信号不成立。',
      confidence: 0.6,
    };
  }
  return null;
}

function backlogSignal(db, { goalId, now }) {
  const rows = db.all(
    `SELECT p.id, p.created_at
       FROM study_episode_problem p JOIN study_episode e ON e.id = p.episode_id
      WHERE e.goal_id = ? AND e.status <> 'merged' AND e.resolution = 'unresolved'
      ORDER BY p.created_at ASC, p.id ASC`,
    goalId,
  );
  if (rows.length < BACKLOG_COUNT) return null;
  const oldest = rows[0];
  const age = ageDays(now, String(oldest.created_at));
  if (age <= BACKLOG_DAYS) return null;
  return {
    kind: 'backlog',
    title: '未闭环积压',
    detail: `有 ${rows.length} 道题还没有闭环，最早一道已经放了 ${Math.floor(age)} 天。`,
    evidence: [
      { kind: 'problem', refId: String(oldest.id), at: String(oldest.created_at), label: `最早：题目 ${String(oldest.id)}` },
      { kind: 'count', refId: String(rows.length), at: now.toISOString(), label: `${rows.length} 道未闭环` },
    ],
    counterEvidence: '也可能是你刻意搁置、准备之后再处理；如果这些题已不在当前目标里，请先清理。',
    confidence: round4(Math.min(0.8, 0.6 + 0.02 * rows.length)),
  };
}

function stateLabel(state) {
  return { weak: '薄弱', forgotten: '遗忘', stable: '稳定', untouched: '未接触' }[state] ?? '未知';
}

function suggestionOf(state, name) {
  if (state === 'weak') return `挑 1 道「${name}」的旧题，合上答案独立做一遍；卡住就回到对应步骤。`;
  if (state === 'forgotten') return `安排一次 15 分钟复习：先默写「${name}」的关键步骤，再做 1 道同类题。`;
  if (state === 'untouched') return `从一道「${name}」的基础题开始，先确认概念，再做例题。`;
  return `保持当前节奏；下周用 1 道「${name}」的同类题自测是否还能独立完成。`;
}

function ageDays(now, at) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return RECENCY_DAYS;
  return Math.max(0, (now.getTime() - time) / DAY_MS);
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
