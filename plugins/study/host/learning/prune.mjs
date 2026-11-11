/**
 * 90-day retention: clear full text but keep the evidence skeleton.
 *
 * `study_turn.text` is cleared and stamped with `text_pruned_at`; problem
 * `text` and `norm` are cleared while `hash`, `sketch`, status, and every
 * aggregate stay. No row is deleted and no tombstone is written: this is a
 * retention policy, not a deletion.
 */

/** Full text lives this many days after the turn or problem was created. */
export const PRUNE_AFTER_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Clear text older than the retention window. Idempotent: a second run with the
 * same clock changes nothing.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ now: Date }} options - Clock.
 * @returns {{ at: string, cutoff: string, turns: number, problems: number }} Prune counts.
 */
export function pruneTexts(db, { now }) {
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - PRUNE_AFTER_DAYS * DAY_MS).toISOString();
  const turns = db.run(
    `UPDATE study_turn SET text = NULL, text_pruned_at = ?
      WHERE at < ? AND text_pruned_at IS NULL AND text IS NOT NULL`,
    at,
    cutoff,
  ).changes;
  const problems = db.run(
    `UPDATE study_episode_problem SET text = NULL, norm = NULL
      WHERE created_at < ? AND (text IS NOT NULL OR norm IS NOT NULL)`,
    cutoff,
  ).changes;
  return { at, cutoff, turns, problems };
}
