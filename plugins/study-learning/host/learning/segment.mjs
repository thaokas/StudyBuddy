/**
 * Q&A-unit boundary scoring. S1 has no topic dictionary, so the substitute for
 * "topics do not overlap" is a changed subject; the remaining weights follow the
 * design's §6.2 table. Scores are accumulated in hundredths so the 0.30/0.50
 * thresholds are exact instead of drifting on binary floating point.
 */
import { similarity } from './text.mjs';

/** Phrases that announce a new question. */
export const BOUNDARY_WORDS = Object.freeze(['再问一道', '另一个问题', '这题我会了', '换个问题']);

/** Phrases that continue the current question. */
export const CONTINUATION_WORDS = Object.freeze(['那', '这一步', '为什么这里', '还是不懂', '再讲', '然后呢']);

/** A gap longer than this always opens a new unit. */
export const MAX_GAP_MS = 30 * 60 * 1000;

/** A new unit opens at or above this boundary score. */
export const SPLIT_AT = 50;

/** Between this score and {@link SPLIT_AT} the turn joins but is marked ambiguous. */
export const AMBIGUOUS_AT = 30;

/** Upper bound of user turns per unit; the next turn opens a new unit. */
export const MAX_EPISODE_TURNS = 8;

/** Turns that introduce an additional problem inside the same unit. */
export const NEW_PROBLEM_PATTERN = /第\s*[一二三四五1-5]\s*题|另一道|顺便问|还有一道/;

/**
 * Whether a follow-up turn adds another problem to the current unit.
 * @param {string} text - Trimmed user text.
 * @returns {boolean} True when the turn names another problem.
 */
export function isNewProblemTurn(text) {
  return NEW_PROBLEM_PATTERN.test(text);
}

/**
 * Boundary score between the previous learning turn and the current one.
 * @param {{ text: string, subject: string | null, taskId: string | null, materialRef: string | null, at: string }} previous
 *   Previous learning turn.
 * @param {{ text: string, subject: string | null, taskId: string | null, materialRef: string | null, at: string }} current
 *   Turn being captured.
 * @returns {{ points: number, score: number, factors: object }} Score in hundredths and the contributing factors.
 */
export function boundaryScore(previous, current) {
  const textSimilarity = similarity(previous.text, current.text);
  const previousSubject = previous.subject ?? null;
  const currentSubject = current.subject ?? null;
  const subjectChanged = previousSubject !== null && currentSubject !== null && previousSubject !== currentSubject;
  const boundaryWord = BOUNDARY_WORDS.find(word => current.text.includes(word)) ?? null;
  const continuationWord = CONTINUATION_WORDS.find(word => current.text.includes(word)) ?? null;
  const referenceChanged = (previous.taskId ?? null) !== (current.taskId ?? null)
    || (previous.materialRef ?? null) !== (current.materialRef ?? null);
  const gapMs = Date.parse(current.at) - Date.parse(previous.at);
  const longerThanHalfHour = Number.isFinite(gapMs) && gapMs > MAX_GAP_MS;
  const sameSubject = previousSubject === currentSubject;

  let points = 0;
  if (subjectChanged) points += 35;
  if (textSimilarity < 0.15) points += 20;
  if (boundaryWord !== null) points += 15;
  if (referenceChanged) points += 10;
  if (longerThanHalfHour) points += 10;
  if (continuationWord !== null) points -= 30;
  if (textSimilarity > 0.45) points -= 20;
  if (sameSubject && continuationWord !== null) points -= 15;

  return {
    points,
    score: points / 100,
    factors: {
      similarity: textSimilarity,
      subjectChanged,
      lowSimilarity: textSimilarity < 0.15,
      highSimilarity: textSimilarity > 0.45,
      boundaryWord,
      continuationWord,
      referenceChanged,
      longerThanHalfHour,
      sameSubject,
    },
  };
}

/**
 * Map an accumulated boundary score to the unit decision.
 * @param {number} points - Score in hundredths from {@link boundaryScore}.
 * @returns {'split' | 'ambiguous' | 'join'} Decision.
 */
export function decideBoundary(points) {
  if (points >= SPLIT_AT) return 'split';
  if (points >= AMBIGUOUS_AT) return 'ambiguous';
  return 'join';
}
