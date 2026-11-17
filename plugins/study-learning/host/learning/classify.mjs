/**
 * Rule classifier for captured user turns. Priority is feedback > question >
 * planning > emotion > chitchat, so "还是不懂，怎么算" stays a feedback turn
 * and "明天几点出发" stays planning even though both look question-like. Every
 * result names the rule that produced it; no model is involved.
 */

/** Classifier contract version recorded on every turn. */
export const CLASSIFIER_VERSION = 'rule-v1';

/** Intents the evidence layer stores. */
export const INTENTS = Object.freeze(['question', 'planning', 'feedback', 'emotion', 'chitchat']);

const FEEDBACK_WORDS = Object.freeze(['懂了', '明白了', '没懂', '不懂', '再讲', '太快', '太难', '清楚']);
const QUESTION_WORDS = Object.freeze(['怎么', '为什么', '这题', '求解', '证明', '对不对', '什么意思', '思路']);
const PLANNING_WORDS = Object.freeze(['明天', '后天', '几点', '安排', '计划', '推迟', '取消', '时间表']);
const EMOTION_WORDS = Object.freeze(['累', '困', '焦虑', '烦', '压力', '睡不着']);

/** Outcome signals a student can express inside a turn, in evaluation order. */
const SIGNAL_RULES = Object.freeze([
  { kind: 'understood', pattern: /懂了|明白了|会了|清楚了|谢谢/ },
  { kind: 'confused', pattern: /没懂|不懂|不明白|还是不会|再讲|听不懂/ },
  { kind: 'self_solved', pattern: /我做出来|我算出来|自己解出来/ },
  { kind: 'gave_up', pattern: /不做了|放弃|太难了/ },
]);

/**
 * @param {string} text - Trimmed user text.
 * @param {string[]} words - Candidate words.
 * @returns {string[]} Words present in the text.
 */
function hits(text, words) {
  return words.filter(word => text.includes(word));
}

/**
 * Classify one user turn.
 * @param {string} text - Trimmed user text.
 * @param {{ taskId?: string | null, attachments?: Array<{ type: string, name: string | null }> }} [context]
 *   Task link and attachment blocks; either makes a non-question turn learning.
 * @returns {{ intent: string, isLearning: boolean, matched: string[], classifierVersion: string }}
 *   Intent, whether the turn belongs to the learning evidence layer, and the matched words.
 */
export function classify(text, { taskId = null, attachments = [] } = {}) {
  const feedback = hits(text, FEEDBACK_WORDS);
  const questionWords = hits(text, QUESTION_WORDS);
  const hasQuestionMark = /[?？]/.test(text);
  const isQuestion = hasQuestionMark || questionWords.length > 0;
  const planning = hits(text, PLANNING_WORDS);
  const emotion = hits(text, EMOTION_WORDS);

  let intent;
  let matched;
  if (feedback.length > 0) {
    intent = 'feedback';
    matched = feedback;
  } else if (isQuestion) {
    intent = 'question';
    matched = hasQuestionMark ? [...questionWords, '?'] : questionWords;
  } else if (planning.length > 0) {
    intent = 'planning';
    matched = planning;
  } else if (emotion.length > 0) {
    intent = 'emotion';
    matched = emotion;
  } else {
    intent = 'chitchat';
    matched = [];
  }

  const hasAttachment = attachments.some(item => item.type === 'image' || item.type === 'file');
  const isLearning = intent === 'question' || taskId !== null || hasAttachment;
  return { intent, isLearning, matched, classifierVersion: CLASSIFIER_VERSION };
}

/**
 * Outcome signals expressed in one turn. All matching kinds are returned; the
 * caller decides which episode they belong to.
 * @param {string} text - Trimmed user text.
 * @returns {string[]} Signal kinds (`understood`, `confused`, `self_solved`, `gave_up`).
 */
export function signalKinds(text) {
  return SIGNAL_RULES
    .filter(rule => rule.pattern.test(text))
    .map(rule => rule.kind);
}
