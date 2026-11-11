/**
 * Deterministic Chinese-friendly text helpers for the learning evidence layer:
 * normalization, character bigrams, Jaccard similarity, keyword sketches, and
 * content hashes. Nothing here reads conversation state or calls a model; every
 * value can be recomputed from the text alone.
 */
import { createHash } from 'node:crypto';

const STRIP = /[\s\u3000，。！？、；：,.!?;:'"“”‘’（）()\[\]{}<>《》「」『』【】…—\-_~·/\\|]+/gu;
const TOKEN_RUNS = /[\p{Script=Han}]+|[a-z0-9]+/gu;
const SKETCH_SIZE = 8;

/** Function words and question scaffolding that carry no topic signal. */
const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们',
  '在', '有', '和', '就', '也', '这', '那', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '哈',
  '请', '帮', '把', '被', '给', '对', '从', '到', '而', '但', '如果', '因为', '所以',
  '一个', '一下', '这个', '那个', '这样', '那样', '这些', '那些', '什么', '怎么', '为什么',
  '如何', '可以', '需要', '应该', '还是', '就是', '不是', '没有', '现在', '然后', '已经',
  '一些', '一下', '一遍', '一次', '一直', '这样', '那样', '一起',
  '题目', '这题', '那道', '一道', '这道理',
]);

/**
 * Canonical text for storage and comparison: NFKC, lower case, no whitespace or punctuation.
 * @param {string} text - Raw text.
 * @returns {string} Normalized text.
 */
export function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(STRIP, '');
}

/**
 * Content hash of two questions with the same normalized text.
 * @param {string} text - Raw text.
 * @returns {string} SHA-256 hex digest of {@link normalize}.
 */
export function hashText(text) {
  return createHash('sha256').update(normalize(text)).digest('hex');
}

/**
 * Character bigrams of the normalized text; used for cheap similarity.
 * @param {string} text - Raw text.
 * @returns {Set<string>} Bigrams, or the single character of a one-character text.
 */
export function bigrams(text) {
  const characters = [...normalize(text)];
  const grams = new Set();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    grams.add(`${characters[index]}${characters[index + 1]}`);
  }
  if (grams.size === 0 && characters.length === 1) grams.add(characters[0]);
  return grams;
}

/**
 * Jaccard similarity of two token sets.
 * @param {Set<string>} left - First set.
 * @param {Set<string>} right - Second set.
 * @returns {number} 0-1; two empty sets count as identical.
 */
export function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Similarity of two texts by character bigrams.
 * @param {string} left - First text.
 * @param {string} right - Second text.
 * @returns {number} 0-1.
 */
export function similarity(left, right) {
  return jaccard(bigrams(left), bigrams(right));
}

/**
 * Topic-bearing tokens: Han bigrams (single characters for one-character runs)
 * plus ASCII words.
 * @param {string} text - Raw text.
 * @returns {string[]} Tokens in text order.
 */
export function tokenize(text) {
  const tokens = [];
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(TOKEN_RUNS)) {
    const run = match[0];
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length > 1) tokens.push(run);
      continue;
    }
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return tokens;
}

/**
 * Keyword sketch of a question: the highest-frequency topic tokens joined by
 * spaces. Survives later pruning of the full text.
 * @param {string} text - Raw text.
 * @param {number} [size] - How many tokens to keep.
 * @returns {string} Space-separated tokens, possibly empty for stopword-only text.
 */
export function sketch(text, size = SKETCH_SIZE) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1]
      || right[0].length - left[0].length
      || left[0].localeCompare(right[0]))
    .slice(0, size)
    .map(([token]) => token)
    .join(' ');
}

/**
 * Token set of a stored sketch.
 * @param {string | null | undefined} sketchText - Space-separated sketch.
 * @returns {Set<string>} Tokens.
 */
export function sketchTokens(sketchText) {
  return new Set(typeof sketchText === 'string' ? sketchText.split(' ').filter(Boolean) : []);
}

/**
 * Shorten text with an ellipsis, never exceeding `max` characters.
 * @param {string} text - Raw text.
 * @param {number} max - Maximum length.
 * @returns {string} Original or truncated text.
 */
export function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
