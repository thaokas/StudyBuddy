/**
 * Deterministic topic clustering over the Q&A units.
 *
 * A topic is a group of at least two recent problems under the same subject
 * whose keyword sketches overlap enough (Jaccard >= 0.5). The cluster is
 * greedy: each problem joins the most similar existing cluster or starts a new
 * one, using the cluster's first problem as its representative. Names come from
 * the three most frequent sketch tokens, so rerunning the same evidence keeps
 * the same names and reuses the existing `study_topic` row.
 *
 * Nothing here calls a model. The result is stored in the S1 `study_topic` and
 * `study_episode_topic` tables, with `subject` kept in `aliases_json` because
 * the S1 topic table has no subject column.
 */
import { randomUUID } from 'node:crypto';
import { jaccard, sketchTokens } from './text.mjs';

/** Recluster window: only problems created in the last 90 days participate. */
export const TOPIC_WINDOW_DAYS = 90;

/** Two sketches at or above this Jaccard join the same topic. */
export const TOPIC_SIMILARITY = 0.5;

/** A topic needs at least this many problems. */
export const TOPIC_MIN_SIZE = 2;

/** Name budget from the increment plan. */
export const TOPIC_NAME_TOKENS = 3;
export const TOPIC_NAME_CHARS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const UNCLASSIFIED = '未分类';
const DELETE_BATCH = 400;

/**
 * Recompute the rule topics of one goal and persist them.
 *
 * The candidate units' previous rule topics are replaced, so a rerun is
 * idempotent even after a merge, a split, or a 90-day horizon rollover. Topics
 * older than the horizon keep their historical links; only rows whose episodes
 * are candidates are rewritten. Existing topics are reused by name + subject.
 *
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, now: Date, change?: Function }} options - Goal, clock, change recorder.
 * @returns {{ topics: object[], candidates: number, episodes: number, created: number }} Cluster summary.
 */
export function refreshTopics(db, { goalId, now, change }) {
  const cutoff = new Date(now.getTime() - TOPIC_WINDOW_DAYS * DAY_MS).toISOString();
  const candidates = db.all(
    `SELECT p.id, p.episode_id, p.sketch, p.created_at, COALESCE(e.subject, ?) AS subject
       FROM study_episode_problem p JOIN study_episode e ON e.id = p.episode_id
      WHERE e.goal_id = ? AND e.status <> 'merged' AND p.sketch <> '' AND p.created_at >= ?
      ORDER BY p.created_at ASC, p.id ASC`,
    UNCLASSIFIED,
    goalId,
    cutoff,
  );
  const clusters = clusterProblems(candidates.map(row => ({
    id: String(row.id),
    episodeId: String(row.episode_id),
    sketch: String(row.sketch),
    createdAt: String(row.created_at),
    subject: String(row.subject),
  }))).filter(cluster => cluster.members.length >= TOPIC_MIN_SIZE);

  const candidateEpisodes = [...new Set(candidates.map(row => String(row.episode_id)))];
  deleteRuleTopicLinks(db, candidateEpisodes);

  const topics = [];
  let created = 0;
  for (const cluster of clusters) {
    const spec = topicSpecOf(cluster, topics);
    const found = findOrCreateTopic(db, {
      goalId,
      subject: cluster.subject,
      name: spec.name,
      now,
    });
    if (found.created) created += 1;
    const confidence = round4(averageSimilarity(cluster));
    const episodeIds = [...new Set(cluster.members.map(member => member.episodeId))];
    for (const episodeId of episodeIds) {
      db.run(
        `INSERT INTO study_episode_topic (episode_id, topic_id, confidence, source)
         VALUES (?, ?, ?, 'rule')
         ON CONFLICT(episode_id, topic_id) DO UPDATE SET confidence = excluded.confidence, source = 'rule'`,
        episodeId,
        found.id,
        confidence,
      );
    }
    topics.push({
      id: found.id,
      goalId,
      name: spec.name,
      subject: cluster.subject,
      size: cluster.members.length,
      confidence,
      problemIds: cluster.members.map(member => member.id),
      episodeIds,
      createdAt: found.createdAt,
    });
  }

  if (change !== undefined && (topics.length > 0 || candidates.length > 0)) {
    change({
      entity: 'topic',
      entityId: goalId,
      action: 'cluster',
      before: null,
      after: {
        candidates: candidates.length,
        topics: topics.length,
        created,
        names: topics.map(topic => topic.name),
      },
    });
  }
  return {
    topics,
    candidates: candidates.length,
    episodes: candidateEpisodes.length,
    created,
  };
}

/**
 * Greedy sketch clustering. The representative is the first member of the
 * cluster; ties are broken by the highest similarity, then by earliest cluster.
 * @param {Array<{ id: string, episodeId: string, sketch: string, createdAt: string, subject: string }>} problems
 *   Candidate problems, already ordered deterministically.
 * @returns {Array<{ subject: string, representative: string, members: object[] }>} Clusters, including singletons.
 */
export function clusterProblems(problems) {
  const bySubject = new Map();
  for (const problem of problems) {
    const key = problem.subject || UNCLASSIFIED;
    const list = bySubject.get(key) ?? [];
    list.push(problem);
    bySubject.set(key, list);
  }
  const clusters = [];
  for (const [subject, list] of [...bySubject.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const subjectClusters = [];
    for (const problem of list) {
      const tokens = sketchTokens(problem.sketch);
      let best = null;
      let bestScore = 0;
      for (const cluster of subjectClusters) {
        const score = jaccard(tokens, cluster.tokens);
        if (score >= TOPIC_SIMILARITY && (best === null || score > bestScore)) {
          best = cluster;
          bestScore = score;
        }
      }
      if (best === null) {
        subjectClusters.push({
          subject,
          representative: problem.sketch,
          tokens,
          members: [problem],
        });
      } else {
        best.members.push(problem);
      }
    }
    clusters.push(...subjectClusters);
  }
  return clusters;
}

/**
 * Name a cluster from its three most frequent sketch tokens. Overlapping Han
 * bigrams are merged so "函数 数可 可微" becomes "函数可微".
 * @param {{ members: object[] }} cluster - Cluster.
 * @returns {string} 1-20 character name.
 */
export function topicNameOf(cluster) {
  const counts = new Map();
  for (const member of cluster.members) {
    for (const token of new Set(sketchTokens(member.sketch))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .sort((left, right) => right[1] - left[1]
      || right[0].length - left[0].length
      || left[0].localeCompare(right[0]))
    .slice(0, TOPIC_NAME_TOKENS)
    .map(([token]) => token);
  if (ranked.length === 0) return '未命名主题';
  let name = '';
  for (const token of ranked) {
    if (name === '') {
      name = token;
    } else if (token.startsWith(name.slice(-1))) {
      name += token.slice(1);
    } else {
      name += token;
    }
    if (name.length >= TOPIC_NAME_CHARS) break;
  }
  return name.slice(0, TOPIC_NAME_CHARS);
}

/**
 * Find an existing topic of the same goal, subject, and name, or create one.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, subject: string, name: string, now: Date }} options - Identity and clock.
 * @returns {{ id: string, createdAt: string, created: boolean }} Topic row.
 */
export function findOrCreateTopic(db, { goalId, subject, name, now }) {
  const rows = db.all(
    'SELECT id, aliases_json, created_at FROM study_topic WHERE goal_id = ? AND name = ? ORDER BY created_at ASC, id ASC',
    goalId,
    name,
  );
  const existing = rows.find(row => subjectOfAliases(row.aliases_json) === subject);
  if (existing !== undefined) {
    return { id: String(existing.id), createdAt: String(existing.created_at), created: false };
  }
  const id = `topic_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const createdAt = now.toISOString();
  db.run(
    `INSERT INTO study_topic (id, goal_id, name, aliases_json, parent_id, material_ref, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    id,
    goalId,
    name,
    JSON.stringify({ subject }),
    createdAt,
  );
  return { id, createdAt, created: true };
}

/**
 * Average Jaccard similarity of a cluster's members to its representative.
 * @param {{ representative: string, members: object[] }} cluster - Cluster.
 * @returns {number} 0-1.
 */
export function averageSimilarity(cluster) {
  const representative = sketchTokens(cluster.representative);
  const total = cluster.members.reduce(
    (sum, member) => sum + jaccard(representative, sketchTokens(member.sketch)),
    0,
  );
  return total / cluster.members.length;
}

/**
 * Resolve a collision-free name for a cluster. The same subject reuses the same
 * base name; a different subject with the same name cannot share the row, so a
 * short suffix keeps the two topics addressable.
 * @param {{ subject: string, members: object[] }} cluster - Cluster.
 * @param {Array<{ name: string, subject: string }>} used - Topics produced in this run.
 * @returns {{ name: string }} Name.
 */
function topicSpecOf(cluster, used) {
  const base = topicNameOf(cluster);
  let name = base;
  for (let index = 2; used.some(topic => topic.name === name && topic.subject !== cluster.subject); index += 1) {
    const suffix = `·${index}`;
    name = `${base.slice(0, TOPIC_NAME_CHARS - suffix.length)}${suffix}`;
  }
  return { name };
}

/** Delete the rule topic links of the given episodes in bounded batches. */
function deleteRuleTopicLinks(db, episodeIds) {
  for (let start = 0; start < episodeIds.length; start += DELETE_BATCH) {
    const batch = episodeIds.slice(start, start + DELETE_BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    db.run(
      `DELETE FROM study_episode_topic
        WHERE episode_id IN (${placeholders}) AND source = 'rule' AND topic_id LIKE 'topic_%'`,
      ...batch,
    );
  }
}

/** Read subject metadata out of `aliases_json` without trusting its shape. */
export function subjectOfAliases(raw) {
  if (raw === null || raw === undefined) return UNCLASSIFIED;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed !== null && typeof parsed === 'object' && typeof parsed.subject === 'string'
      ? parsed.subject : UNCLASSIFIED;
  } catch {
    return UNCLASSIFIED;
  }
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
