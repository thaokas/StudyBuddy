/**
 * Shared fixtures for the T10 onboarding and plan page tests.
 *
 * The pages are imported after `installReactStub()` so their React imports
 * resolve to the plain element tree in `tests/client/support/react-stub.mjs`.
 * Dictionaries come from the shipped message modules, so a missing key fails
 * the test instead of silently rendering the key name.
 */
import { mergeMessages } from '../../../../packages/study-client/definitions.js';

/**
 * Load the dictionaries the two pages share.
 * @returns {Promise<{ en: object, zh: object }>} Merged dictionary.
 */
export async function loadDictionary() {
  const common = (await import('../../../../packages/study-messages/common.js')).default;
  const onboarding = (await import('../../client/messages/onboarding.js')).default;
  const plan = (await import('../../client/messages/plan.js')).default;
  return mergeMessages([
    { file: 'common', dictionary: common },
    { file: 'onboarding', dictionary: onboarding },
    { file: 'plan', dictionary: plan },
  ]);
}

/**
 * Build a translator over one merged dictionary.
 * @param {{ en: object, zh: object }} dictionary - Merged dictionary.
 * @param {'en' | 'zh'} locale - Active locale.
 * @returns {(key: string, params?: object) => string} Translator that reports a missing key as its name.
 */
export function translatorFor(dictionary, locale) {
  return (key, params) => {
    const template = dictionary[locale][key] ?? dictionary.en[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

/** Record every element as a plain node so the tree can be walked. */
export const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });

/** Collect the text of one rendered tree. */
export function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.children);
}

/** Find one element by predicate. */
export function find(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = find(child, predicate);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = find(child, predicate);
    if (match !== undefined) return match;
  }
  return undefined;
}

/** Find every element by predicate. */
export function findAll(node, predicate) {
  const matches = [];
  if (node === null || typeof node !== 'object') return matches;
  if (Array.isArray(node)) {
    for (const child of node) matches.push(...findAll(child, predicate));
    return matches;
  }
  if (predicate(node)) matches.push(node);
  for (const child of node.children) matches.push(...findAll(child, predicate));
  return matches;
}

/** Find one element by its `data-testid`. */
export function byTestId(node, testId) {
  return find(node, entry => entry.props?.['data-testid'] === testId);
}

/** Find every element with one tag name. */
export function byTag(node, tag) {
  return findAll(node, entry => entry.type === tag);
}

/**
 * Web Storage stand-in with the three methods the pages use.
 * @param {Record<string, string>} [seed] - Initial values.
 * @returns {object} Storage area plus `dump()`.
 */
export function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump() { return Object.fromEntries(values); },
  };
}

/** A complete goal summary with nothing missing. */
export const GOAL = Object.freeze({
  id: 'goal_1',
  exam: 'Postgraduate mathematics',
  examYear: 2027,
  deadline: '2027-12-20',
  dailyMinutes: 120,
  note: null,
  active: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  missing: [],
});

/** A goal saved with only the exam name, as the minimal onboarding path allows. */
export const GOAL_PARTIAL = Object.freeze({
  ...GOAL,
  examYear: null,
  deadline: null,
  dailyMinutes: null,
  missing: ['examYear', 'deadline', 'dailyMinutes'],
});

/** One imported material with a provenance gap. */
export const MATERIAL = Object.freeze({
  id: 'material_1',
  goalId: 'goal_1',
  kind: 'workbook',
  title: 'Calculus workbook',
  edition: null,
  subject: 'Mathematics',
  format: 'text',
  source: { kind: 'file', ref: 'D:/study/calculus.txt', date: '2026-11-08' },
  verification: 'verified',
  missing: ['edition', 'toc'],
  toc: [],
  chunkCount: 12,
  pages: { known: 3, unknown: 0, min: 1, max: 3 },
  deletedAt: null,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
});

/** One plan item with a material source whose page number is unverified. */
export const ITEM = Object.freeze({
  id: 'item_1',
  title: 'Chapter 2 exercises 1-10',
  subject: null,
  materialId: 'material_1',
  locator: { chapter: 'chapter 2', page: null, exercise: null, unverified: ['page'] },
  estimateMinutes: 60,
  date: '2026-11-11',
  start: '19:00',
  end: '20:00',
  flexible: true,
  completion: 'Finish and correct every mistake',
  dependencies: [],
  projectId: 'proj_1',
  note: null,
  source: 'student',
});

/** One project grouping plan tasks; it never schedules a time by itself. */
export const PROJECT = Object.freeze({
  id: 'proj_1',
  title: 'Calculus workbook',
  kind: 'workbook',
  materialId: 'material_1',
  target: 'Finish chapters 1-4',
  note: null,
});

/** A second project without a material citation. */
export const PROJECT_B = Object.freeze({
  id: 'proj_2',
  title: 'Chapter study',
  kind: 'chapter',
  materialId: null,
  target: null,
  note: null,
});

/** A plan document with projects, stage goals, week goals and one scheduled item. */
export const PLAN_DATA = Object.freeze({
  title: 'Mathematics study plan',
  goalId: 'goal_1',
  trial: false,
  reviewAt: null,
  projects: [PROJECT, PROJECT_B],
  stageGoals: [{ id: 'stage_1', title: 'Finish calculus', dueDate: '2027-01-31', target: 'Two rounds', note: null }],
  weekGoals: [{ id: 'week_1', weekStart: '2026-11-09', title: 'Chapter 2', target: 'Exercises 1-20', note: null }],
  availability: [{ date: '2026-11-11', minutes: 120, note: null }],
  constraints: [],
  assumptions: [],
  items: [ITEM],
});

/** An unconfirmed draft with one extra item and one removed item compared with `PLAN_DATA`. */
export const DRAFT_DATA = Object.freeze({
  ...PLAN_DATA,
  title: 'Mathematics study plan v2',
  items: [
    { ...ITEM, id: 'item_2', title: 'Chapter 3 preview', date: null, start: null, end: null, estimateMinutes: 30, projectId: 'proj_2' },
  ],
});

/** A capacity report for the draft, with unknown availability on one day. */
export const CAPACITY = Object.freeze({
  date: '2026-11-10',
  verdict: 'partial',
  requiresTrial: false,
  days: [
    {
      date: '2026-11-11',
      availabilitySource: 'declared',
      availableMinutes: 120,
      scheduledMinutes: 60,
      remainingMinutes: 60,
      itemCount: 1,
      itemIds: ['item_1'],
      overlaps: [],
    },
    {
      date: '2026-11-12',
      availabilitySource: 'unknown',
      availableMinutes: null,
      scheduledMinutes: 0,
      remainingMinutes: null,
      itemCount: 0,
      itemIds: [],
      overlaps: [],
    },
  ],
  unscheduled: { count: 1, minutes: 30, items: [{ id: 'item_2', title: 'Chapter 3 preview', estimateMinutes: 30 }] },
  totals: {
    itemCount: 2,
    scheduledItemCount: 1,
    unscheduledItemCount: 1,
    plannedMinutes: 90,
    availableMinutes: 120,
    scheduledMinutes: 60,
    unscheduledMinutes: 30,
    shortfallMinutes: 0,
    overlapMinutes: 0,
    unknownDays: 1,
  },
  conflicts: [],
  risks: [],
  goal: { id: 'goal_1', dailyMinutes: 120, deadline: '2027-12-20' },
});

/** One applied revision view as `plans.get` returns it. */
export function revisionView(overrides = {}) {
  return {
    id: 'revision_1',
    number: 1,
    status: 'applied',
    action: 'confirm',
    reason: 'Initial confirmation',
    actor: 'student',
    trial: false,
    reviewAt: null,
    createdAt: '2026-11-10T01:00:00.000Z',
    appliedAt: '2026-11-10T01:00:00.000Z',
    undoneBy: null,
    diff: {
      baseRevision: 0,
      revision: 1,
      added: [{ id: 'item_1', title: 'Chapter 2 exercises 1-10', date: '2026-11-11', estimateMinutes: 60 }],
      removed: [],
      changed: [],
      titleChanged: false,
      goalChanged: false,
      trialChanged: false,
      goalsChanged: true,
      availabilityChanged: true,
      unscheduledChanged: false,
      totals: { beforeItems: 0, afterItems: 1, beforeMinutes: 0, afterMinutes: 60, beforeUnscheduled: 0, afterUnscheduled: 0 },
    },
    data: PLAN_DATA,
    ...overrides,
  };
}

/** One `plans.get` value with a formal plan and no draft. */
export function planGet(overrides = {}) {
  const applied = revisionView();
  return {
    plan: {
      id: 'plan_1',
      goalId: 'goal_1',
      title: PLAN_DATA.title,
      status: 'active',
      revision: 1,
      trial: false,
      reviewAt: null,
      hasDraft: false,
      createdAt: '2026-11-10T01:00:00.000Z',
      updatedAt: '2026-11-10T01:00:00.000Z',
      appliedRevision: { id: applied.id, number: 1, reason: applied.reason, appliedAt: applied.appliedAt },
      counts: { items: 1, projects: 2, scheduledItems: 1, unscheduledItems: 0, minutes: 60, unscheduledMinutes: 0 },
    },
    applied,
    draft: null,
    capacity: {
      ...CAPACITY,
      days: [CAPACITY.days[0]],
      unscheduled: { count: 0, minutes: 0, items: [] },
      totals: { ...CAPACITY.totals, itemCount: 1, scheduledItemCount: 1, unscheduledItemCount: 0, plannedMinutes: 60, unscheduledMinutes: 0, unknownDays: 0 },
    },
    progress: {
      planId: 'plan_1',
      revision: 1,
      itemCount: 1,
      counts: { unrecorded: 1, notStarted: 0, inProgress: 0, partial: 0, done: 0, cancelled: 0, pendingConfirmation: 0 },
      minutes: { planned: 60, scheduled: 60, unscheduled: 0, doneEstimate: 0, cancelledEstimate: 0 },
      completion: { countedItems: 1, completedItems: 0, cancelledItems: 0, pendingItems: 0, note: 'Cancelled items stay out; unrecorded is not "did not study".' },
    },
    revisions: [applied],
    notice: null,
    ...overrides,
  };
}

/** One draft view as `plans.get` returns it. */
export function draftView(overrides = {}) {
  return {
    id: 'draft_1',
    draftRevision: 1,
    baseRevision: 1,
    reason: null,
    actor: 'student',
    createdAt: '2026-11-10T02:00:00.000Z',
    updatedAt: '2026-11-10T02:00:00.000Z',
    data: DRAFT_DATA,
    ...overrides,
  };
}
