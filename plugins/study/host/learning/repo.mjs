/**
 * SQL for the learning evidence layer. Every statement is parameterized; the
 * module above owns validation and decision rules, this file owns the columns.
 * Timestamps are ISO-8601 UTC strings, so range filters compare lexicographically.
 */

/**
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @returns {Record<string, unknown> | undefined} Turn row for the message, when already captured.
 */
export function findTurn(db, sessionId, messageId) {
  return db.get('SELECT * FROM study_turn WHERE session_id = ? AND message_id = ?', sessionId, messageId);
}

/** Insert one captured user turn. */
export function insertTurn(db, turn) {
  db.run(
    `INSERT INTO study_turn
      (id, goal_id, session_id, message_id, turn_no, at, intent, is_learning, subject, text, text_hash,
       text_pruned_at, attachments_json, task_id, material_ref, episode_id, classified_by, classifier_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    turn.id, turn.goalId, turn.sessionId, turn.messageId, turn.turnNo, turn.at, turn.intent,
    turn.isLearning ? 1 : 0, turn.subject, turn.text, turn.textHash, turn.attachmentsJson,
    turn.taskId, turn.materialRef, turn.episodeId, turn.classifiedBy, turn.classifierVersion, turn.createdAt,
  );
}

/**
 * Most recent learning turn in one session; non-learning turns are skipped so a
 * question can continue across a "懂了" reply.
 */
export function previousLearningTurn(db, sessionId) {
  return db.get(
    'SELECT * FROM study_turn WHERE session_id = ? AND is_learning = 1 ORDER BY at DESC, rowid DESC LIMIT 1',
    sessionId,
  );
}

/** The task link of one conversation, when the tutoring module recorded one. */
export function sessionLink(db, sessionId) {
  if (!tableExists(db, 'study_tutoring_link') || !tableExists(db, 'study_task')) return null;
  const row = db.get(
    `SELECT l.task_id, t.subject, t.material_ref
       FROM study_tutoring_link l JOIN study_task t ON t.id = l.task_id
      WHERE l.session_id = ?`,
    sessionId,
  );
  if (row === undefined) return null;
  return {
    taskId: String(row.task_id),
    subject: row.subject === null || row.subject === undefined ? null : String(row.subject),
    materialRef: row.material_ref === null || row.material_ref === undefined ? null : String(row.material_ref),
  };
}

/** The open unit of one session, when the last learning turn left one. */
export function openEpisode(db, sessionId) {
  return db.get(
    `SELECT * FROM study_episode WHERE session_id = ? AND status = 'open' AND closed_at IS NULL
      ORDER BY opened_at DESC, rowid DESC LIMIT 1`,
    sessionId,
  );
}

/** Insert one open unit. */
export function createEpisode(db, episode) {
  db.run(
    `INSERT INTO study_episode
      (id, goal_id, session_id, subject, opened_at, closed_at, status, problem_count, stuck_json, method_json,
       resolution, confidence, summary, boundary_source, continuation_of, merged_into, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'open', 0, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`,
    episode.id, episode.goalId, episode.sessionId, episode.subject, episode.openedAt,
    episode.boundarySource, episode.createdAt, episode.updatedAt,
  );
}

/** Close every open unit of a session before a new one opens. */
export function closeOpenEpisodes(db, sessionId, at) {
  db.run(
    "UPDATE study_episode SET status = 'closed', closed_at = ?, updated_at = ? WHERE session_id = ? AND status = 'open' AND closed_at IS NULL",
    at,
    at,
    sessionId,
  );
}

/** Next user-turn position inside one unit. */
export function nextTurnPosition(db, episodeId) {
  const row = db.get('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM study_episode_turn WHERE episode_id = ?', episodeId);
  return Number(row.next);
}

/** How many user turns one unit already holds. */
export function countEpisodeTurns(db, episodeId) {
  return Number(db.get('SELECT COUNT(*) AS count FROM study_episode_turn WHERE episode_id = ?', episodeId).count);
}

/** Append one user turn to a unit. */
export function insertEpisodeTurn(db, entry) {
  db.run(
    'INSERT INTO study_episode_turn (episode_id, turn_id, position, role, ambiguous) VALUES (?, ?, ?, ?, ?)',
    entry.episodeId, entry.turnId, entry.position, entry.role, entry.ambiguous ? 1 : 0,
  );
}

/** How many problems one unit already holds. */
export function countProblems(db, episodeId) {
  return Number(db.get('SELECT COUNT(*) AS count FROM study_episode_problem WHERE episode_id = ?', episodeId).count);
}

/** Keep the denormalized problem count on the unit current. */
export function updateProblemCount(db, episodeId, problemCount, at) {
  db.run('UPDATE study_episode SET problem_count = ?, updated_at = ? WHERE id = ?', problemCount, at, episodeId);
}

/** Insert one problem of a unit. */
export function insertProblem(db, problem) {
  db.run(
    `INSERT INTO study_episode_problem
      (id, episode_id, position, text, norm, hash, sketch, status, resolution, reasked_from, reask_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, 0, ?)`,
    problem.id, problem.episodeId, problem.position, problem.text, problem.norm, problem.hash,
    problem.sketch, problem.reaskedFrom, problem.createdAt,
  );
}

/** Mark the earlier problem that the student asked again. */
export function markReasked(db, problemId) {
  db.run("UPDATE study_episode_problem SET reask_count = reask_count + 1, status = 'reasked' WHERE id = ?", problemId);
}

/**
 * Problems from other units of the same goal within the re-ask window.
 * @returns {Array<Record<string, unknown>>} Candidate rows with the owning unit's subject.
 */
export function reaskCandidates(db, { goalId, episodeId, since }) {
  return db.all(
    `SELECT p.*, e.subject AS episode_subject
       FROM study_episode_problem p JOIN study_episode e ON e.id = p.episode_id
      WHERE e.goal_id = ? AND p.created_at >= ? AND p.episode_id <> ?
      ORDER BY p.created_at DESC, p.rowid DESC`,
    goalId,
    since,
    episodeId,
  );
}

/** Insert one rule-derived signal. */
export function insertSignal(db, signal) {
  db.run(
    'INSERT INTO study_signal (id, episode_id, problem_id, turn_id, kind, at, value_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    signal.id, signal.episodeId, signal.problemId, signal.turnId, signal.kind, signal.at, signal.valueJson, signal.source,
  );
}

/** All signals of one unit, oldest first. */
export function signalsOfEpisode(db, episodeId) {
  return db.all('SELECT * FROM study_signal WHERE episode_id = ? ORDER BY at ASC, rowid ASC', episodeId);
}

/** Store the derived result of one unit. */
export function setResolution(db, episodeId, resolution, at) {
  db.run('UPDATE study_episode SET resolution = ?, updated_at = ? WHERE id = ?', resolution, at, episodeId);
}

/** One unit row. */
export function episodeRow(db, id) {
  return db.get('SELECT * FROM study_episode WHERE id = ?', id);
}

/** Problems of one unit in ask order. */
export function problemsOfEpisode(db, episodeId) {
  return db.all('SELECT * FROM study_episode_problem WHERE episode_id = ? ORDER BY position ASC', episodeId);
}

/** User turns of one unit in ask order. */
export function turnsOfEpisode(db, episodeId) {
  return db.all(
    `SELECT et.position, et.role, et.ambiguous, t.*
       FROM study_episode_turn et JOIN study_turn t ON t.id = et.turn_id
      WHERE et.episode_id = ? ORDER BY et.position ASC`,
    episodeId,
  );
}

/**
 * User turns of one unit with their wall-clock time, used by merge and split to
 * rebuild the chronological order across units.
 * @returns {Array<Record<string, unknown>>} Turn links oldest first.
 */
export function turnsWithTimeOfEpisode(db, episodeId) {
  return db.all(
    `SELECT et.turn_id, et.position, et.role, et.ambiguous, t.at
       FROM study_episode_turn et JOIN study_turn t ON t.id = et.turn_id
      WHERE et.episode_id = ? ORDER BY et.position ASC`,
    episodeId,
  );
}

/** Drop every turn link of one unit; merge reinserts them on the target. */
export function deleteEpisodeTurns(db, episodeId) {
  db.run('DELETE FROM study_episode_turn WHERE episode_id = ?', episodeId);
}

/** Point one captured turn at a unit. */
export function setTurnEpisode(db, turnId, episodeId) {
  db.run('UPDATE study_turn SET episode_id = ? WHERE id = ?', episodeId, turnId);
}

/** Move one problem and give it its new ask order. */
export function setProblemOwner(db, problemId, episodeId, position) {
  db.run('UPDATE study_episode_problem SET episode_id = ?, position = ? WHERE id = ?', episodeId, position, problemId);
}

/** Mark one source unit as folded into the target. */
export function setEpisodeMerged(db, id, targetId, at) {
  db.run(
    "UPDATE study_episode SET status = 'merged', merged_into = ?, closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ?",
    targetId,
    at,
    at,
    id,
  );
}

/** Close one unit at a user-visible boundary. */
export function closeEpisode(db, id, at) {
  db.run("UPDATE study_episode SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?", at, at, id);
}

/** Move a unit's `updated_at`, which is part of the summary evidence hash. */
export function touchEpisode(db, id, at) {
  db.run('UPDATE study_episode SET updated_at = ? WHERE id = ?', at, id);
}

/** Store the derived result as-is, including `null` when no signal exists. */
export function setResolutionOrNull(db, id, resolution, at) {
  db.run('UPDATE study_episode SET resolution = ?, updated_at = ? WHERE id = ?', resolution, at, id);
}

/** Insert the closed unit a split creates; the subject is copied by the caller. */
export function insertSplitEpisode(db, episode) {
  db.run(
    `INSERT INTO study_episode
      (id, goal_id, session_id, subject, opened_at, closed_at, status, problem_count, stuck_json, method_json,
       resolution, confidence, summary, boundary_source, continuation_of, merged_into, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'closed', 0, NULL, NULL, NULL, NULL, NULL, 'user', NULL, NULL, ?, ?)`,
    episode.id,
    episode.goalId,
    episode.sessionId,
    episode.subject,
    episode.openedAt,
    episode.closedAt,
    episode.createdAt,
    episode.updatedAt,
  );
}

/** Topic links of one unit. */
export function episodeTopics(db, episodeId) {
  return db.all('SELECT * FROM study_episode_topic WHERE episode_id = ? ORDER BY topic_id ASC', episodeId);
}

/** Remove every topic link of one unit before a merge rebuilds the union. */
export function deleteEpisodeTopics(db, episodeId) {
  db.run('DELETE FROM study_episode_topic WHERE episode_id = ?', episodeId);
}

/** Add one topic link to a unit. */
export function insertEpisodeTopic(db, { episodeId, topicId, confidence, source }) {
  db.run(
    'INSERT OR REPLACE INTO study_episode_topic (episode_id, topic_id, confidence, source) VALUES (?, ?, ?, ?)',
    episodeId,
    topicId,
    confidence,
    source,
  );
}

/** Move every signal of the folded units onto the merge target. */
export function moveSignalsOfEpisodes(db, fromIds, toId) {
  if (fromIds.length === 0) return;
  const placeholders = fromIds.map(() => '?').join(', ');
  db.run(`UPDATE study_signal SET episode_id = ? WHERE episode_id IN (${placeholders})`, toId, ...fromIds);
}

/**
 * Move signals that point at a turn or problem now owned by another unit.
 * Episode-level signals without either reference stay where they are.
 * @returns {number} Rows updated.
 */
export function moveSignalsOfCorrection(db, { episodeId, toEpisodeId, turnIds, problemIds }) {
  const clauses = [];
  const params = [];
  if (turnIds.length > 0) {
    clauses.push(`turn_id IN (${turnIds.map(() => '?').join(', ')})`);
    params.push(...turnIds);
  }
  if (problemIds.length > 0) {
    clauses.push(`problem_id IN (${problemIds.map(() => '?').join(', ')})`);
    params.push(...problemIds);
  }
  if (clauses.length === 0) return 0;
  const result = db.run(
    `UPDATE study_signal SET episode_id = ? WHERE episode_id = ? AND (${clauses.join(' OR ')})`,
    toEpisodeId,
    episodeId,
    ...params,
  );
  return Number(result.changes ?? 0);
}

/** Page of unit rows matching the read filters, newest first. */
export function listEpisodeRows(db, filters) {
  const filter = episodeFilter(filters);
  return db.all(
    `SELECT e.* FROM study_episode e ${filter.sql} ORDER BY e.opened_at DESC, e.rowid DESC LIMIT ?`,
    ...filter.params,
    filters.limit,
  );
}

/** Total matching units without the page limit. */
export function countEpisodeRows(db, filters) {
  const filter = episodeFilter(filters);
  return Number(db.get(`SELECT COUNT(*) AS total FROM study_episode e ${filter.sql}`, ...filter.params).total);
}

/**
 * Range aggregates for `learning.stats`.
 * @returns {{
 *   turns: number, learningTurns: number, episodes: number, problems: number,
 *   reaskedProblems: number, resolved: number, unresolved: number,
 *   bySubject: Array<{ subject: string, episodes: number, problems: number }>
 * }} Counts for the requested window.
 */
export function statsData(db, { from, to }) {
  const turnRange = whereRange('at', from, to);
  const episodeRange = whereRange('opened_at', from, to);
  const problemRange = whereRange('created_at', from, to);
  const turns = Number(db.get(`SELECT COUNT(*) AS count FROM study_turn ${turnRange.sql}`, ...turnRange.params).count);
  const learningTurns = Number(db.get(
    `SELECT COUNT(*) AS count FROM study_turn ${withCondition(turnRange, 'is_learning = 1')}`,
    ...turnRange.params,
  ).count);
  const episodes = Number(db.get(`SELECT COUNT(*) AS count FROM study_episode ${episodeRange.sql}`, ...episodeRange.params).count);
  const problemsRow = db.get(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN reasked_from IS NOT NULL THEN 1 ELSE 0 END), 0) AS reasked
       FROM study_episode_problem ${problemRange.sql}`,
    ...problemRange.params,
  );
  const resolved = Number(db.get(
    `SELECT COUNT(*) AS count FROM study_episode ${withCondition(episodeRange, "resolution = 'understood'")}`,
    ...episodeRange.params,
  ).count);
  const unresolved = Number(db.get(
    `SELECT COUNT(*) AS count FROM study_episode ${withCondition(episodeRange, "resolution = 'unresolved'")}`,
    ...episodeRange.params,
  ).count);
  const bySubject = db.all(
    `SELECT COALESCE(e.subject, '未分类') AS subject, COUNT(DISTINCT e.id) AS episodes, COUNT(p.id) AS problems
       FROM study_episode e LEFT JOIN study_episode_problem p ON p.episode_id = e.id
       ${episodeRange.sql}
      GROUP BY COALESCE(e.subject, '未分类')
      ORDER BY episodes DESC, subject ASC`,
    ...episodeRange.params,
  ).map(row => ({ subject: String(row.subject), episodes: Number(row.episodes), problems: Number(row.problems) }));
  return {
    turns,
    learningTurns,
    episodes,
    problems: Number(problemsRow.total),
    reaskedProblems: Number(problemsRow.reasked),
    resolved,
    unresolved,
    bySubject,
  };
}

/** Record one capture failure so a dropped turn is visible instead of silent. */
export function insertGap(db, gap) {
  db.run(
    'INSERT INTO study_capture_gap (id, session_id, message_id, reason, detail_json, at, resolved) VALUES (?, ?, ?, ?, ?, ?, 0)',
    gap.id, gap.sessionId, gap.messageId, gap.reason, gap.detailJson, gap.at,
  );
}

/* ---------------------------------------------------------------- internals */

function tableExists(db, name) {
  return db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name) !== undefined;
}

function whereRange(column, from, to) {
  const clauses = [];
  const params = [];
  if (from !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(from);
  }
  if (to !== undefined) {
    clauses.push(`${column} <= ?`);
    params.push(to);
  }
  return { sql: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, params };
}

function withCondition(range, condition) {
  return range.sql === '' ? `WHERE ${condition}` : `${range.sql} AND ${condition}`;
}

function episodeFilter({ from, to, subject, status, resolution, query }) {
  const clauses = [];
  const params = [];
  if (from !== undefined) {
    clauses.push('e.opened_at >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    clauses.push('e.opened_at <= ?');
    params.push(to);
  }
  if (subject !== undefined) {
    clauses.push('e.subject = ?');
    params.push(subject);
  }
  if (status !== undefined) {
    clauses.push('e.status = ?');
    params.push(status);
  }
  if (resolution !== undefined) {
    clauses.push('e.resolution = ?');
    params.push(resolution);
  }
  if (query !== undefined) {
    const pattern = likePattern(query);
    clauses.push(
      `(EXISTS (SELECT 1 FROM study_episode_problem p WHERE p.episode_id = e.id AND p.text LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM study_episode_turn et JOIN study_turn t ON t.id = et.turn_id
                    WHERE et.episode_id = e.id AND t.text LIKE ? ESCAPE '\\'))`,
    );
    params.push(pattern, pattern);
  }
  return { sql: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, params };
}

function likePattern(query) {
  return `%${query.replace(/[\\%_]/g, character => `\\${character}`)}%`;
}
