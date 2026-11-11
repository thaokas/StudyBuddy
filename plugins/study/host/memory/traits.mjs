/**
 * Teaching-parameter traits: the Beta model, auto-effect thresholds, the
 * one-step-per-week guard, and the tutoring-contract compiler.
 *
 * Only `explain_detail` is inferred. A re-ask of the same problem within seven
 * days is evidence that the last explanation was not detailed enough (positive
 * weight for "needs more detail"); an understood unit that was never re-asked
 * is evidence that the current level was enough (negative weight). The Beta
 * posterior starts at alpha = beta = 1 and decays each weight by
 * `0.5 ** (ageDays / 56)`. The other traits are set explicitly and never
 * inferred in this increment.
 *
 * The effective level is decided by `decideTrait`: confidence thresholds first,
 * then the sensitive cold start (three independent units over fourteen days),
 * then the weekly one-step limit. Evidence older than eight weeks falls back to
 * the default level.
 */
import { StudyError } from '../registry.mjs';
import { currentItemByKey } from './store.mjs';

/** Duration of one day in milliseconds (all trait windows use exact instants). */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** One step of a trait may change at most once per this window. */
export const WEEK_MS = 7 * DAY_MS;

/** Evidence older than this is ignored, so a stale trait falls back to default. */
export const EVIDENCE_TTL_DAYS = 56;

/** A trait is effective at or above this posterior confidence. */
export const ACTIVE_CONFIDENCE = 0.70;

/** Between this and {@link ACTIVE_CONFIDENCE}, only ordering traits apply. */
export const SOFT_CONFIDENCE = 0.50;

/** Sensitive traits need this many independent units and days before first use. */
export const SENSITIVE_MIN_UNITS = 3;
export const SENSITIVE_MIN_SPAN_DAYS = 14;

/** A re-ask counts only when it comes within this many days of the original. */
export const REASK_WINDOW_DAYS = 7;

/** Beta weights for the two explain_detail signals. */
const REASK_WEIGHT = 1;
const CLEAN_CLOSURE_WEIGHT = 0.5;

/** Traits that may apply inside the soft confidence band. */
export const SOFT_TRAITS = Object.freeze(['example_first', 'step_granularity']);

/** Detail levels from design §8.1, compiled into the contract as a constraint. */
const DETAIL_CONSTRAINTS = Object.freeze({
  1: '结论 + 1 步',
  2: '结论 + 关键推导',
  3: '结论 + 推导 + 1 例',
  4: '补前置 + 推导 + 例子',
  5: '前置确认 + 定义 + 动机 + 推导 + 例子 + 易错点',
});

/** The six fixed traits, in contract order. */
export const TRAITS = Object.freeze([
  Object.freeze({ key: 'explain_detail', min: 1, max: 5, step: 1, defaultLevel: 3, sensitive: true, inferred: true }),
  Object.freeze({ key: 'hint_preference', min: 0, max: 1, step: 0.5, defaultLevel: 0.5, sensitive: false, inferred: false }),
  Object.freeze({ key: 'pace', min: -1, max: 1, step: 1, defaultLevel: 0, sensitive: true, inferred: false }),
  Object.freeze({ key: 'example_first', min: 0, max: 1, step: 0.5, defaultLevel: 0.5, sensitive: false, inferred: false }),
  Object.freeze({ key: 'step_granularity', min: 1, max: 3, step: 1, defaultLevel: 2, sensitive: false, inferred: false }),
  Object.freeze({ key: 'check_frequency', min: 0, max: 2, step: 1, defaultLevel: 1, sensitive: false, inferred: false }),
]);

const TRAIT_BY_KEY = new Map(TRAITS.map(spec => [spec.key, spec]));

/** Chinese labels for host-side rendering (the page localizes its own labels). */
const TRAIT_LABELS = Object.freeze({
  explain_detail: '详细度',
  hint_preference: '提示偏好',
  pace: '推进速度',
  example_first: '例子顺序',
  step_granularity: '步骤粒度',
  check_frequency: '确认频率',
});

/**
 * Look up one trait definition.
 * @param {string} key - Trait key.
 * @returns {object} Frozen trait spec.
 */
export function traitSpec(key) {
  const spec = TRAIT_BY_KEY.get(key);
  if (spec === undefined) throw new StudyError('invalid', `未知的讲解参数 ${JSON.stringify(key)}；可用值：${TRAITS.map(item => item.key).join('、')}`);
  return spec;
}

/**
 * Map a normalized Beta value onto the trait's display level.
 * @param {object} spec - Trait spec.
 * @param {number} value - Value in [0, 1].
 * @returns {number} Level on the trait grid.
 */
export function levelOf(spec, value) {
  const clamped = Math.min(1, Math.max(0, value));
  const steps = Math.round((clamped * (spec.max - spec.min)) / spec.step);
  return roundLevel(Math.min(spec.max, Math.max(spec.min, spec.min + steps * spec.step)));
}

/**
 * Normalized value for one display level.
 * @param {object} spec - Trait spec.
 * @param {number} level - Level on the trait grid.
 * @returns {number} Value in [0, 1].
 */
export function valueOfLevel(spec, level) {
  return (level - spec.min) / (spec.max - spec.min);
}

/**
 * Whether a number is one of the trait's selectable levels.
 * @param {object} spec - Trait spec.
 * @param {unknown} level - Candidate.
 * @returns {boolean} True for a level on the grid.
 */
export function isTraitLevel(spec, level) {
  if (typeof level !== 'number' || !Number.isFinite(level)) return false;
  if (level < spec.min - 1e-9 || level > spec.max + 1e-9) return false;
  const steps = (level - spec.min) / spec.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/**
 * Whether a confidence passes the auto-effect thresholds.
 * @param {object} spec - Trait spec.
 * @param {number} confidence - Posterior confidence.
 * @returns {{ allowed: boolean, band: 'active' | 'soft' | 'default' }} Gate result.
 */
export function gateConfidence(spec, confidence) {
  if (!Number.isFinite(confidence)) return { allowed: false, band: 'default' };
  if (confidence >= ACTIVE_CONFIDENCE - 1e-9) return { allowed: true, band: 'active' };
  if (confidence >= SOFT_CONFIDENCE - 1e-9 && SOFT_TRAITS.includes(spec.key)) return { allowed: true, band: 'soft' };
  return { allowed: false, band: 'default' };
}

/**
 * Human description of one level, stored as the trait item's text.
 * @param {string} key - Trait key.
 * @param {number} level - Level on the trait grid.
 * @returns {string} One short sentence for the student.
 */
export function behaviorText(key, level) {
  const steps = {
    explain_detail: {
      1: '先给结论，只走 1 步关键推导',
      2: '先给结论，再补关键推导',
      3: '结论 + 推导 + 1 个例子',
      4: '首讲偏详细：补前置 + 推导 + 例子',
      5: '首讲很详细：前置确认 + 定义 + 动机 + 推导 + 例子 + 易错点',
    },
    hint_preference: {
      0: '先给下一步提示，不直接给答案',
      0.5: '先给提示，再给答案',
      1: '先给答案，再补提示',
    },
    pace: {
      '-1': '推进速度偏慢，多确认',
      0: '推进速度正常',
      1: '推进速度偏快，少停留',
    },
    example_first: {
      0: '先给定义，再举例',
      0.5: '推导中穿插例子',
      1: '例子优先，先例后定义',
    },
    step_granularity: {
      1: '合并推导步骤',
      2: '关键步骤分点',
      3: '一步一编号，每步不超过两句',
    },
    check_frequency: {
      0: '讲完再确认',
      1: '讲完一段确认一次',
      2: '每 2 步确认一次',
    },
  };
  return steps[key]?.[String(level)] ?? `${TRAIT_LABELS[key] ?? key}：${level}`;
}

/**
 * Read the value of one stored trait item, falling back to its level.
 * @param {object} spec - Trait spec.
 * @param {object} item - Stored item.
 * @returns {{ value: number, level: number }} Stored parameters.
 */
export function storedTraitValue(spec, item) {
  const stored = item.value;
  const value = stored !== null && typeof stored === 'object' && Number.isFinite(stored.value) ? stored.value : 0.5;
  const level = stored !== null && typeof stored === 'object' && Number.isFinite(stored.level)
    ? stored.level
    : levelOf(spec, value);
  return { value, level };
}

/**
 * Derive explain_detail evidence from the learning tables.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, now: Date }} options - Scope and clock.
 * @returns {Array<{ refKind: 'problem' | 'episode', refId: string, at: string, weight: number, positive: boolean, episodeId: string }>}
 *   Evidence rows with decayed weights.
 */
export function deriveExplainEvidence(db, { goalId, now }) {
  if (!tableExists(db, 'study_episode') || !tableExists(db, 'study_episode_problem')) return [];
  const evidence = [];
  const reasks = db.all(
    `SELECT p.id AS problem_id, p.episode_id AS episode_id, p.created_at AS at, orig.created_at AS original_at
       FROM study_episode_problem p
       JOIN study_episode_problem orig ON orig.id = p.reasked_from
       JOIN study_episode e ON e.id = p.episode_id
      WHERE e.goal_id = ? AND e.status <> 'merged' AND e.merged_into IS NULL
      ORDER BY p.created_at ASC`,
    goalId,
  );
  for (const row of reasks) {
    const at = String(row.at);
    const originalAt = String(row.original_at);
    const ageDays = ageInDays(now, at);
    const gapDays = (Date.parse(at) - Date.parse(originalAt)) / DAY_MS;
    if (!(gapDays <= REASK_WINDOW_DAYS)) continue;
    evidence.push({
      refKind: 'problem',
      refId: String(row.problem_id),
      at,
      weight: REASK_WEIGHT * decay(ageDays),
      positive: true,
      episodeId: String(row.episode_id),
    });
  }
  const closures = db.all(
    `SELECT e.id, COALESCE(e.closed_at, e.updated_at) AS at,
            (SELECT COUNT(*) FROM study_signal s WHERE s.episode_id = e.id AND s.kind = 'confused') AS confused,
            (SELECT COUNT(*) FROM study_episode_problem p WHERE p.episode_id = e.id) AS problems,
            (SELECT COALESCE(SUM(p.reask_count), 0) FROM study_episode_problem p WHERE p.episode_id = e.id) AS reasked
       FROM study_episode e
      WHERE e.goal_id = ? AND e.status <> 'merged' AND e.merged_into IS NULL AND e.resolution = 'understood'`,
    goalId,
  );
  for (const row of closures) {
    if (Number(row.confused) > 0 || Number(row.reasked) > 0 || Number(row.problems) === 0) continue;
    const at = String(row.at);
    const ageDays = ageInDays(now, at);
    evidence.push({
      refKind: 'episode',
      refId: String(row.id),
      at,
      weight: CLEAN_CLOSURE_WEIGHT * decay(ageDays),
      positive: false,
      episodeId: String(row.id),
    });
  }
  evidence.sort((left, right) => left.at.localeCompare(right.at));
  return evidence;
}

/**
 * Aggregate evidence into Beta parameters and confidence.
 * @param {Array<{ weight: number, at: string, episodeId: string, positive: boolean }>} evidence - Derivation.
 * @param {Date} now - Clock (kept for symmetry; weights are already decayed).
 * @returns {{ value: number, confidence: number, alpha: number, beta: number, positive: number, negative: number,
 *   totalWeight: number, units: number, spanDays: number, latestAt: string | null, evidenceCount: number }} Statistics.
 */
export function computeStats(evidence, now) {
  let positive = 0;
  let negative = 0;
  for (const entry of evidence) {
    if (entry.positive) positive += entry.weight;
    else negative += entry.weight;
  }
  const alpha = 1 + positive;
  const beta = 1 + negative;
  const value = alpha / (alpha + beta);
  const totalWeight = positive + negative;
  const confidence = 1 - Math.sqrt((value * (1 - value)) / (alpha + beta + totalWeight + 1));
  const units = new Set(evidence.map(entry => entry.episodeId)).size;
  const times = evidence.map(entry => Date.parse(entry.at)).filter(Number.isFinite).sort((left, right) => left - right);
  const spanDays = times.length < 2 ? 0 : (times.at(-1) - times[0]) / DAY_MS;
  const latestAt = times.length === 0 ? null : new Date(times.at(-1)).toISOString();
  return {
    value,
    confidence,
    alpha,
    beta,
    positive,
    negative,
    totalWeight,
    units,
    spanDays,
    latestAt,
    evidenceCount: evidence.length,
    evidence,
  };
}

/**
 * Decide the effective level of one trait from current evidence and the stored
 * version.
 * @param {{
 *   spec: object,
 *   stats: ReturnType<typeof computeStats>,
 *   current: object | undefined,
 *   now: Date,
 * }} options - Decision inputs.
 * @returns {{ level: number, active: boolean, reason: string, desired?: number, confidence: number, sourceKind: string | null }}
 *   Effective level and why.
 */
export function decideTrait({ spec, stats, current, now }) {
  if (current !== undefined && current.sourceKind === 'user_edit') {
    const stored = storedTraitValue(spec, current);
    return { level: stored.level, active: true, reason: 'user', confidence: 1, sourceKind: 'user_edit' };
  }
  const needsColdStart = spec.sensitive && (current === undefined || current.sourceKind !== 'inferred');
  return evaluateAutoTrait({ spec, stats, current, now, needsColdStart });
}

/**
 * Decide the inferred level without the user-edit shortcut.
 * @param {{
 *   spec: object,
 *   stats: ReturnType<typeof computeStats>,
 *   current: object | undefined,
 *   now: Date,
 *   needsColdStart?: boolean,
 * }} options - Decision inputs; a user correction passes no current item here.
 * @returns {{ level: number, active: boolean, reason: string, desired?: number, confidence: number, sourceKind: string | null }}
 *   Effective level and why.
 */
export function evaluateAutoTrait({ spec, stats, current, now, needsColdStart = spec.sensitive }) {
  const currentStored = current === undefined ? undefined : storedTraitValue(spec, current);
  const currentLevel = currentStored?.level;
  const hasEvidence = stats.totalWeight > 0;
  let desired = spec.defaultLevel;
  let active = false;
  let reason = 'default';

  if (hasEvidence) {
    const fresh = stats.latestAt !== null && ageInDays(now, stats.latestAt) <= EVIDENCE_TTL_DAYS;
    if (!fresh) {
      reason = 'decay';
    } else {
      const gate = gateConfidence(spec, stats.confidence);
      if (!gate.allowed) {
        reason = 'threshold';
      } else {
        // A clean closure is negative evidence; keep the inferred detail at or
        // above the default so a student who needs no re-asks is never given
        // terser explanations than the baseline.
        const minimum = spec.key === 'explain_detail' ? spec.defaultLevel : spec.min;
        desired = Math.max(minimum, levelOf(spec, stats.value));
        if (needsColdStart && (stats.units < SENSITIVE_MIN_UNITS || stats.spanDays < SENSITIVE_MIN_SPAN_DAYS)) {
          desired = spec.defaultLevel;
          reason = 'cold_start';
        } else {
          active = true;
          reason = gate.band === 'soft' ? 'auto_soft' : 'auto';
        }
      }
    }
  }

  if (!active) {
    return { level: spec.defaultLevel, active: false, reason, desired: spec.defaultLevel, confidence: stats.confidence, sourceKind: null };
  }
  if (current !== undefined && currentLevel !== undefined && desired !== currentLevel) {
    const changedAt = Date.parse(current.validFrom);
    if (Number.isFinite(changedAt) && now.getTime() - changedAt < WEEK_MS) {
      return { level: currentLevel, active: true, reason: 'weekly_limit', desired, confidence: stats.confidence, sourceKind: 'inferred' };
    }
    const direction = Math.sign(desired - currentLevel);
    const next = roundLevel(Math.min(spec.max, Math.max(spec.min, currentLevel + direction * spec.step)));
    return {
      level: next,
      active: true,
      reason: next === desired ? reason : 'step_limited',
      desired,
      confidence: stats.confidence,
      sourceKind: 'inferred',
    };
  }
  return { level: desired, active: true, reason, desired, confidence: stats.confidence, sourceKind: 'inferred' };
}

/**
 * Evaluate one trait against the stored version and the live learning tables.
 * @param {{
 *   db: import('../db.mjs').StudyDatabase,
 *   spec: object,
 *   goalId: string,
 *   now: Date,
 * }} options - Evaluation inputs.
 * @returns {{ current: object | undefined, stats: ReturnType<typeof computeStats>, decision: ReturnType<typeof decideTrait> }}
 *   Current item, statistics, and effective decision.
 */
export function evaluateTrait({ db, spec, goalId, now }) {
  const current = currentItemByKey(db, { goalId, kind: 'trait', key: spec.key });
  let evidence = spec.inferred ? deriveExplainEvidence(db, { goalId, now }) : [];
  if (current !== undefined && current.sourceKind === 'user_edit') {
    const cutoff = Date.parse(current.updatedAt);
    evidence = evidence.filter(entry => Date.parse(entry.at) > cutoff);
  }
  const stats = computeStats(evidence, now);
  const decision = decideTrait({ spec, stats, current, now });
  return { current, stats, decision };
}

/**
 * Effective level of every trait, for the profile page and the contract.
 * @param {{ db: object, goalId: string, now: Date }} options - Scope and clock.
 * @returns {Array<{ spec: object, level: number, defaultValue: number, active: boolean, reason: string,
 *   sourceKind: string | null, confidence: number, value: number, evidenceCount: number, unitCount: number,
 *   updatedAt: string | null, text: string, current: object | undefined }>} Six trait rows.
 */
export function evaluateAllTraits({ db, goalId, now }) {
  return TRAITS.map(spec => {
    const { current, stats, decision } = evaluateTrait({ db, spec, goalId, now });
    return {
      spec,
      level: decision.level,
      defaultValue: spec.defaultLevel,
      active: decision.active,
      reason: decision.reason,
      sourceKind: decision.sourceKind ?? current?.sourceKind ?? null,
      confidence: decision.confidence,
      value: decision.sourceKind === 'user_edit'
        ? valueOfLevel(spec, decision.level)
        : stats.value,
      evidenceCount: stats.evidenceCount,
      unitCount: stats.units,
      updatedAt: current?.updatedAt ?? null,
      text: behaviorText(spec.key, decision.level),
      current,
    };
  });
}

/**
 * Compile the per-turn teaching contract.
 * @param {{
 *   traits: ReturnType<typeof evaluateAllTraits>,
 *   memories: Array<{ kind: string, text: string, expiresAt?: string | null }>,
 *   maxMemories?: number,
 * }} options - Effective traits and eligible v1 memories.
 * @returns {string} Contract text, the v1 snapshot fallback, or '' when empty.
 */
export function compileContract({ traits, memories, maxMemories = 8 }) {
  const clauses = traits
    .filter(trait => trait.active && trait.level !== trait.defaultValue)
    .map(trait => clauseOf(trait.spec, trait.level));
  if (clauses.length === 0) return renderV1Snapshot(memories, maxMemories);
  const lines = [
    '【讲解契约】',
    `${clauses.join('；')}。`,
    '这是讲解假设，不是评价；不要复述本段，也不要据此降低任务要求。',
  ];
  if (memories.length > 0) {
    lines.push('', '【相关记忆】');
    for (const memory of memories.slice(0, maxMemories)) {
      lines.push(`- ${memoryLabel(memory.kind)}：${memory.text}${memory.expiresAt ? `（到 ${memory.expiresAt.slice(0, 10)} 失效）` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render the v1 snapshot format used when no trait is effective.
 * @param {Array<{ kind: string, text: string, expiresAt?: string | null }>} memories - Eligible memories.
 * @param {number} maxMemories - Item cap.
 * @returns {string} Snapshot text, or '' when there is nothing to inject.
 */
export function renderV1Snapshot(memories, maxMemories = 8) {
  if (memories.length === 0) return '';
  return [
    '以下是学生明确表达过、或尚未过期的学习记忆（不是计划或完成量；计划与完成数据以学习服务为准）。',
    ...memories.slice(0, maxMemories).map(memory => `- [${memoryLabel(memory.kind)}] ${memory.text}${memory.expiresAt ? `（到 ${memory.expiresAt.slice(0, 10)} 失效）` : ''}`),
    '需要更完整的内容或纠正/删除时使用 memory_recall、memory_remember、memory_forget。',
  ].join('\n');
}

/**
 * One clause of the contract for a non-default trait level.
 * @param {object} spec - Trait spec.
 * @param {number} level - Effective level.
 * @returns {string} Short constraint.
 */
export function clauseOf(spec, level) {
  switch (spec.key) {
    case 'explain_detail':
      return `详细度 ${level}/5（${DETAIL_CONSTRAINTS[level] ?? '结论 + 推导'}）`;
    case 'hint_preference':
      if (level === 0) return '解题先给下一步提示';
      if (level === 1) return '解题先给答案再补提示';
      return '解题先给提示再给答案';
    case 'pace':
      if (level === -1) return '推进速度偏慢';
      if (level === 1) return '推进速度偏快';
      return '推进速度正常';
    case 'example_first':
      if (level === 0) return '先给定义再举例';
      if (level === 1) return '例子优先，先例后定义';
      return '推导中穿插例子';
    case 'step_granularity':
      if (level === 1) return '合并推导步骤';
      if (level === 3) return '一步一编号，每步不超过两句';
      return '关键步骤分点';
    case 'check_frequency':
      if (level === 0) return '讲完再确认';
      if (level === 2) return '每 2 步确认一次';
      return '讲完一段确认一次';
    default:
      return `${TRAIT_LABELS[spec.key] ?? spec.key} ${level}`;
  }
}

/**
 * Decay factor of one evidence weight.
 * @param {number} ageDays - Evidence age in days.
 * @returns {number} Multiplier in (0, 1].
 */
export function decay(ageDays) {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return 0.5 ** (ageDays / EVIDENCE_TTL_DAYS);
}

/**
 * Full days between an instant and the clock; future instants count as zero.
 * @param {Date} now - Clock.
 * @param {string} at - ISO instant.
 * @returns {number} Non-negative days.
 */
export function ageInDays(now, at) {
  const millis = Date.parse(at);
  if (!Number.isFinite(millis)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - millis) / DAY_MS);
}

/**
 * Round a level to six decimals so 0.5 and 0.30000000000000004 compare equal.
 * @param {number} value - Candidate level.
 * @returns {number} Rounded level.
 */
export function roundLevel(value) {
  return Number(value.toFixed(6));
}

function memoryLabel(kind) {
  return { preference: '偏好', state: '短期状态', observation: '观察（待确认）' }[kind] ?? kind;
}

function tableExists(db, name) {
  return db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name) !== undefined;
}
