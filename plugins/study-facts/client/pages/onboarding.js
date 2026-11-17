/**
 * Plan creation page: goal → materials → brief → hand off to the assistant.
 *
 * The student fills in what they already know (the exam, the materials on hand,
 * and how they want the plan to look). "Plan with the assistant" then creates a
 * conversation whose first step carries the form snapshot plus this feature's
 * instructions, so the model can ask the remaining questions and draft the plan
 * with the study tools. The conversation — not this page — produces the plan.
 *
 * The page keeps a manual fallback for a machine without a model: the brief step
 * can hand off to the old one-task draft form, and a draft stays a draft until
 * the student explicitly confirms it. That path writes nothing from the model.
 *
 * The student can leave at any step through "continue later"; the step, the
 * form fields and the selected materials are saved in Web Storage (falling back
 * to memory when storage is blocked) and restored on the next open. "Skip" writes
 * nothing to the service, so the workbench, timer and plan page stay fully
 * usable with no model and no network.
 *
 * `OnboardingView` is the pure part and every state transformation is exported,
 * so Node tests cover the flow, the brief payload and the trial gate without a
 * browser.
 */
import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react';
import { createStorageArea } from '../lib/storage.js';
import { useWorkspaceItems, workspaceName } from '../lib/workspaces.js';
import { diffPlanDocuments, missingEntryText, missingPlanInfo, summarizeDiff } from './plan.js';
import {
  BADGE_STYLE, BUTTON_ACTIVE_STYLE, BUTTON_PRIMARY_STYLE, BUTTON_STYLE, CARD_ALERT_STYLE, CARD_STYLE,
  ERROR_STYLE, FIELD_ROW_STYLE, FIELD_STYLE, FIELDS_STYLE, HEADER_STYLE, INPUT_STYLE, LIST_STYLE,
  MESSAGE_STYLE, NOTE_STYLE, ROOT_STYLE, ROW_STYLE, SECTION_STYLE, SUBHEADING_STYLE, SUBTITLE_STYLE,
  TITLE_STYLE, TOOLBAR_STYLE, WARNING_CARD_STYLE, contentStyle,
} from '../../../../packages/study-client/ui.js';

/** Web Storage key holding the resumable onboarding progress. */
export const STORAGE_KEY = 'study.onboarding.v1';

/** The three steps of the guided flow, in order; draft/confirm are the manual fallback. */
export const STEPS = ['goal', 'materials', 'brief'];

const STEP_LABEL_KEYS = {
  goal: 'onboarding.step.goal',
  materials: 'onboarding.step.materials',
  brief: 'onboarding.step.brief',
  draft: 'onboarding.step.draft',
  confirm: 'onboarding.step.confirm',
};

const BRIEF_FIELD_ERROR_KEYS = {
  dailyMinutes: 'onboarding.brief.dailyMinutesInvalid',
};

const GOAL_FIELD_ERROR_KEYS = {
  exam: 'onboarding.goal.examRequired',
  examYear: 'onboarding.goal.examYearInvalid',
  dailyMinutes: 'onboarding.goal.dailyMinutesInvalid',
};

const PLAN_FIELD_ERROR_KEYS = {
  title: 'onboarding.draft.planTitleRequired',
  estimateMinutes: 'onboarding.draft.estimateInvalid',
  availabilityRange: 'onboarding.draft.availabilityInvalid',
  availabilityDate: 'onboarding.draft.availabilityNoDate',
};

const MISSING_GOAL_KEYS = {
  examYear: 'onboarding.missing.examYear',
  deadline: 'onboarding.missing.deadline',
  dailyMinutes: 'onboarding.missing.dailyMinutes',
};

const MATERIAL_MISSING_KEYS = {
  edition: 'onboarding.materials.field.edition',
  toc: 'onboarding.materials.field.toc',
  page: 'onboarding.materials.field.page',
  chapter: 'onboarding.materials.field.chapter',
};

const VERDICT_KEYS = {
  fits: 'onboarding.confirm.verdict.fits',
  partial: 'onboarding.confirm.verdict.partial',
  over_capacity: 'onboarding.confirm.verdict.over',
};

const STATUS_KEYS = {
  draft: 'onboarding.status.draft',
  active: 'onboarding.status.active',
  trial: 'onboarding.status.trial',
};

/** Step chips: mono micro-labels; the active one borrows the shared accent pair. */
const STEPS_STYLE = { ...LIST_STYLE, flexDirection: 'row', gap: '8px', flexWrap: 'wrap' };
const STEP_STYLE = { ...BUTTON_STYLE, cursor: 'default' };
const STEP_ACTIVE_STYLE = {
  ...STEP_STYLE,
  borderColor: BUTTON_ACTIVE_STYLE.borderColor,
  background: BUTTON_ACTIVE_STYLE.background,
  color: BUTTON_ACTIVE_STYLE.color,
};
const STEP_DONE_STYLE = { ...STEP_STYLE, color: BUTTON_ACTIVE_STYLE.color };
/** One step's stack of cards; the page column gap is already outside it. */
const STEP_BODY_STYLE = { display: 'flex', flexDirection: 'column', gap: '18px' };
/** A form inside a card: fields sit on the card surface instead of in a second box. */
const FORM_STYLE = { display: 'flex', flexDirection: 'column', gap: '12px' };
/** Workspace picker: a nested quiet group on the goal card. */
const WORKSPACE_BOX_STYLE = { ...CARD_STYLE, boxShadow: 'none', padding: '10px 12px', gap: '8px', minWidth: 0 };
const WORKSPACE_LIST_STYLE = { ...LIST_STYLE, gap: '2px', maxHeight: '220px', overflowY: 'auto' };
const WORKSPACE_ROW_STYLE = { ...ROW_STYLE, justifyContent: 'flex-start', alignItems: 'flex-start', padding: '8px 0' };
const WORKSPACE_TEXT_STYLE = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 };
const WORKSPACE_PATH_STYLE = { ...NOTE_STYLE, fontSize: '11px', wordBreak: 'break-all' };
/** Bullet list of plain fragments inside a card; type comes from the note tier. */
const BULLETS_STYLE = { ...NOTE_STYLE, margin: 0, paddingLeft: '18px' };

/** One discovered page: contract consumed by `client/plugin.js`. */
export default {
  key: 'onboarding',
  order: 1,
  label: 'onboarding.panel',
  Page: OnboardingPage,
};

/** Trim one form value to a string; absent values become an empty string. */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

/** Join display parts without hardcoding punctuation in either locale. */
function joinParts(values) {
  return values.filter(value => value !== null && value !== undefined && String(value).length > 0).join(' · ');
}

/** An empty goal form. */
export function emptyGoalDraft() {
  return { exam: '', examYear: '', deadline: '', dailyMinutes: '', note: '', workspaceIds: [] };
}

/** An empty quick-start draft form. */
export function emptyPlanForm() {
  return {
    planTitle: '',
    itemTitle: '',
    estimateMinutes: '30',
    date: '',
    availabilityMinutes: '',
    materialId: '',
  };
}

/** An empty "how should the plan look" form handed to the assistant. */
export function emptyBriefDraft() {
  return {
    planTitle: '',
    stageGoal: '',
    dailyMinutes: '',
    constraints: '',
    notes: '',
  };
}

/**
 * The local, resumable onboarding state. It contains no server result; the
 * page re-reads the goal, materials and plan on every open.
 * @returns {object} Empty state positioned at the goal step.
 */
export function emptyOnboardingState() {
  return {
    phase: 'goal',
    goalId: null,
    selectedMaterialIds: [],
    goalDraft: emptyGoalDraft(),
    planForm: emptyPlanForm(),
    briefDraft: emptyBriefDraft(),
    workspaceSelectionStored: false,
  };
}

/**
 * Read the resumable state from storage, dropping anything malformed instead
 * of failing the page.
 * @param {{ getItem?: (key: string) => string | null }} storage - Storage area.
 * @returns {object} Normalized state; empty state when nothing usable is stored.
 */
export function readOnboardingState(storage) {
  const fallback = emptyOnboardingState();
  let parsed;
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    if (typeof raw !== 'string' || raw === '') return fallback;
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const state = emptyOnboardingState();
  // `draft` and `confirm` are legacy flow positions kept so an interrupted
  // manual draft still resumes at its form.
  const knownPhases = new Set([...STEPS, 'draft', 'confirm', 'skipped', 'done']);
  if (typeof parsed.phase === 'string' && knownPhases.has(parsed.phase)) state.phase = parsed.phase;
  if (typeof parsed.goalId === 'string' && parsed.goalId.length > 0) state.goalId = parsed.goalId;
  if (Array.isArray(parsed.selectedMaterialIds)) {
    state.selectedMaterialIds = parsed.selectedMaterialIds.filter(id => typeof id === 'string' && id.length > 0);
  }
  for (const key of Object.keys(state.goalDraft)) {
    if (typeof parsed.goalDraft?.[key] === 'string') state.goalDraft[key] = parsed.goalDraft[key];
  }
  if (Array.isArray(parsed.goalDraft?.workspaceIds)) {
    state.goalDraft.workspaceIds = parsed.goalDraft.workspaceIds
      .filter(id => typeof id === 'string' && id.trim() !== '')
      .map(id => id.trim());
    state.workspaceSelectionStored = true;
  }
  for (const key of Object.keys(state.planForm)) {
    if (typeof parsed.planForm?.[key] === 'string') state.planForm[key] = parsed.planForm[key];
  }
  if (parsed.briefDraft !== null && typeof parsed.briefDraft === 'object' && !Array.isArray(parsed.briefDraft)) {
    for (const key of Object.keys(state.briefDraft)) {
      if (typeof parsed.briefDraft[key] === 'string') state.briefDraft[key] = parsed.briefDraft[key];
    }
  }
  return state;
}

/**
 * Persist the resumable state. A blocked storage area reports false instead of
 * throwing, so "continue later" can tell the student the step will not survive
 * a restart.
 * @param {{ setItem: (key: string, value: string) => void }} storage - Storage area.
 * @param {object} state - Current local state.
 * @returns {boolean} Whether the write succeeded.
 */
export function writeOnboardingState(storage, state) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      phase: state.phase,
      goalId: state.goalId ?? state.goal?.id ?? state.plan?.goalId ?? null,
      selectedMaterialIds: [...(state.selectedMaterialIds ?? [])],
      goalDraft: state.goalDraft ?? emptyGoalDraft(),
      planForm: state.planForm ?? emptyPlanForm(),
      briefDraft: state.briefDraft ?? emptyBriefDraft(),
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the resumable state.
 * @param {{ removeItem: (key: string) => void }} storage - Storage area.
 * @returns {boolean} Whether the removal succeeded.
 */
export function clearOnboardingState(storage) {
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Turn a stored goal into the edit form. */
export function goalDraftFrom(goal) {
  if (goal === null || goal === undefined) return emptyGoalDraft();
  return {
    exam: goal.exam ?? '',
    examYear: goal.examYear === null || goal.examYear === undefined ? '' : String(goal.examYear),
    deadline: goal.deadline ?? '',
    dailyMinutes: goal.dailyMinutes === null || goal.dailyMinutes === undefined ? '' : String(goal.dailyMinutes),
    note: goal.note ?? '',
    workspaceIds: Array.isArray(goal.workspaceIds)
      ? goal.workspaceIds.filter(id => typeof id === 'string' && id.length > 0)
      : [],
  };
}

/**
 * Pick the goal form to show. A draft stored before workspace links existed has
 * no selection array; take the current goal's links once instead of clearing
 * them when that older draft is saved.
 * @param {{ goalDraft: object, workspaceSelectionStored?: boolean }} stored - Restored onboarding state.
 * @param {object | null} goal - Goal read from the service.
 * @returns {object} Goal form for the step.
 */
export function mergeStoredGoalDraft(stored, goal) {
  const draft = stored?.goalDraft ?? emptyGoalDraft();
  if (textOf(draft.exam) === '' && goal !== null && goal !== undefined) return goalDraftFrom(goal);
  if (goal === null || goal === undefined || stored?.workspaceSelectionStored !== false) return draft;
  return { ...draft, workspaceIds: goalDraftFrom(goal).workspaceIds };
}

/**
 * Validate and normalize the goal form. Only the exam name is required; every
 * other field may stay empty and is reported by the service as missing.
 * @param {object} draft - Goal form values.
 * @returns {{ ok: true, payload: object } | { ok: false, field: string }} Parsed value or the first invalid field.
 */
export function parseGoalDraft(draft) {
  const exam = textOf(draft?.exam);
  if (exam === '') return { ok: false, field: 'exam' };
  const values = {};
  for (const [field, min, max] of [['examYear', 1900, 2200], ['dailyMinutes', 0, 1440]]) {
    const raw = textOf(draft?.[field]);
    if (raw === '') {
      values[field] = null;
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) return { ok: false, field };
    values[field] = value;
  }
  const deadline = textOf(draft?.deadline);
  const workspaceIds = [...new Set((Array.isArray(draft?.workspaceIds) ? draft.workspaceIds : [])
    .filter(id => typeof id === 'string' && id.trim() !== '')
    .map(id => id.trim()))];
  return {
    ok: true,
    payload: {
      exam,
      examYear: values.examYear,
      deadline: deadline === '' ? null : deadline,
      dailyMinutes: values.dailyMinutes,
      note: textOf(draft?.note) === '' ? null : textOf(draft?.note),
      workspaceIds,
      active: true,
    },
  };
}

/**
 * The missing goal fields the service reported, constrained to the three the
 * setup copy covers.
 * @param {object | null} goal - Goal summary from the materials service.
 * @returns {string[]} Missing field names.
 */
export function goalMissingFields(goal) {
  if (goal === null || goal === undefined || !Array.isArray(goal.missing)) return [];
  return goal.missing.filter(field => Object.hasOwn(MISSING_GOAL_KEYS, field));
}

/**
 * Build the default plan form title from the goal without hardcoding copy.
 * @param {(key: string, params?: object) => string} t - Translator.
 * @param {object | null} goal - Goal summary.
 * @returns {string} Default title, or an empty string without a goal.
 */
export function defaultPlanTitle(t, goal) {
  return goal === null || goal === undefined ? '' : t('onboarding.draft.defaultTitle', { exam: goal.exam });
}

/**
 * Merge the stored form with defaults. A previously typed title is kept; an
 * empty one follows the current goal.
 * @param {object} storedForm - Form restored from storage.
 * @param {object | null} goal - Goal summary.
 * @param {(key: string, params?: object) => string} t - Translator.
 * @returns {object} Complete plan form.
 */
export function defaultPlanForm(storedForm, goal, t) {
  const form = { ...emptyPlanForm(), ...(storedForm ?? {}) };
  if (textOf(form.planTitle) === '') form.planTitle = defaultPlanTitle(t, goal);
  return form;
}

/**
 * Merge the stored brief with defaults: the title follows the goal, and the
 * daily minutes start from the goal's own budget when the student has not
 * typed one.
 * @param {object | undefined} storedBrief - Brief restored from storage.
 * @param {object | null} goal - Goal summary.
 * @param {(key: string, params?: object) => string} t - Translator.
 * @returns {object} Complete brief form.
 */
export function defaultBriefDraft(storedBrief, goal, t) {
  const brief = { ...emptyBriefDraft(), ...(storedBrief ?? {}) };
  if (textOf(brief.planTitle) === '') brief.planTitle = defaultPlanTitle(t, goal);
  if (textOf(brief.dailyMinutes) === '' && goal?.dailyMinutes !== null && goal?.dailyMinutes !== undefined) {
    brief.dailyMinutes = String(goal.dailyMinutes);
  }
  return brief;
}

/**
 * Normalize the brief into the planning-service payload. Nothing is invented:
 * empty fields stay omitted, and the goal link is the current one.
 * @param {{ briefDraft: object, goal: object | null, selectedMaterialIds: string[] }} input
 *   Current form and the goal the plan belongs to.
 * @returns {{ ok: true, payload: { goalId?: string, brief: object } } | { ok: false, field: string }}
 *   Planning payload or the first invalid field.
 */
export function parseBrief({ briefDraft, goal, selectedMaterialIds }) {
  const raw = textOf(briefDraft?.dailyMinutes);
  let dailyMinutes = null;
  if (raw !== '') {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > 1440) return { ok: false, field: 'dailyMinutes' };
    dailyMinutes = value;
  }
  const brief = {
    planTitle: textOf(briefDraft?.planTitle) || null,
    stageGoal: textOf(briefDraft?.stageGoal) || null,
    constraints: textOf(briefDraft?.constraints) || null,
    notes: textOf(briefDraft?.notes) || null,
    dailyMinutes,
    materialIds: Array.isArray(selectedMaterialIds)
      ? selectedMaterialIds.filter(id => typeof id === 'string' && id.length > 0)
      : [],
  };
  const payload = { brief };
  if (typeof goal?.id === 'string' && goal.id.length > 0) payload.goalId = goal.id;
  return { ok: true, payload };
}

/**
 * Validate and normalize the quick-start draft form into a plans service
 * payload. This is a passthrough of the student's own declarations: no date,
 * no slot and no ordering is invented here.
 * @param {{ form: object, goal: object | null, plan: object | null }} input - Current form and server context.
 * @returns {{ ok: true, payload: object } | { ok: false, field: string }} Parsed value or the first invalid field.
 */
export function parsePlanForm({ form, goal, plan, draft }) {
  const title = textOf(form?.planTitle);
  if (title === '') return { ok: false, field: 'title' };

  const estimateRaw = textOf(form?.estimateMinutes);
  const estimateMinutes = estimateRaw === '' ? 30 : Number(estimateRaw);
  if (!Number.isSafeInteger(estimateMinutes) || estimateMinutes < 1 || estimateMinutes > 1440) {
    return { ok: false, field: 'estimateMinutes' };
  }

  const itemTitle = textOf(form?.itemTitle);
  const date = textOf(form?.date);
  const materialId = textOf(form?.materialId);
  const availabilityRaw = textOf(form?.availabilityMinutes);
  if (availabilityRaw !== '' && date === '') return { ok: false, field: 'availabilityDate' };

  let availability;
  if (date !== '' && availabilityRaw !== '') {
    const minutes = Number(availabilityRaw);
    if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 1440) {
      return { ok: false, field: 'availabilityRange' };
    }
    availability = [{ date, minutes }];
  }

  const items = itemTitle === ''
    ? []
    : [{
      ...(draft?.data?.items?.[0]?.id ? { id: draft.data.items[0].id } : {}),
      title: itemTitle,
      materialId: materialId === '' ? null : materialId,
      estimateMinutes,
      date: date === '' ? null : date,
      start: null,
      end: null,
      flexible: true,
      completion: null,
      dependencies: [],
      note: null,
    }];

  const payload = {
    baseRevision: plan?.revision ?? 0,
    expectedDraftRevision: draft?.draftRevision ?? plan?.draftRevision ?? 0,
    title,
    items,
  };
  if (plan?.id) payload.planId = plan.id;
  const goalId = plan?.goalId ?? goal?.id ?? null;
  if (goalId !== null) payload.goalId = goalId;
  if (availability !== undefined) payload.availability = availability;
  return { ok: true, payload };
}

/**
 * Build the confirmation payload. A draft that exceeds capacity or overlaps
 * requires an explicit trial acknowledgement; the gate is local so a click
 * cannot silently confirm a risky plan.
 * @param {{ plan: object | null, draft: object | null, capacity: object | null,
 *   trialAcknowledged: boolean, reviewAt?: string }} input - Confirmation state.
 * @returns {{ ok: true, payload: object, trial: boolean } | { ok: false, field: string }}
 *   Confirmation payload or the blocking field.
 */
export function parseConfirm({ plan, draft, capacity, trialAcknowledged, reviewAt }) {
  if (plan === null || plan === undefined || typeof plan.id !== 'string') return { ok: false, field: 'plan' };
  const trial = capacity?.requiresTrial === true || draft?.data?.trial === true;
  if (trial && trialAcknowledged !== true) return { ok: false, field: 'trial' };
  const payload = { planId: plan.id, baseRevision: plan.revision, expectedDraftRevision: draft?.draftRevision ?? plan.draftRevision };
  if (trial) payload.trial = true;
  const review = textOf(reviewAt);
  if (review !== '') payload.reviewAt = review;
  return { ok: true, payload, trial };
}

/**
 * Decide which step to show from the stored progress and the server state.
 * A pending draft always wins because confirmation is the only remaining act;
 * an already applied plan without a draft means creation is complete.
 * @param {{ storedPhase: string, plan: object | null, draft: object | null }} input - Stored and server state.
 * @returns {string} One of the three guided steps, the manual draft/confirm, plus `done` or `skipped`.
 */
export function resolveStep({ storedPhase, plan, draft }) {
  if (storedPhase === 'skipped') return 'skipped';
  if (draft !== null && draft !== undefined) return 'confirm';
  if (plan !== null && plan !== undefined && plan.revision > 0) return 'done';
  if (storedPhase === 'brief') return 'brief';
  if (storedPhase === 'draft' || storedPhase === 'confirm' || storedPhase === 'done') return 'draft';
  if (STEPS.includes(storedPhase)) return storedPhase;
  return 'goal';
}

/** Mark the local state as skipped; no service write is involved. */
export function skipOnboarding(state) {
  return { ...state, phase: 'skipped' };
}

/** Reset the local state to the goal step. */
export function restartOnboarding() {
  return emptyOnboardingState();
}

/**
 * Page body: loads the goal, materials and latest plan, then routes the step
 * actions to the services and persists the local progress.
 * @param {{ t: Function, call: Function, workspaceList?: object }} props
 *   Framework locale seat, study route caller, and the live DSH Workspace source.
 * @returns {object} Page element.
 */
function OnboardingPage({ t, call, workspaceList, activity }) {
  const storage = useMemo(() => createStorageArea(), []);
  const workspaceItems = useWorkspaceItems(workspaceList);
  const [session, setSession] = useState(createSessionState);
  const sessionRef = useMemo(() => ({ current: session }), []);

  const applySession = useCallback(next => {
    const resolved = typeof next === 'function' ? next(sessionRef.current) : next;
    sessionRef.current = resolved;
    setSession(resolved);
  }, []);

  const persist = useCallback(state => writeOnboardingState(storage, {
    ...state,
    phase: state.step === 'done' ? 'done' : state.step,
    goalId: state.goal?.id ?? state.plan?.goalId ?? null,
  }), [storage]);

  const load = useCallback(async () => {
    applySession(current => ({ ...current, phase: 'loading', notice: null, busy: false }));
    try {
      const stored = readOnboardingState(storage);
      const planEnvelope = await call('plans', 'get', {});
      const data = planEnvelope.value ?? {};
      const plan = data.plan ?? null;
      const goalId = plan?.goalId ?? null;
      const warnings = [];
      let goal = null;
      try {
        const goalEnvelope = await call('materials', 'getGoal', goalId === null ? {} : { id: goalId });
        goal = goalEnvelope.value?.goal ?? null;
      } catch (error) {
        warnings.push(t('onboarding.error.loadGoal', { message: describeError(t, error) }));
      }
      let materials = [];
      try {
        const materialEnvelope = await call('materials', 'list', {});
        materials = materialEnvelope.value?.materials ?? [];
      } catch (error) {
        warnings.push(t('onboarding.error.loadMaterials', { message: describeError(t, error) }));
      }
      const step = resolveStep({ storedPhase: stored.phase, plan, draft: data.draft ?? null });
      let planningSessionId = null;
      if (goal?.id) {
        try {
          const latest = await call('planning', 'latest', { goalId: goal.id });
          planningSessionId = latest.value?.link?.sessionId ?? null;
        } catch (error) { warnings.push(describeError(t, error)); }
      }
      const selectedMaterialIds = stored.selectedMaterialIds.filter(id => materials.some(material => material.id === id));
      const goalDraft = mergeStoredGoalDraft(stored, goal);
      applySession({
        ...createSessionState(),
        phase: 'ready',
        step,
        goal,
        planningSessionId,
        materials,
        selectedMaterialIds,
        plan,
        draft: data.draft ?? null,
        applied: data.applied ?? null,
        capacity: data.capacity ?? null,
        revisions: data.revisions ?? [],
        goalDraft,
        planForm: defaultPlanForm(stored.planForm, goal, t),
        briefDraft: defaultBriefDraft(stored.briefDraft, goal, t),
        warnings,
      });
    } catch (error) {
      applySession(current => ({ ...current, phase: 'error', message: describeError(t, error) }));
    }
  }, [applySession, call, storage, t]);

  useEffect(() => { void load(); }, [load]);

  const saveGoal = useCallback(async event => {
    event?.preventDefault?.();
    if (sessionRef.current.busy) return;
    const parsed = parseGoalDraft(sessionRef.current.goalDraft);
    if (!parsed.ok) {
      applySession(current => ({ ...current, notice: t(GOAL_FIELD_ERROR_KEYS[parsed.field] ?? 'onboarding.goal.examRequired') }));
      return;
    }
    applySession(current => ({ ...current, busy: true, notice: null }));
    try {
      const envelope = await call('materials', 'saveGoal', parsed.payload);
      const goal = envelope.value.goal;
      applySession(current => {
        const previousDefault = current.goal === null ? '' : defaultPlanTitle(t, current.goal);
        const typed = textOf(current.planForm.planTitle);
        const next = {
          ...current,
          busy: false,
          goal,
          goalDraft: goalDraftFrom(goal),
          planForm: {
            ...current.planForm,
            planTitle: typed !== '' && typed !== previousDefault ? typed : defaultPlanTitle(t, goal),
          },
          step: 'materials',
          notice: t('onboarding.goal.saved'),
        };
        persist(next);
        return next;
      });
    } catch (error) {
      applySession(current => ({ ...current, busy: false, notice: t('onboarding.error.saveGoal', { message: describeError(t, error) }) }));
    }
  }, [applySession, call, persist, t]);

  const toggleMaterial = useCallback(id => {
    applySession(current => {
      const selected = current.selectedMaterialIds.includes(id)
        ? current.selectedMaterialIds.filter(candidate => candidate !== id)
        : [...current.selectedMaterialIds, id];
      return {
        ...current,
        selectedMaterialIds: selected,
        planForm: current.planForm.materialId === id && !selected.includes(id)
          ? { ...current.planForm, materialId: '' }
          : current.planForm,
      };
    });
  }, [applySession]);

  const goTo = useCallback(step => {
    applySession(current => {
      const next = { ...current, step, notice: null };
      persist(next);
      return next;
    });
  }, [applySession, persist]);

  const continueMaterials = useCallback(() => goTo('brief'), [goTo]);

  const startCreation = useCallback(async () => {
    if (sessionRef.current.busy) return;
    const parsed = parseBrief({
      briefDraft: sessionRef.current.briefDraft,
      goal: sessionRef.current.goal,
      selectedMaterialIds: sessionRef.current.selectedMaterialIds,
    });
    if (!parsed.ok) {
      applySession(current => ({ ...current, notice: t(BRIEF_FIELD_ERROR_KEYS[parsed.field] ?? 'onboarding.brief.dailyMinutesInvalid') }));
      return;
    }
    if (activity === undefined || typeof activity.startPlanCreation !== 'function') {
      applySession(current => ({ ...current, notice: t('onboarding.brief.unavailable') }));
      return;
    }
    applySession(current => ({ ...current, busy: true, notice: null }));
    try {
      await activity.startPlanCreation(parsed.payload);
      applySession(current => ({ ...current, busy: false }));
    } catch (error) {
      applySession(current => ({
        ...current,
        busy: false,
        notice: t('onboarding.error.start', { message: describeError(t, error) }),
      }));
    }
  }, [activity, applySession, t]);

  const saveDraft = useCallback(async event => {
    event?.preventDefault?.();
    if (sessionRef.current.busy) return;
    const parsed = parsePlanForm({
      form: sessionRef.current.planForm,
      goal: sessionRef.current.goal,
      plan: sessionRef.current.plan,
      draft: sessionRef.current.draft,
    });
    if (!parsed.ok) {
      applySession(current => ({ ...current, notice: t(PLAN_FIELD_ERROR_KEYS[parsed.field] ?? 'onboarding.draft.planTitleRequired') }));
      return;
    }
    applySession(current => ({ ...current, busy: true, notice: null }));
    try {
      const envelope = await call('plans', 'saveDraft', parsed.payload);
      const value = envelope.value;
      applySession(current => {
        const next = {
          ...current,
          busy: false,
          plan: value.plan,
          draft: value.draft,
          capacity: value.capacity,
          step: 'confirm',
          trialAcknowledged: false,
          notice: t('onboarding.draft.saved'),
        };
        persist(next);
        return next;
      });
    } catch (error) {
      applySession(current => ({ ...current, busy: false, notice: t('onboarding.error.saveDraft', { message: describeError(t, error) }) }));
    }
  }, [applySession, call, persist, t]);

  const confirm = useCallback(async event => {
    event?.preventDefault?.();
    if (sessionRef.current.busy) return;
    const currentState = sessionRef.current;
    const parsed = parseConfirm({
      plan: currentState.plan,
      draft: currentState.draft,
      capacity: currentState.capacity,
      trialAcknowledged: currentState.trialAcknowledged,
      reviewAt: currentState.reviewAt,
    });
    if (!parsed.ok) {
      applySession(current => ({
        ...current,
        notice: parsed.field === 'trial'
          ? t('onboarding.confirm.ackRequired')
          : t('onboarding.error.confirm', { message: t('onboarding.confirm.hint') }),
      }));
      return;
    }
    applySession(current => ({ ...current, busy: true, notice: null }));
    try {
      const envelope = await call('plans', 'confirm', parsed.payload);
      const value = envelope.value;
      applySession(current => {
        const next = {
          ...current,
          busy: false,
          plan: value.plan,
          applied: value.revision,
          draft: null,
          capacity: value.capacity,
          revisions: [value.revision, ...current.revisions],
          step: 'done',
          trialAcknowledged: false,
          confirmDiff: value.changes,
          notice: t('onboarding.confirm.done', { revision: value.plan.revision }),
        };
        persist(next);
        return next;
      });
    } catch (error) {
      applySession(current => ({ ...current, busy: false, notice: t('onboarding.error.confirm', { message: describeError(t, error) }) }));
    }
  }, [applySession, call, persist, t]);

  const later = useCallback(() => {
    const saved = persist(sessionRef.current);
    applySession(current => ({
      ...current,
      notice: t(saved ? 'onboarding.laterSaved' : 'onboarding.laterFailed'),
    }));
  }, [applySession, persist, t]);

  const skip = useCallback(() => {
    applySession(current => {
      const next = { ...skipOnboarding(current), step: 'skipped', notice: null };
      persist(next);
      return next;
    });
  }, [applySession, persist]);

  const restart = useCallback(() => {
    clearOnboardingState(storage);
    applySession(current => {
      const next = {
        ...current,
        phase: 'ready',
        step: 'goal',
        selectedMaterialIds: [],
        goalDraft: current.goal === null ? emptyGoalDraft() : goalDraftFrom(current.goal),
        planForm: defaultPlanForm(emptyPlanForm(), current.goal, t),
        briefDraft: defaultBriefDraft(emptyBriefDraft(), current.goal, t),
        trialAcknowledged: false,
        reviewAt: '',
        notice: null,
        confirmDiff: null,
      };
      persist(next);
      return next;
    });
  }, [applySession, persist, storage, t]);

  const back = useCallback(() => {
    const index = STEPS.indexOf(sessionRef.current.step);
    if (index > 0) goTo(STEPS[index - 1]);
  }, [goTo]);

  const reload = useCallback(() => {
    // Refresh can bring in a draft written in the conversation; save the local
    // form first so the re-read does not discard what the student typed.
    persist(sessionRef.current);
    void load();
  }, [load, persist]);

  return OnboardingView({
    create: h,
    t,
    view: session,
    workspaceItems,
    onRetry: reload,
    onReload: reload,
    onResume: async () => {
      try {
        if (!activity?.startPlanCreation) throw new Error(t('onboarding.brief.unavailable'));
        await activity.startPlanCreation({ goalId: sessionRef.current.goal?.id, resume: true });
      } catch (error) { applySession(current => ({ ...current, notice: describeError(t, error) })); }
    },
    onGoalField: (field, value) => applySession(current => ({ ...current, goalDraft: { ...current.goalDraft, [field]: value } })),
    onGoalWorkspace: (workspaceId, checked) => applySession(current => {
      const selected = new Set(current.goalDraft.workspaceIds ?? []);
      if (checked) selected.add(workspaceId);
      else selected.delete(workspaceId);
      return { ...current, goalDraft: { ...current.goalDraft, workspaceIds: [...selected] } };
    }),
    onGoalSave: saveGoal,
    onMaterialToggle: toggleMaterial,
    onMaterialsContinue: continueMaterials,
    onBriefField: (field, value) => applySession(current => ({ ...current, briefDraft: { ...current.briefDraft, [field]: value } })),
    onBriefStart: startCreation,
    onBriefManual: () => goTo('draft'),
    onDraftContinue: () => goTo('confirm'),
    onPlanField: (field, value) => applySession(current => ({ ...current, planForm: { ...current.planForm, [field]: value } })),
    onDraftSave: saveDraft,
    onTrialAck: checked => applySession(current => ({ ...current, trialAcknowledged: checked === true })),
    onReviewAt: value => applySession(current => ({ ...current, reviewAt: value })),
    onConfirm: confirm,
    onBack: back,
    onLater: later,
    onSkip: skip,
    onRestart: restart,
  });
}

/**
 * The page state before anything is loaded.
 * @returns {object} Session state.
 */
function createSessionState() {
  return {
    phase: 'loading',
    message: null,
    step: 'goal',
    goal: null,
    materials: [],
    selectedMaterialIds: [],
    plan: null,
    draft: null,
    applied: null,
    capacity: null,
    revisions: [],
    goalDraft: emptyGoalDraft(),
    planForm: emptyPlanForm(),
    briefDraft: emptyBriefDraft(),
    trialAcknowledged: false,
    reviewAt: '',
    notice: null,
    warnings: [],
    busy: false,
    confirmDiff: null,
  };
}

/**
 * Render one state of the onboarding flow.
 * @param {object} props - Render inputs; see `OnboardingPage` for producers.
 * @param {Function} props.create - React element factory.
 * @param {Function} props.t - Translator.
 * @param {object} props.view - Session state.
 * @returns {object} Section element.
 */
export function OnboardingView(props) {
  const { create, t, view } = props;
  const ready = view.phase === 'ready';
  return create('section', {
    'data-testid': 'study-onboarding',
    'data-page': 'onboarding',
    'data-step': ready ? view.step : view.phase,
    'data-study-page': '',
    style: ROOT_STYLE,
  },
  create('div', { style: contentStyle(880) },
    create('div', { style: HEADER_STYLE },
      create('div', null,
        create('h1', { style: TITLE_STYLE }, t('onboarding.title')),
        create('p', { style: SUBTITLE_STYLE }, t('onboarding.subtitle'))),
      ready
        ? create('button', { type: 'button', 'data-testid': 'onboarding-refresh', style: BUTTON_STYLE, disabled: view.busy, onClick: props.onReload }, t('onboarding.refresh'))
        : null),
    renderStepNav(create, t, ready ? view.step : null),
    renderWarnings(create, view.warnings),
    renderNotice(create, view.notice),
    ready && view.planningSessionId ? create('button', {
      type: 'button', 'data-testid': 'onboarding-resume', style: BUTTON_STYLE,
      disabled: view.busy, onClick: props.onResume,
    }, t('onboarding.resume')) : null,
    renderBody(create, t, props)));
}

/** Render the four-step indicator; done and skipped hide it. */
function renderStepNav(create, t, current) {
  if (current === null || current === 'done' || current === 'skipped') return null;
  const index = STEPS.indexOf(current);
  return create('ol', { 'data-testid': 'onboarding-steps', 'aria-label': t('onboarding.steps'), style: STEPS_STYLE },
    STEPS.map((step, position) => create('li', {
      key: step,
      'data-testid': `onboarding-step-${step}`,
      'aria-current': step === current ? 'step' : undefined,
      style: position < index ? STEP_DONE_STYLE : position === index ? STEP_ACTIVE_STYLE : STEP_STYLE,
    }, `${position + 1}. ${t(STEP_LABEL_KEYS[step])}`)));
}

/** Surface non-blocking read failures instead of hiding them. */
function renderWarnings(create, warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  return create('div', { 'data-testid': 'onboarding-warnings' }, warnings.map((warning, index) => create('p', {
    key: `warning-${index}`,
    role: 'alert',
    style: ERROR_STYLE,
  }, warning)));
}

/** Render the latest action result. */
function renderNotice(create, notice) {
  if (typeof notice !== 'string' || notice === '') return null;
  return create('p', { 'data-testid': 'onboarding-notice', role: 'status', style: MESSAGE_STYLE }, notice);
}

/** Render the state-specific body. */
function renderBody(create, t, props) {
  const { view } = props;
  if (view.phase === 'loading') {
    return create('p', { 'data-testid': 'study-loading', role: 'status', style: MESSAGE_STYLE }, t('onboarding.loading'));
  }
  if (view.phase === 'error') {
    return create('div', { style: CARD_ALERT_STYLE },
      create('p', { 'data-testid': 'study-error', role: 'alert', style: ERROR_STYLE }, t('onboarding.error.load', { message: view.message })),
      create('div', { style: TOOLBAR_STYLE }, create('button', { type: 'button', 'data-testid': 'onboarding-retry', style: BUTTON_STYLE, onClick: props.onRetry }, t('onboarding.retry'))));
  }
  if (view.step === 'goal') return renderGoalStep(create, t, props);
  if (view.step === 'materials') return renderMaterialsStep(create, t, props);
  if (view.step === 'brief') return renderBriefStep(create, t, props);
  if (view.step === 'draft') return renderDraftStep(create, t, props);
  if (view.step === 'confirm') return renderConfirmStep(create, t, props);
  if (view.step === 'done') return renderDoneStep(create, t, props);
  return renderSkippedStep(create, t, props);
}

/** Render the goal step: only the exam name is required. */
function renderGoalStep(create, t, props) {
  const { view } = props;
  const draft = view.goalDraft;
  return create('div', { 'data-testid': 'onboarding-goal', style: STEP_BODY_STYLE },
    create('div', { style: CARD_STYLE },
      create('h2', { style: SECTION_STYLE }, t('onboarding.goal.title')),
      create('p', { style: NOTE_STYLE }, t('onboarding.goal.hint')),
      create('form', { 'data-testid': 'onboarding-goal-form', onSubmit: props.onGoalSave, style: FORM_STYLE },
        field(create, t('onboarding.goal.exam'), create('input', {
          name: 'exam',
          required: true,
          value: draft.exam,
          placeholder: t('onboarding.goal.examPlaceholder'),
          style: INPUT_STYLE,
          onChange: event => props.onGoalField('exam', event.target.value),
        })),
        create('div', { style: FIELDS_STYLE },
          field(create, t('onboarding.goal.examYear'), create('input', {
            name: 'examYear',
            type: 'number',
            min: 1900,
            max: 2200,
            value: draft.examYear,
            style: INPUT_STYLE,
            onChange: event => props.onGoalField('examYear', event.target.value),
          }), { grow: true }),
          field(create, t('onboarding.goal.deadline'), create('input', {
            name: 'deadline',
            type: 'date',
            value: draft.deadline,
            style: INPUT_STYLE,
            onChange: event => props.onGoalField('deadline', event.target.value),
          }), { grow: true }),
          field(create, t('onboarding.goal.dailyMinutes'), create('input', {
            name: 'dailyMinutes',
            type: 'number',
            min: 0,
            max: 1440,
            value: draft.dailyMinutes,
            style: INPUT_STYLE,
            onChange: event => props.onGoalField('dailyMinutes', event.target.value),
          }), { grow: true })),
        field(create, t('onboarding.goal.note'), create('input', {
          name: 'note',
          value: draft.note,
          style: INPUT_STYLE,
          onChange: event => props.onGoalField('note', event.target.value),
        })),
        renderWorkspacePicker(create, t, props, draft),
        create('div', { style: TOOLBAR_STYLE },
          create('button', { type: 'submit', 'data-testid': 'onboarding-goal-save', style: BUTTON_PRIMARY_STYLE, disabled: view.busy }, view.busy ? t('onboarding.busy') : t('onboarding.goal.save')),
          create('button', { type: 'button', 'data-testid': 'onboarding-goal-later', style: BUTTON_STYLE, onClick: props.onLater }, t('onboarding.later')),
          create('button', { type: 'button', 'data-testid': 'onboarding-goal-skip', style: BUTTON_STYLE, onClick: props.onSkip }, t('onboarding.skip'))))),
    view.goal === null ? null : renderGoalMissing(create, t, view.goal));
}

/** Render the multi-workspace selection for one goal. */
function renderWorkspacePicker(create, t, props, draft) {
  const items = Array.isArray(props.workspaceItems) ? props.workspaceItems : [];
  const selected = new Set(Array.isArray(draft.workspaceIds) ? draft.workspaceIds : []);
  const liveIds = new Set(items.map(item => item.workspaceId));
  const staleIds = [...selected].filter(id => !liveIds.has(id));
  const rows = [
    ...items.map(item => ({ workspaceId: item.workspaceId, title: workspaceName(item), path: item.path ?? null, missing: false })),
    ...staleIds.map(id => ({ workspaceId: id, title: null, path: null, missing: true })),
  ];
  return create('fieldset', {
    'data-testid': 'onboarding-goal-workspaces',
    style: WORKSPACE_BOX_STYLE,
  },
  create('legend', { style: { ...NOTE_STYLE, padding: '0 4px' } }, t('onboarding.goal.workspaces')),
  create('p', { style: NOTE_STYLE }, t('onboarding.goal.workspacesHint')),
  rows.length === 0
    ? create('p', { 'data-testid': 'onboarding-goal-workspaces-empty', style: MESSAGE_STYLE }, t('onboarding.goal.workspacesEmpty'))
    : create('ul', { 'data-testid': 'onboarding-goal-workspace-list', style: WORKSPACE_LIST_STYLE }, rows.map(row => create('li', {
      key: row.workspaceId,
      'data-testid': `onboarding-goal-workspace-row-${row.workspaceId}`,
      style: WORKSPACE_ROW_STYLE,
    },
    create('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer', minWidth: 0 } },
      create('input', {
        type: 'checkbox',
        'data-testid': `onboarding-goal-workspace-${row.workspaceId}`,
        checked: selected.has(row.workspaceId),
        onChange: event => props.onGoalWorkspace?.(row.workspaceId, event.target.checked),
      }),
      create('span', { style: WORKSPACE_TEXT_STYLE },
        create('span', null, row.missing ? t('onboarding.goal.workspaceMissing') : row.title),
        row.missing
          ? create('span', { style: WORKSPACE_PATH_STYLE }, row.workspaceId)
          : create('span', { style: WORKSPACE_PATH_STYLE }, row.path ?? '')))))));
}

/** Render the saved goal's missing fields as information, not as a blocker. */
function renderGoalMissing(create, t, goal) {
  const fields = goalMissingFields(goal);
  return create('div', { 'data-testid': 'onboarding-goal-missing', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('onboarding.missing.title')),
    fields.length === 0
      ? create('p', { style: NOTE_STYLE }, t('onboarding.missing.none'))
      : create('ul', { style: BULLETS_STYLE }, fields.map(field => create('li', {
        key: field,
        'data-testid': `onboarding-missing-${field}`,
      }, t(MISSING_GOAL_KEYS[field])))));
}

/** Render the materials step: select what already exists, or continue with none. */
function renderMaterialsStep(create, t, props) {
  const { view } = props;
  return create('div', { 'data-testid': 'onboarding-materials', style: STEP_BODY_STYLE },
    create('div', { style: CARD_STYLE },
      create('h2', { style: SECTION_STYLE }, t('onboarding.materials.title')),
      create('p', { style: NOTE_STYLE }, t('onboarding.materials.hint')),
      view.materials.length === 0
        ? create('p', { 'data-testid': 'onboarding-materials-empty', style: MESSAGE_STYLE }, t('onboarding.materials.empty'))
        : create('ul', { 'data-testid': 'onboarding-material-list', style: LIST_STYLE }, view.materials.map(material => renderMaterialRow(create, t, material, view.selectedMaterialIds.includes(material.id), props))),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', 'data-testid': 'onboarding-materials-continue', style: BUTTON_PRIMARY_STYLE, onClick: props.onMaterialsContinue }, t('onboarding.continue')),
        create('button', { type: 'button', 'data-testid': 'onboarding-materials-back', style: BUTTON_STYLE, onClick: props.onBack }, t('onboarding.back')),
        create('button', { type: 'button', 'data-testid': 'onboarding-materials-later', style: BUTTON_STYLE, onClick: props.onLater }, t('onboarding.later')),
        create('button', { type: 'button', 'data-testid': 'onboarding-materials-skip', style: BUTTON_STYLE, onClick: props.onSkip }, t('onboarding.skip')))));
}

/** Render one selectable material with its provenance gaps named. */
function renderMaterialRow(create, t, material, selected, props) {
  const missing = Array.isArray(material.missing)
    ? material.missing.map(field => MATERIAL_MISSING_KEYS[field] === undefined ? field : t(MATERIAL_MISSING_KEYS[field]))
    : [];
  return create('li', { key: material.id, 'data-testid': `onboarding-material-${material.id}`, style: ROW_STYLE },
    create('label', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flex: '1 1 320px' } },
      create('input', {
        type: 'checkbox',
        'data-testid': `onboarding-material-toggle-${material.id}`,
        checked: selected,
        onChange: () => props.onMaterialToggle(material.id),
      }),
      create('span', null,
        create('strong', null, material.title),
        material.edition === null || material.edition === undefined ? null : create('span', { style: BADGE_STYLE }, material.edition),
        create('span', { style: { ...NOTE_STYLE, marginLeft: '8px' } }, t('onboarding.materials.chunks', { count: material.chunkCount ?? 0 })))),
    create('div', { style: { ...NOTE_STYLE, flex: '1 1 240px' } },
      create('span', null, material.kind),
      missing.length === 0 ? null : create('span', { 'data-testid': `onboarding-material-missing-${material.id}` }, ` · ${t('onboarding.materials.missing', { fields: joinParts(missing) })}`)));
}

/** Render the brief step: what the student wants the plan to cover. */
function renderBriefStep(create, t, props) {
  const { view } = props;
  const draft = view.briefDraft ?? emptyBriefDraft();
  const exam = view.goal?.exam ?? '';
  return create('div', { 'data-testid': 'onboarding-brief', style: STEP_BODY_STYLE },
    create('div', { style: CARD_STYLE },
      create('h2', { style: SECTION_STYLE }, t('onboarding.brief.title')),
      create('p', { style: NOTE_STYLE }, t('onboarding.brief.hint')),
      create('p', { 'data-testid': 'onboarding-brief-project-hint', style: NOTE_STYLE }, t('onboarding.brief.projectHint')),
      create('form', {
        'data-testid': 'onboarding-brief-form',
        style: FORM_STYLE,
        onSubmit: event => { event?.preventDefault?.(); void props.onBriefStart(); },
      },
      field(create, t('onboarding.brief.planTitle'), create('input', {
        name: 'planTitle',
        value: draft.planTitle,
        placeholder: t('onboarding.brief.planTitlePlaceholder'),
        style: INPUT_STYLE,
        onChange: event => props.onBriefField('planTitle', event.target.value),
      })),
      field(create, t('onboarding.brief.stageGoal'), create('textarea', {
        name: 'stageGoal',
        rows: 3,
        value: draft.stageGoal,
        placeholder: t('onboarding.brief.stageGoalPlaceholder'),
        style: INPUT_STYLE,
        onChange: event => props.onBriefField('stageGoal', event.target.value),
      })),
      create('div', { style: FIELDS_STYLE },
        field(create, t('onboarding.brief.dailyMinutes'), create('input', {
          name: 'dailyMinutes',
          type: 'number',
          min: 0,
          max: 1440,
          value: draft.dailyMinutes,
          placeholder: '120',
          style: INPUT_STYLE,
          onChange: event => props.onBriefField('dailyMinutes', event.target.value),
        }), { grow: true })),
      field(create, t('onboarding.brief.constraints'), create('textarea', {
        name: 'constraints',
        rows: 2,
        value: draft.constraints,
        placeholder: t('onboarding.brief.constraintsPlaceholder'),
        style: INPUT_STYLE,
        onChange: event => props.onBriefField('constraints', event.target.value),
      })),
      field(create, t('onboarding.brief.notes'), create('textarea', {
        name: 'notes',
        rows: 2,
        value: draft.notes,
        placeholder: t('onboarding.brief.notesPlaceholder'),
        style: INPUT_STYLE,
        onChange: event => props.onBriefField('notes', event.target.value),
      })),
      create('div', { style: TOOLBAR_STYLE },
        create('button', {
          type: 'submit',
          'data-testid': 'onboarding-brief-start',
          style: BUTTON_PRIMARY_STYLE,
          disabled: view.busy,
        }, view.busy ? t('onboarding.busy') : t('onboarding.brief.start')),
        create('button', {
          type: 'button',
          'data-testid': 'onboarding-brief-manual',
          style: BUTTON_STYLE,
          disabled: view.busy,
          onClick: props.onBriefManual,
        }, t('onboarding.brief.manual')),
        create('button', { type: 'button', 'data-testid': 'onboarding-brief-back', style: BUTTON_STYLE, onClick: props.onBack }, t('onboarding.back')),
        create('button', { type: 'button', 'data-testid': 'onboarding-brief-later', style: BUTTON_STYLE, onClick: props.onLater }, t('onboarding.later')),
        create('button', { type: 'button', 'data-testid': 'onboarding-brief-skip', style: BUTTON_STYLE, onClick: props.onSkip }, t('onboarding.skip')))),
    create('ul', { 'data-testid': 'onboarding-brief-summary', style: BULLETS_STYLE },
      create('li', { 'data-testid': 'onboarding-brief-summary-goal' }, exam === '' ? t('onboarding.brief.summaryNoGoal') : t('onboarding.brief.summaryGoal', { exam })),
      create('li', { 'data-testid': 'onboarding-brief-summary-materials' }, t('onboarding.brief.summaryMaterials', { count: view.selectedMaterialIds.length })))),
    create('p', { 'data-testid': 'onboarding-brief-note', style: NOTE_STYLE }, t('onboarding.brief.after')));
}

/** Render the draft step: an existing draft, or one minimal starter declaration. */
function renderDraftStep(create, t, props) {
  const { view } = props;
  if (view.draft !== null && view.draft !== undefined) {
    return create('div', { 'data-testid': 'onboarding-draft', style: STEP_BODY_STYLE },
      create('p', { style: NOTE_STYLE }, t('onboarding.draft.manualHint')),
      renderExistingDraft(create, t, view),
      renderStepToolbar(create, t, props, { back: true, later: true, skip: true }),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', 'data-testid': 'onboarding-draft-continue', style: BUTTON_PRIMARY_STYLE, onClick: props.onDraftContinue }, t('onboarding.draft.existing.continue'))));
  }
  const form = view.planForm;
  return create('div', { 'data-testid': 'onboarding-draft' },
    create('p', { style: NOTE_STYLE }, t('onboarding.draft.manualHint')),
    create('div', { style: CARD_STYLE },
      create('h2', { style: SECTION_STYLE }, t('onboarding.draft.title')),
      create('p', { style: NOTE_STYLE }, t('onboarding.draft.hint')),
      create('form', { 'data-testid': 'onboarding-draft-form', onSubmit: props.onDraftSave, style: FORM_STYLE },
        field(create, t('onboarding.draft.planTitle'), create('input', {
          name: 'planTitle',
          value: form.planTitle,
          placeholder: t('onboarding.draft.planTitlePlaceholder'),
          style: INPUT_STYLE,
          onChange: event => props.onPlanField('planTitle', event.target.value),
        })),
        field(create, t('onboarding.draft.itemTitle'), create('input', {
          name: 'itemTitle',
          value: form.itemTitle,
          placeholder: t('onboarding.draft.itemTitlePlaceholder'),
          style: INPUT_STYLE,
          onChange: event => props.onPlanField('itemTitle', event.target.value),
        })),
        create('div', { style: FIELDS_STYLE },
          field(create, t('onboarding.draft.estimate'), create('input', {
            name: 'estimateMinutes',
            type: 'number',
            min: 1,
            max: 1440,
            value: form.estimateMinutes,
            style: INPUT_STYLE,
            onChange: event => props.onPlanField('estimateMinutes', event.target.value),
          }), { grow: true }),
          field(create, t('onboarding.draft.date'), create('input', {
            name: 'date',
            type: 'date',
            value: form.date,
            style: INPUT_STYLE,
            onChange: event => props.onPlanField('date', event.target.value),
          }), { grow: true }),
          field(create, t('onboarding.draft.availability'), create('input', {
            name: 'availabilityMinutes',
            type: 'number',
            min: 0,
            max: 1440,
            value: form.availabilityMinutes,
            style: INPUT_STYLE,
            onChange: event => props.onPlanField('availabilityMinutes', event.target.value),
          }), { grow: true })),
        create('p', { style: NOTE_STYLE }, t('onboarding.draft.dateHint')),
        field(create, t('onboarding.draft.material'), create('select', {
          name: 'materialId',
          value: form.materialId,
          style: INPUT_STYLE,
          onChange: event => props.onPlanField('materialId', event.target.value),
        },
        create('option', { value: '' }, t('onboarding.draft.materialNone')),
        view.materials.map(material => create('option', { key: material.id, value: material.id }, material.title)))),
        create('div', { style: TOOLBAR_STYLE },
          create('button', { type: 'submit', 'data-testid': 'onboarding-draft-save', style: BUTTON_PRIMARY_STYLE, disabled: view.busy }, view.busy ? t('onboarding.busy') : t('onboarding.draft.save')),
          create('button', { type: 'button', 'data-testid': 'onboarding-draft-back', style: BUTTON_STYLE, onClick: props.onBack }, t('onboarding.back')),
          create('button', { type: 'button', 'data-testid': 'onboarding-draft-later', style: BUTTON_STYLE, onClick: props.onLater }, t('onboarding.later')),
          create('button', { type: 'button', 'data-testid': 'onboarding-draft-skip', style: BUTTON_STYLE, onClick: props.onSkip }, t('onboarding.skip'))))));
}

/** Render a draft the assistant (or a previous visit) already saved. */
function renderExistingDraft(create, t, view) {
  const data = view.draft?.data ?? {};
  const items = Array.isArray(data.items) ? data.items : [];
  const minutes = items.reduce((sum, entry) => sum + (entry.estimateMinutes ?? 0), 0);
  return create('div', { 'data-testid': 'onboarding-draft-existing', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('onboarding.draft.existing.title')),
    create('p', { style: MESSAGE_STYLE }, t('onboarding.draft.existing.body', { items: items.length, minutes })),
    create('p', { style: NOTE_STYLE }, t('onboarding.confirm.draftNote')));
}

/** Shared footer for the middle steps. */
function renderStepToolbar(create, t, props, options) {
  return create('div', { style: TOOLBAR_STYLE },
    options.back === true ? create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onBack }, t('onboarding.back')) : null,
    options.later === true ? create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onLater }, t('onboarding.later')) : null,
    options.skip === true ? create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onSkip }, t('onboarding.skip')) : null);
}

/** Render the confirmation step, including the trial gate and missing info. */
function renderConfirmStep(create, t, props) {
  const { view } = props;
  const capacity = view.capacity;
  const requiresTrial = capacity?.requiresTrial === true || view.draft?.data?.trial === true;
  const verdict = capacity === null || capacity === undefined
    ? t('onboarding.confirm.verdict.unknown')
    : t(VERDICT_KEYS[capacity.verdict] ?? 'onboarding.confirm.verdict.unknown');
  const draftData = view.draft?.data ?? null;
  const diff = view.applied?.data === null || view.applied?.data === undefined
    ? (draftData === null ? null : diffPlanDocuments(null, draftData))
    : (draftData === null ? null : diffPlanDocuments(view.applied.data, draftData));
  const missing = missingPlanInfo({
    plan: view.plan,
    applied: view.applied,
    draft: view.draft,
    capacity,
    goal: view.goal,
    materials: view.materials,
  });
  const unscheduled = capacity?.unscheduled ?? null;
  return create('div', { 'data-testid': 'onboarding-confirm', style: STEP_BODY_STYLE },
    create('div', { style: CARD_STYLE },
      create('h2', { style: SECTION_STYLE }, t('onboarding.confirm.title')),
      create('p', { style: NOTE_STYLE }, t('onboarding.confirm.hint')),
      create('p', { 'data-testid': 'onboarding-confirm-title', style: MESSAGE_STYLE }, view.plan?.title ?? '—'),
      create('p', { 'data-testid': 'onboarding-confirm-capacity', style: MESSAGE_STYLE }, t('onboarding.confirm.capacity', { verdict })),
      unscheduled === null || unscheduled.count === 0
        ? null
        : create('p', { 'data-testid': 'onboarding-confirm-unscheduled', style: MESSAGE_STYLE }, t('onboarding.confirm.unscheduled', { count: unscheduled.count, minutes: unscheduled.minutes })),
      requiresTrial ? renderTrialGate(create, t, props) : null,
      diff === null ? null : create('div', { 'data-testid': 'onboarding-confirm-diff' },
        create('h3', { style: SUBHEADING_STYLE }, t('onboarding.diff.title')),
        create('p', { style: NOTE_STYLE }, summarizeDiff(t, diff))),
      create('p', { style: NOTE_STYLE }, t('onboarding.confirm.draftNote')),
      renderMissingPlan(create, t, missing),
      create('div', { style: TOOLBAR_STYLE },
        create('button', {
          type: 'button',
          'data-testid': 'onboarding-confirm-submit',
          style: BUTTON_PRIMARY_STYLE,
          disabled: view.busy || (requiresTrial && view.trialAcknowledged !== true),
          onClick: props.onConfirm,
        }, view.busy ? t('onboarding.confirm.busy') : t('onboarding.confirm.submit')),
        create('button', { type: 'button', 'data-testid': 'onboarding-confirm-back', style: BUTTON_STYLE, onClick: props.onBack }, t('onboarding.back')),
        create('button', { type: 'button', 'data-testid': 'onboarding-confirm-later', style: BUTTON_STYLE, onClick: props.onLater }, t('onboarding.later')),
        create('button', { type: 'button', 'data-testid': 'onboarding-confirm-skip', style: BUTTON_STYLE, onClick: props.onSkip }, t('onboarding.skip')))));
}

/** The explicit trial acknowledgement; without it the confirmation is blocked. */
function renderTrialGate(create, t, props) {
  const { view } = props;
  return create('div', { 'data-testid': 'onboarding-trial-gate', style: WARNING_CARD_STYLE },
    create('h3', { style: SUBHEADING_STYLE }, t('onboarding.confirm.trial.title')),
    create('p', { style: MESSAGE_STYLE }, t('onboarding.confirm.trial.body')),
    view.capacity?.risks?.length
      ? create('ul', { 'data-testid': 'onboarding-trial-risks', style: BULLETS_STYLE }, view.capacity.risks.map((risk, index) => create('li', { key: `risk-${index}` }, risk)))
      : null,
    create('label', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
      create('input', {
        type: 'checkbox',
        'data-testid': 'onboarding-trial-ack',
        checked: view.trialAcknowledged === true,
        onChange: event => props.onTrialAck(event.target.checked),
      }),
      create('span', null, t('onboarding.confirm.trial.ack'))),
    field(create, t('onboarding.confirm.trial.reviewAt'), create('input', {
      name: 'reviewAt',
      type: 'date',
      value: view.reviewAt ?? '',
      style: INPUT_STYLE,
      onChange: event => props.onReviewAt(event.target.value),
    })),
    create('p', { style: NOTE_STYLE }, t('onboarding.confirm.trial.reviewAtHint')));
}

/** Render the missing-information entries the plan service implies. */
export function renderMissingPlan(create, t, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return create('p', { 'data-testid': 'onboarding-missing-none', style: NOTE_STYLE }, t('plan.missing.none'));
  }
  return create('div', { 'data-testid': 'onboarding-missing', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('onboarding.confirm.missingTitle')),
    create('ul', { style: BULLETS_STYLE }, entries.map((entry, index) => create('li', {
      key: `${entry.code}-${index}`,
      'data-testid': `onboarding-missing-${entry.code === 'goalField' ? entry.field : entry.code}`,
    }, missingEntryText(t, entry)))));
}

/** Render the completed state after a confirmation or an existing formal plan. */
function renderDoneStep(create, t, props) {
  const { view } = props;
  const revision = view.plan?.revision ?? view.applied?.number ?? 0;
  const statusKey = STATUS_KEYS[view.plan?.status] ?? 'onboarding.status.active';
  const diff = view.confirmDiff ?? view.revisions?.[0]?.diff ?? null;
  return create('div', { 'data-testid': 'onboarding-done', style: STEP_BODY_STYLE },
    create('div', { style: CARD_STYLE },
      create('h2', { style: SECTION_STYLE }, t('onboarding.done.title')),
      create('p', { style: MESSAGE_STYLE }, t('onboarding.done.existing')),
      create('p', { 'data-testid': 'onboarding-done-status', style: MESSAGE_STYLE }, t('onboarding.done.body', { revision, status: t(statusKey) })),
      view.plan?.trial === true
        ? create('p', { 'data-testid': 'onboarding-done-trial', style: MESSAGE_STYLE }, view.plan.reviewAt === null
          ? t('plan.trial.noReview')
          : t('onboarding.done.trial', { reviewAt: view.plan.reviewAt }))
        : null,
      diff === null ? null : create('p', { 'data-testid': 'onboarding-done-changes', style: NOTE_STYLE }, t('onboarding.done.changes', { summary: summarizeDiff(t, diff) })),
      create('p', { style: NOTE_STYLE }, t('onboarding.done.openPlan')),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', 'data-testid': 'onboarding-restart', style: BUTTON_STYLE, onClick: props.onRestart }, t('onboarding.done.restart')))));
}

/** Render the skipped state: no write, no blocker. */
function renderSkippedStep(create, t, props) {
  return create('div', { 'data-testid': 'onboarding-skipped', style: STEP_BODY_STYLE },
    create('div', { style: CARD_STYLE },
      create('h2', { style: SECTION_STYLE }, t('onboarding.skip.title')),
      create('p', { style: MESSAGE_STYLE }, t('onboarding.skip.body')),
      create('p', { 'data-testid': 'onboarding-skip-nowrite', style: NOTE_STYLE }, t('onboarding.skip.noWrite')),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', 'data-testid': 'onboarding-restart', style: BUTTON_STYLE, onClick: props.onRestart }, t('onboarding.restart')))));
}

/** Wrap one labelled control; `grow` is for fields placed in a flex row. */
function field(create, label, control, { grow = false } = {}) {
  return create('label', { style: grow ? FIELD_ROW_STYLE : FIELD_STYLE },
    create('span', null, label),
    control);
}

/**
 * Pick the text shown for a failed call: a localized line for transport
 * failures, the host's own message for service failures.
 * @param {Function} t - Translator.
 * @param {unknown} error - Rejection value.
 * @returns {string} Display text.
 */
function describeError(t, error) {
  if (error instanceof Error && error.code === 'network') return t('common.networkError');
  return error instanceof Error ? error.message : String(error);
}
