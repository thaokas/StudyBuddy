/**
 * Milestones, lightweight completion feedback, and week/month stage summaries.
 *
 * The module owns no tables and adds no model tool. Everything it returns is
 * derived from the read-only `outcomes` service, which in turn recomputes from
 * the student's append-only records. Three rules shape the output:
 *
 * - **Only real records count.** A milestone is counted from items the
 *   outcomes document reports as `done` with `confirmed: true`; a cancellation,
 *   a pending record, or "no record yet" can never earn one. Every earned
 *   milestone carries the record ids, record dates, and titles it was counted
 *   from, so the wording can always be checked against stored facts.
 * - **Encouragement without inference.** The copy states counts and dates that
 *   exist in the records. It never claims effort, consistency, progress, or a
 *   reason for a gap, and it never treats "unrecorded" as "not studied".
 * - **No streak pressure.** Consecutive-day tracking, streak resets, and
 *   penalties for missing a day are explicitly absent (`streak.tracked` is
 *   false, `streak.penalty` is false, `streak.consecutive` is null). There is
 *   no badge economy, ranking, or social sharing either.
 *
 * `feedback` is the cheap read the client polls locally after a completion:
 * one day of outcomes, filtered to confirmed completions. It calls no model,
 * so feedback and existing milestones keep working offline.
 */
import { StudyError, isPlainObject } from '../registry.mjs';

/** Module id; matches the `milestones` service namespace. */
export const id = 'milestones';

/** Every number is derived from the outcomes statistics module. */
export const deps = ['outcomes'];

/** No tables: milestones are a view over existing append-only facts. */
export const schema = [];

/** Schema version for a schema-less module (never recorded). */
export const schemaVersion = 1;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A milestone metric: confirmed done work units. */
const METRIC_DONE = 'confirmed_done';
/** A milestone metric: confirmed done plan items. */
const METRIC_PLAN = 'confirmed_plan_done';
/** A milestone metric: distinct library materials with a confirmed done record. */
const METRIC_MATERIAL = 'confirmed_material_done';

/**
 * The fixed catalog. `threshold` is the number of counted records needed; the
 * client dictionary carries one title per id, and the Chinese `title` here is
 * the service-side fallback/Agent copy. `label` names the counted unit in the
 * "not yet reached" sentence.
 */
const CATALOG = Object.freeze([
  { id: 'week.first', period: 'week', metric: METRIC_DONE, threshold: 1, title: '本周第一条完成记录', label: '条已确认完成记录' },
  { id: 'week.three', period: 'week', metric: METRIC_DONE, threshold: 3, title: '本周完成 3 项', label: '条已确认完成记录' },
  { id: 'week.five', period: 'week', metric: METRIC_DONE, threshold: 5, title: '本周完成 5 项', label: '条已确认完成记录' },
  { id: 'week.plan', period: 'week', metric: METRIC_PLAN, threshold: 1, title: '本周完成计划条目', label: '条计划条目完成记录' },
  { id: 'week.material', period: 'week', metric: METRIC_MATERIAL, threshold: 1, title: '本周完成记录关联材料', label: '份有关联材料的完成记录' },
  { id: 'month.first', period: 'month', metric: METRIC_DONE, threshold: 1, title: '本月第一条完成记录', label: '条已确认完成记录' },
  { id: 'month.ten', period: 'month', metric: METRIC_DONE, threshold: 10, title: '本月完成 10 项', label: '条已确认完成记录' },
  { id: 'month.twenty', period: 'month', metric: METRIC_DONE, threshold: 20, title: '本月完成 20 项', label: '条已确认完成记录' },
  { id: 'month.plan', period: 'month', metric: METRIC_PLAN, threshold: 3, title: '本月完成 3 条计划条目', label: '条计划条目完成记录' },
  { id: 'month.material', period: 'month', metric: METRIC_MATERIAL, threshold: 2, title: '本月完成记录关联 2 份材料', label: '份有关联材料的完成记录' },
].map(entry => Object.freeze(entry)));

/** Explicit no-streak policy returned with every overview. */
const STREAK_POLICY = Object.freeze({
  tracked: false,
  penalty: false,
  consecutive: null,
  resetOnMiss: false,
  text: '不计算连续打卡，也不会因为中断而扣分或清零。',
});

/** Features this module deliberately does not build. */
const PRODUCT_POLICY = Object.freeze({
  badges: false,
  ranking: false,
  sharing: false,
  streakPenalty: false,
  note: '里程碑只引用已存在的记录；不做徽章、排行或社交分享。',
});

/**
 * Register the read-only `milestones` service. No Agent tool is registered:
 * the client polls it locally, and the Agent can read it through `ctx.study`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `study`.
 * @param {{ database: object }} [kernel] - Kernel handle (unused; reads go through calls).
 */
export function apply(ctx, kernel) {
  ctx.effect(() => ctx.study.register('milestones', {
    methods: {
      feedback,
      overview,
    },
    writes: [],
  }), 'study: milestones namespace');
}

// ---------------------------------------------------------------------------
// Date helpers (same local calendar as the tasks and outcomes modules)
// ---------------------------------------------------------------------------

/** Validate one `YYYY-MM-DD` local date. */
function validDateText(text) {
  if (typeof text !== 'string') return false;
  const match = DATE_PATTERN.exec(text);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function requireDate(value, field) {
  if (typeof value !== 'string' || !validDateText(value.trim())) {
    throw invalid(`${field} 必须是有效日期 YYYY-MM-DD`, { field });
  }
  return value.trim();
}

function optionalDate(value, field) {
  if (value === undefined || value === null) return null;
  return requireDate(value, field);
}

function invalid(message, details = {}) {
  return new StudyError('invalid', message, details);
}

function unavailable(message, details = {}) {
  return new StudyError('unavailable', message, details);
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

/**
 * Lightweight feedback feed: today's confirmed completions, oldest first.
 * `token` is stable per stored progress row (`<kind>:<recordId>`), so the client
 * can remember what it already announced without guessing.
 * @param {{ date?: string }} payload - Optional local date (defaults to today).
 * @param {object} api - Kernel call context (`kernel`, `today`, `now`).
 * @returns {Promise<object>} Feedback document.
 */
async function feedback(payload, api) {
  const date = optionalDate(payload.date, 'date') ?? api.today();
  const day = await readOutcome(api, 'day', { date, ...(payload.goalId === undefined ? {} : { goalId: payload.goalId }) });
  const items = collectDone(day.items).map(toFeedbackItem);
  return {
    scope: 'day',
    date,
    today: api.today(),
    state: typeof day.state === 'string' ? day.state : null,
    notice: day.notice ?? null,
    count: items.length,
    items,
    latest: items.length === 0 ? null : items[items.length - 1],
    generatedAt: api.now().toISOString(),
  };
}

/**
 * Week and month stage summary plus every milestone of the period.
 * @param {{ date?: string }} payload - Optional local date (defaults to today).
 * @param {object} api - Kernel call context (`kernel`, `today`, `now`).
 * @returns {Promise<object>} Overview document.
 */
async function overview(payload, api) {
  const date = optionalDate(payload.date, 'date') ?? api.today();
  const week = await readOutcome(api, 'week', { date, ...(payload.goalId === undefined ? {} : { goalId: payload.goalId }) });
  const month = await readOutcome(api, 'month', { date, ...(payload.goalId === undefined ? {} : { goalId: payload.goalId }) });
  return {
    date,
    today: api.today(),
    week: buildStage('week', week),
    month: buildStage('month', month),
    streak: { ...STREAK_POLICY },
    policy: { ...PRODUCT_POLICY },
    generatedAt: api.now().toISOString(),
  };
}

/**
 * Read one outcomes period, translating a missing/broken statistics service
 * into a failure the caller can surface instead of an empty period.
 * @param {object} api - Kernel call context.
 * @param {'day'|'week'|'month'} method - Outcomes method.
 * @param {{ date: string }} payload - Period anchor.
 * @returns {Promise<object>} Outcomes document.
 * @throws {StudyError} `invalid` for a bad date, `unavailable` for a missing or failing service.
 */
async function readOutcome(api, method, payload) {
  const envelope = await api.kernel.call('outcomes', method, payload);
  if (envelope.ok === true) {
    if (!isPlainObject(envelope.value)) {
      throw unavailable('统计服务返回了无法识别的结果，暂时无法计算里程碑', { service: 'outcomes', method });
    }
    return envelope.value;
  }
  if (envelope.code === 'invalid') {
    throw new StudyError('invalid', envelope.message, envelope.details ?? {});
  }
  throw unavailable('统计服务暂时不可用，无法计算里程碑', {
    service: 'outcomes',
    method,
    code: envelope.code,
    message: envelope.message,
  });
}

// ---------------------------------------------------------------------------
// Stage summary
// ---------------------------------------------------------------------------

/**
 * Build one week or month stage document.
 * @param {'week'|'month'} period - Period kind.
 * @param {object} outcome - Outcomes document for the period.
 * @returns {object} Stage summary with lines, milestones, and evidence.
 */
function buildStage(period, outcome) {
  const items = Array.isArray(outcome.items) ? outcome.items : null;
  if (items === null || !isPlainObject(outcome.completion) || typeof outcome.from !== 'string' || typeof outcome.to !== 'string') {
    throw unavailable('统计结果缺少所需的计划或记录字段，暂时无法生成阶段小结', {
      service: 'outcomes',
      method: period,
    });
  }
  const collected = collectRecords(items);
  const milestones = CATALOG
    .filter(entry => entry.period === period)
    .map(entry => buildMilestone(entry, collected, outcome));
  const earned = milestones.filter(milestone => milestone.achieved);
  const upcoming = milestones.find(milestone => !milestone.achieved) ?? null;
  const adjusted = isPlainObject(outcome.completion.adjusted) ? outcome.completion.adjusted : {};
  const original = isPlainObject(outcome.completion.original) ? outcome.completion.original : {};
  const outcomeCounts = isPlainObject(outcome.counts) ? outcome.counts : {};
  const outcomeMaterials = isPlainObject(outcome.materials) ? outcome.materials : {};
  const counts = {
    totalUnits: countOf(outcomeCounts.totalUnits),
    planned: countOf(adjusted.planned),
    completed: countOf(adjusted.completed),
    cancelled: countOf(adjusted.cancelled),
    pending: countOf(adjusted.pending),
    unrecorded: countOf(adjusted.unrecorded),
    recorded: countOf(outcomeCounts.recorded),
    plannedRecorded: countOf(adjusted.recorded),
    rate: adjusted.rate === null || adjusted.rate === undefined ? null : Number(adjusted.rate),
    originalPlanned: countOf(original.planned),
    originalCompleted: countOf(original.completed),
    originalRate: original.rate === null || original.rate === undefined ? null : Number(original.rate),
    unplanned: countOf(outcomeCounts.unplanned),
  };
  const materials = {
    advancedItemCount: countOf(outcomeMaterials.advancedItemCount),
    distinctMaterialCount: countOf(outcomeMaterials.distinctMaterialCount),
    titles: materialTitles(outcomeMaterials.items),
  };
  return {
    period,
    from: outcome.from,
    to: outcome.to,
    scope: typeof outcome.scope === 'string' ? outcome.scope : period,
    state: typeof outcome.state === 'string' ? outcome.state : null,
    notice: outcome.notice ?? null,
    headline: headlineFor(period, counts, outcomeCounts),
    lines: buildLines(period, counts, materials),
    milestones,
    earned,
    earnedCount: earned.length,
    next: upcoming === null ? null : {
      id: upcoming.id,
      period: upcoming.period,
      title: upcoming.title,
      threshold: upcoming.threshold,
      count: upcoming.count,
      remaining: upcoming.remaining,
    },
    counts,
    materials,
    streak: { ...STREAK_POLICY },
    source: {
      service: 'outcomes',
      method: period,
      from: outcome.from,
      to: outcome.to,
      generatedAt: typeof outcome.generatedAt === 'string' ? outcome.generatedAt : null,
    },
    generatedAt: typeof outcome.generatedAt === 'string' ? outcome.generatedAt : null,
  };
}

/** Stable count: a finite non-negative safe integer, otherwise 0. */
function countOf(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Display titles of the materials advanced in the period, bounded to five. */
function materialTitles(materials) {
  if (!Array.isArray(materials)) return [];
  return materials
    .map(entry => (isPlainObject(entry) ? entry.title ?? entry.materialId : null))
    .filter(title => typeof title === 'string' && title.length > 0)
    .slice(0, 5);
}

/** One-sentence headline with only counts that exist in the outcomes document. */
function headlineFor(period, counts, outcomeCounts) {
  const word = period === 'week' ? '本周' : '本月';
  if (counts.planned > 0) {
    return `${word}：计划 ${counts.planned} 项，已确认完成 ${counts.completed} 项，主动取消 ${counts.cancelled} 项。`;
  }
  const recorded = countOf(outcomeCounts.recorded);
  if (recorded > 0) return `${word}有 ${recorded} 条进度记录，没有计划项。`;
  return `${word}没有计划或进度记录。`;
}

/**
 * Evidence lines of a stage summary. Every `values` field is a number from the
 * outcomes document; the client renders localized templates over the same values.
 * @param {'week'|'month'} period - Period kind.
 * @param {object} counts - Flat counts copied from the outcomes document.
 * @param {{ advancedItemCount: number, distinctMaterialCount: number, titles: string[] }} materials - Material summary.
 * @returns {Array<{ key: string, values: object, text: string }>} Lines.
 */
function buildLines(period, counts, materials) {
  const word = period === 'week' ? '本周' : '本月';
  const lines = [];
  if (counts.planned > 0) {
    lines.push({
      key: 'planned',
      values: {
        planned: counts.planned,
        completed: counts.completed,
        cancelled: counts.cancelled,
        pending: counts.pending,
        unrecorded: counts.unrecorded,
      },
      text: `${word}计划 ${counts.planned} 项：已确认完成 ${counts.completed} 项、主动取消 ${counts.cancelled} 项、待确认 ${counts.pending} 项、未记录 ${counts.unrecorded} 项。`,
    });
    if (counts.rate === null) {
      lines.push({ key: 'noRate', values: {}, text: '没有可计算完成率的分母。' });
    } else {
      const percent = Math.round(counts.rate * 1000) / 10;
      lines.push({
        key: 'rate',
        values: { percent, completed: counts.completed, planned: counts.planned },
        text: `调整后完成率 ${percent}%（完成 ${counts.completed} / 计划 ${counts.planned}）；取消留在分母里，不抬高完成率。`,
      });
    }
  } else {
    lines.push({
      key: 'noPlanned',
      values: { unplanned: counts.unplanned },
      text: `这个周期没有计划项；有 ${counts.unplanned} 条进度记录未排计划，不计入完成率。`,
    });
  }
  lines.push({
    key: counts.originalPlanned > 0 ? 'original' : 'originalNone',
    values: { completed: counts.originalCompleted, planned: counts.originalPlanned },
    text: counts.originalPlanned > 0
      ? `原计划口径：完成 ${counts.originalCompleted} / 计划 ${counts.originalPlanned}。`
      : '原计划口径：这个周期开始时没有计划项。',
  });
  if (counts.pending > 0) {
    lines.push({ key: 'pending', values: { count: counts.pending }, text: `${counts.pending} 项是待确认，不算完成。` });
  }
  if (counts.unrecorded > 0) {
    lines.push({ key: 'unrecorded', values: { count: counts.unrecorded }, text: `${counts.unrecorded} 项还没有进度记录；未记录不等于未学习。` });
  }
  if (counts.cancelled > 0) {
    lines.push({ key: 'cancelled', values: { count: counts.cancelled }, text: `主动取消 ${counts.cancelled} 项，不计入完成。` });
  }
  if (materials.advancedItemCount > 0) {
    lines.push({
      key: 'materials',
      values: {
        items: materials.advancedItemCount,
        materials: materials.distinctMaterialCount,
        titles: materials.titles.join('、'),
      },
      text: `材料推进 ${materials.advancedItemCount} 条记录，涉及 ${materials.distinctMaterialCount} 份材料：${materials.titles.join('、')}。`,
    });
  }
  if (counts.unplanned > 0) {
    lines.push({
      key: 'unplanned',
      values: { count: counts.unplanned },
      text: `${counts.unplanned} 条进度记录没有对应计划，未计入完成率。`,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

/**
 * Collect the confirmed completions of one outcome document.
 *
 * A unit earns a milestone only when its latest record in the period is `done`
 * and confirmed by the student. Cancelled, pending, partial, in-progress, and
 * unrecorded units are absent. Materials are keyed by the library material id
 * only; a task's free-text `materialRef` is not a material record and is not
 * mapped to one.
 * @param {Array<object>} items - Outcomes item list.
 * @returns {{ done: Array<object>, planDone: Array<object>, materials: Array<object> }} Records.
 */
function collectRecords(items) {
  const done = collectDone(items);
  const planDone = done.filter(item => item.kind === 'plan' || item.planId != null);
  const byMaterial = new Map();
  for (const item of done) {
    if (item.materialId === null || item.materialId === undefined) continue;
    const materialId = String(item.materialId);
    let entry = byMaterial.get(materialId);
    if (entry === undefined) {
      entry = {
        materialId,
        title: item.materialTitle === null || item.materialTitle === undefined ? materialId : String(item.materialTitle),
        recordIds: [],
        recordDates: [],
      };
      byMaterial.set(materialId, entry);
    }
    entry.recordIds.push(item.recordId);
    if (isDateText(item.recordDate)) entry.recordDates.push(item.recordDate);
  }
  const materials = [...byMaterial.values()]
    .map(entry => {
      const recordDates = [...new Set(entry.recordDates)].sort();
      return {
        materialId: entry.materialId,
        title: entry.title,
        recordIds: [...new Set(entry.recordIds)],
        recordDates,
        recordDate: recordDates[0] ?? null,
      };
    })
    .sort((left, right) => compareText(left.title, right.title) || compareText(left.materialId, right.materialId));
  return { done, planDone, materials };
}

/** Keep only items whose latest period record is a confirmed completion. */
function collectDone(items) {
  if (!Array.isArray(items)) return [];
  const done = [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    if (item.status !== 'done' || item.confirmed !== true) continue;
    if (!Number.isSafeInteger(item.recordId) || item.recordId <= 0) continue;
    done.push(item);
  }
  return done.sort(compareDone);
}

/** Stable record order: record date, then row id, then unit key. */
function compareDone(left, right) {
  return compareText(dateText(left.recordDate) ?? '', dateText(right.recordDate) ?? '')
    || Number(left.recordId) - Number(right.recordId)
    || compareText(left.key ?? '', right.key ?? '');
}

/** Keep one record-date string, or null for a malformed date. */
function dateText(value) {
  return isDateText(value) ? value : null;
}

/** Whether a value is a local `YYYY-MM-DD` date. */
function isDateText(value) {
  return typeof value === 'string' && validDateText(value);
}

/** Code-unit text comparison; deterministic and cheap. */
function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * Build one milestone from the catalog.
 * @param {object} entry - Catalog entry.
 * @param {ReturnType<typeof collectRecords>} collected - Confirmed records.
 * @param {object} outcome - Outcomes document (for period bounds).
 * @returns {object} Milestone with counts, achieved date, wording, and evidence.
 */
function buildMilestone(entry, collected, outcome) {
  const { units, count } = metricUnits(entry.metric, collected);
  const achieved = count >= entry.threshold;
  const crossing = achieved ? units[entry.threshold - 1] : null;
  const achievedOn = crossing === null ? null : crossing.recordDate;
  const word = entry.period === 'week' ? '本周' : '本月';
  const evidence = {
    metric: entry.metric,
    count,
    threshold: entry.threshold,
    recordIds: uniqueNumbers(units.flatMap(unit => unit.recordIds ?? [unit.recordId])).slice(0, 50),
    recordDates: uniqueTexts(units.map(unit => unit.recordDate)).slice(0, 50),
    titles: uniqueTexts(units.map(unit => unit.title)).slice(0, 5),
    period: { from: outcome.from, to: outcome.to },
  };
  return {
    id: entry.id,
    period: entry.period,
    title: entry.title,
    threshold: entry.threshold,
    count,
    remaining: Math.max(0, entry.threshold - count),
    achieved,
    achievedOn,
    text: achieved
      ? achievedText(entry, word, count, crossing, units)
      : `还差 ${Math.max(0, entry.threshold - count)} ${entry.label}；当前 ${count}，目标 ${entry.threshold}。`,
    evidence,
  };
}

/** The units and count behind one metric, in stable record order. */
function metricUnits(metric, collected) {
  if (metric === METRIC_PLAN) return { units: collected.planDone, count: collected.planDone.length };
  if (metric === METRIC_MATERIAL) return { units: collected.materials, count: collected.materials.length };
  return { units: collected.done, count: collected.done.length };
}

/** Evidence-based wording for an earned milestone. */
function achievedText(entry, word, count, crossing, units) {
  if (entry.metric === METRIC_MATERIAL) {
    const titles = units.map(unit => unit.title).join('、');
    return `${word}已确认完成的记录关联到 ${count} 份资料库材料（${titles}），最早记录于 ${crossing.recordDate}。`;
  }
  const noun = entry.metric === METRIC_PLAN ? '计划条目' : '记录';
  return `${word}已确认完成 ${count} 条${noun}，第 ${entry.threshold} 条记录于 ${crossing.recordDate}。`;
}

/** Unique safe integers, preserving first appearance. */
function uniqueNumbers(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** Unique non-empty strings, preserving first appearance. */
function uniqueTexts(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** One confirmed completion as the client feedback feed sees it. */
function toFeedbackItem(item) {
  return {
    token: `${item.kind}:${item.recordId}`,
    kind: item.kind,
    recordId: item.recordId,
    recordDate: item.recordDate,
    title: item.title ?? null,
    subject: item.subject ?? null,
    taskId: item.taskId ?? null,
    planId: item.planId ?? null,
    itemId: item.itemId ?? null,
    quantityDone: item.quantityDone ?? null,
    quantityTotal: item.quantityTotal ?? null,
    materialId: item.materialId ?? null,
    materialTitle: item.materialTitle ?? null,
    materialRef: item.materialRef ?? null,
    planned: item.original === true || item.adjusted === true,
  };
}
