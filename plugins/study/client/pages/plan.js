/**
 * Plan page: stage and week goals, tasks, revision differences, capacity risks
 * and undo. It reads the plans service only and never computes a schedule.
 *
 * The page shows the formal revision and, next to it, any unconfirmed draft.
 * The draft card spells out its difference from the formal arrangement and
 * repeats that a draft changes nothing until confirmed. Material sources open
 * as `<details>` disclosures with the material title, locator and the fields
 * the source did not prove, so a citation is inspectable without a second page.
 * Undo appends one revision through the service and is only offered for the
 * latest revision; nothing is ever deleted or rewritten here.
 *
 * `PlanView` and the exported helpers (diff, missing information, material
 * source, undo payload) are pure, so Node tests cover every rendered state and
 * the write payloads without a browser.
 */
import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react';
import { notifyStudyDataChanged } from '../lib/refresh.js';
import { resolveWorkspaceLinks, useWorkspaceItems } from '../lib/workspaces.js';

const DIFF_FIELDS = ['title', 'subject', 'materialId', 'locator', 'estimateMinutes', 'date', 'start', 'end', 'flexible', 'completion', 'dependencies', 'note', 'projectId'];
const PROJECT_KIND_KEYS = {
  workbook: 'plan.projects.kind.workbook',
  chapter: 'plan.projects.kind.chapter',
  course: 'plan.projects.kind.course',
  review: 'plan.projects.kind.review',
  other: 'plan.projects.kind.other',
};
const ACTION_KEYS = { confirm: 'plan.action.confirm', revise: 'plan.action.revise', undo: 'plan.action.undo' };
const STATUS_KEYS = { draft: 'plan.status.draft', active: 'plan.status.active', trial: 'plan.status.trial' };
const REVISION_STATUS_KEYS = { applied: 'plan.status.applied', superseded: 'plan.status.superseded', undone: 'plan.status.undone' };
const PROGRESS_KEYS = {
  unrecorded: 'plan.progress.status.unrecorded',
  not_started: 'plan.progress.status.notStarted',
  in_progress: 'plan.progress.status.inProgress',
  partial: 'plan.progress.status.partial',
  done: 'plan.progress.status.done',
  cancelled: 'plan.progress.status.cancelled',
};
const VERDICT_KEYS = {
  fits: 'plan.capacity.verdict.fits',
  partial: 'plan.capacity.verdict.partial',
  over_capacity: 'plan.capacity.verdict.over',
};
const SOURCE_FIELD_KEYS = {
  page: 'plan.source.field.page',
  chapter: 'plan.source.field.chapter',
  exercise: 'plan.source.field.exercise',
};
const MATERIAL_MISSING_KEYS = {
  edition: 'plan.material.missing.edition',
  toc: 'plan.material.missing.toc',
  page: 'plan.material.missing.page',
  chapter: 'plan.material.missing.chapter',
};

const ROOT_STYLE = { padding: '28px 32px 48px', maxWidth: '980px', display: 'flex', flexDirection: 'column', gap: '18px' };
const HEADER_STYLE = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' };
const TITLE_STYLE = { margin: 0, fontSize: '20px', fontWeight: 600, letterSpacing: '0.01em' };
const SUBTITLE_STYLE = { margin: '6px 0 0', fontSize: '13px', lineHeight: 1.6, opacity: 0.68, maxWidth: '64ch' };
const TOOLBAR_STYLE = { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' };
const BUTTON_STYLE = {
  appearance: 'none', border: '1px solid rgba(127, 127, 127, 0.45)', borderRadius: '6px',
  background: 'transparent', color: 'inherit', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
};
const CARD_STYLE = { border: '1px solid rgba(127, 127, 127, 0.28)', borderRadius: '10px', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '10px' };
const WARNING_CARD_STYLE = { ...CARD_STYLE, borderColor: 'rgba(194, 65, 12, 0.5)' };
const DRAFT_CARD_STYLE = { ...CARD_STYLE, borderStyle: 'dashed' };
const MESSAGE_STYLE = { margin: 0, fontSize: '13px', lineHeight: 1.6, opacity: 0.82 };
const ERROR_STYLE = { ...MESSAGE_STYLE, color: '#c2410c' };
const NOTE_STYLE = { margin: 0, fontSize: '12px', lineHeight: 1.6, opacity: 0.66 };
const LIST_STYLE = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' };
const ROW_STYLE = { display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid rgba(127, 127, 127, 0.18)' };
const MAIN_STYLE = { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'baseline' };
const META_STYLE = { display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12px', opacity: 0.72, margin: '3px 0 0' };
const BADGE_STYLE = { border: '1px solid rgba(127, 127, 127, 0.4)', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', opacity: 0.85 };
const PENDING_STYLE = { ...BADGE_STYLE, borderStyle: 'dashed' };
const SECTION_STYLE = { margin: 0, fontSize: '15px', fontWeight: 600 };
const BULLETS_STYLE = { margin: 0, paddingLeft: '18px', fontSize: '12.5px', lineHeight: 1.7 };
const SUMMARY_STYLE = { display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '13px' };
const DETAIL_STYLE = { margin: '4px 0 0', padding: '8px 10px', border: '1px solid rgba(127, 127, 127, 0.2)', borderRadius: '6px', fontSize: '12.5px', lineHeight: 1.7 };
const SOURCE_STYLE = { margin: '4px 0 0', fontSize: '12px', lineHeight: 1.7, opacity: 0.85 };
const DAY_STYLE = { display: 'flex', flexDirection: 'column', gap: '6px' };
const DAY_HEADER_STYLE = { display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', alignItems: 'baseline', borderTop: '1px solid rgba(127, 127, 127, 0.2)', paddingTop: '8px' };

/** One discovered page: contract consumed by `client/plugin.js`. */
export default {
  key: 'plan',
  order: 16,
  label: 'plan.panel',
  Page: PlanPage,
};

/** Join display parts without hardcoding punctuation in either locale. */
function joinParts(values) {
  return values.filter(value => value !== null && value !== undefined && String(value).length > 0).join(' · ');
}

/** JSON with stable key order for the changed-field comparison. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/** One item's display id, title and date, without the full document. */
function slimItem(item) {
  return { id: item.id, title: item.title, date: item.date ?? null, estimateMinutes: item.estimateMinutes ?? null };
}

/** Sum the estimated minutes of a list of items. */
function minutesOf(items) {
  return items.reduce((sum, item) => sum + (Number(item.estimateMinutes) || 0), 0);
}

/**
 * Compare two plan documents for display. This is the page's own view of the
 * differences; the plans service remains the authority that stores the diff of
 * each applied revision.
 * @param {object | null} beforeData - Applied plan document, or null.
 * @param {object | null} afterData - Draft or newer plan document, or null.
 * @returns {object} Added, removed and changed items plus the document-level flags.
 */
export function diffPlanDocuments(beforeData, afterData) {
  const beforeItems = Array.isArray(beforeData?.items) ? beforeData.items : [];
  const afterItems = Array.isArray(afterData?.items) ? afterData.items : [];
  const beforeById = new Map(beforeItems.map(item => [item.id, item]));
  const afterById = new Map(afterItems.map(item => [item.id, item]));
  const added = afterItems.filter(item => !beforeById.has(item.id)).map(slimItem);
  const removed = beforeItems.filter(item => !afterById.has(item.id)).map(slimItem);
  const changed = [];
  for (const item of afterItems) {
    const previous = beforeById.get(item.id);
    if (previous === undefined) continue;
    const fields = DIFF_FIELDS.filter(field => canonical(previous[field]) !== canonical(item[field]));
    if (fields.length > 0) changed.push({ id: item.id, title: item.title, fields });
  }
  return {
    added,
    removed,
    changed,
    projectsChanged: canonical(beforeData?.projects ?? []) !== canonical(afterData?.projects ?? []),
    titleChanged: (beforeData?.title ?? null) !== (afterData?.title ?? null),
    goalsChanged: canonical({ stageGoals: beforeData?.stageGoals ?? null, weekGoals: beforeData?.weekGoals ?? null })
      !== canonical({ stageGoals: afterData?.stageGoals ?? null, weekGoals: afterData?.weekGoals ?? null }),
    availabilityChanged: canonical(beforeData?.availability ?? null) !== canonical(afterData?.availability ?? null),
    totals: {
      beforeItems: beforeItems.length,
      afterItems: afterItems.length,
      beforeMinutes: minutesOf(beforeItems),
      afterMinutes: minutesOf(afterItems),
    },
  };
}

/**
 * One sentence describing a diff, built from localized fragments.
 * @param {Function} t - Translator.
 * @param {object | null} diff - Diff from `diffPlanDocuments` or a revision row.
 * @returns {string} Display text.
 */
export function summarizeDiff(t, diff) {
  if (diff === null || diff === undefined) return t('plan.diff.noChanges');
  const parts = [t('plan.diff.summary', {
    added: Array.isArray(diff.added) ? diff.added.length : 0,
    changed: Array.isArray(diff.changed) ? diff.changed.length : 0,
    removed: Array.isArray(diff.removed) ? diff.removed.length : 0,
  })];
  if (diff.titleChanged === true) parts.push(t('plan.diff.titleChanged'));
  if (diff.projectsChanged === true) parts.push(t('plan.diff.projectsChanged'));
  if (diff.goalsChanged === true) parts.push(t('plan.diff.goalsChanged'));
  if (diff.availabilityChanged === true) parts.push(t('plan.diff.availabilityChanged'));
  return joinParts(parts);
}

/**
 * Resolve one item's material citation without guessing what the source did
 * not prove.
 * @param {object} item - Plan item.
 * @param {Map<string, object>} materialsById - Known materials.
 * @returns {object} Citation parts and whether anything is present.
 */
export function materialSourceOf(item, materialsById) {
  const locator = item?.locator ?? null;
  const materialId = typeof item?.materialId === 'string' && item.materialId.length > 0 ? item.materialId : null;
  const material = materialId === null ? null : (materialsById?.get?.(materialId) ?? null);
  const chapter = locator?.chapter ?? null;
  const page = locator?.page ?? null;
  const exercise = locator?.exercise ?? null;
  const unverified = Array.isArray(locator?.unverified) ? locator.unverified : [];
  return {
    present: materialId !== null || chapter !== null || page !== null || exercise !== null,
    materialId,
    material,
    chapter,
    page,
    exercise,
    unverified,
    missingMaterial: materialId !== null && material === null,
  };
}

/**
 * The missing-information entries implied by the plan, its goal and its
 * materials. Each entry is data; the view localizes it.
 * @param {{ plan: object | null, applied: object | null, draft: object | null,
 *   capacity: object | null, goal: object | null, materials: object[] }} input - Plan state.
 * @returns {Array<{ code: string, field?: string, count?: number }>} Entries in display order.
 */
export function missingPlanInfo({ plan, applied, draft, capacity, goal, materials }) {
  if (plan === null || plan === undefined) return [{ code: 'noPlan' }];
  const entries = [];
  if (goal === null || goal === undefined) {
    entries.push({ code: 'noGoal' });
  } else {
    for (const field of Array.isArray(goal.missing) ? goal.missing : []) entries.push({ code: 'goalField', field });
  }
  const data = applied?.data ?? draft?.data ?? null;
  const items = Array.isArray(data?.items) ? data.items : [];
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  if (items.length === 0) entries.push({ code: 'noItems' });
  if (items.length > 0 && projects.length === 0) entries.push({ code: 'noProjects' });
  const projectIds = new Set(projects.map(project => project.id));
  const ungrouped = projects.length === 0
    ? 0
    : items.filter(item => typeof item.projectId !== 'string' || !projectIds.has(item.projectId)).length;
  if (ungrouped > 0) entries.push({ code: 'ungrouped', count: ungrouped });
  if (!Array.isArray(data?.stageGoals) || data.stageGoals.length === 0) entries.push({ code: 'noStageGoals' });
  if (!Array.isArray(data?.weekGoals) || data.weekGoals.length === 0) entries.push({ code: 'noWeekGoals' });
  const unscheduled = items.filter(item => item.date === null).length;
  if (unscheduled > 0) entries.push({ code: 'unscheduled', count: unscheduled });
  const unknownDays = Array.isArray(capacity?.days)
    ? capacity.days.filter(day => day.availabilitySource === 'unknown').length
    : 0;
  if (unknownDays > 0) entries.push({ code: 'unknownAvailability', count: unknownDays });
  const unverified = items.filter(item => Array.isArray(item.locator?.unverified) && item.locator.unverified.length > 0).length;
  if (unverified > 0) entries.push({ code: 'unverifiedLocator', count: unverified });
  const known = new Set((materials ?? []).map(material => material.id));
  const missingMaterial = items.filter(item => typeof item.materialId === 'string' && !known.has(item.materialId)).length;
  if (missingMaterial > 0) entries.push({ code: 'missingMaterial', count: missingMaterial });
  if ((applied === null || applied === undefined) && draft !== null && draft !== undefined) entries.push({ code: 'draftOnly' });
  return entries;
}

/**
 * One missing-information entry as display text.
 * @param {Function} t - Translator.
 * @param {{ code: string, field?: string, count?: number }} entry - Entry from `missingPlanInfo`.
 * @returns {string} Display text.
 */
export function missingEntryText(t, entry) {
  if (entry.code === 'goalField') return t(`plan.missing.${entry.field}`);
  if (entry.code === 'unscheduled') return t('plan.missing.unscheduled', { count: entry.count });
  if (entry.code === 'ungrouped') return t('plan.missing.ungrouped', { count: entry.count });
  if (entry.code === 'unknownAvailability') return t('plan.missing.unknownAvailability', { count: entry.count });
  if (entry.code === 'unverifiedLocator') return t('plan.missing.unverifiedLocator', { count: entry.count });
  if (entry.code === 'missingMaterial') return t('plan.missing.missingMaterial', { count: entry.count });
  return t(`plan.missing.${entry.code}`);
}

/**
 * The undo payload for the latest formal revision. A pending draft is named so
 * the service does not silently discard a student edit.
 * @param {object} planData - `plans.get` value.
 * @returns {object | null} Payload, or null when there is no formal revision.
 */
export function undoPayload(planData) {
  const plan = planData?.plan;
  if (plan === null || plan === undefined || !(plan.revision > 0)) return null;
  const payload = { planId: plan.id, baseRevision: plan.revision };
  if (planData?.draft) payload.expectedDraftRevision = planData.draft.draftRevision;
  if (typeof planData?.draft?.id === 'string' && planData.draft.id.length > 0) payload.draftId = planData.draft.id;
  return payload;
}

/** Format an ISO timestamp in the reader's local time. */
function formatTime(value) {
  if (typeof value !== 'string' || value.length === 0) return '—';
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? value : instant.toLocaleString();
}

/**
 * Page body: loads the plan, the item-level progress and the materials, then
 * runs undo through the service.
 * @param {{ t: Function, call: Function }} props - Framework locale seat and study route caller.
 * @returns {object} Page element.
 */
function PlanPage({ t, call, workspaceList }) {
  const workspaceItems = useWorkspaceItems(workspaceList);
  const [view, setView] = useState({ phase: 'loading' });
  const viewRef = useMemo(() => ({ current: view }), []);
  const busy = useMemo(() => ({ current: false }), []);
  const sequence = useMemo(() => ({ current: 0 }), []);

  const applyView = useCallback(next => {
    const resolved = typeof next === 'function' ? next(viewRef.current) : next;
    viewRef.current = resolved;
    setView(resolved);
  }, []);

  const load = useCallback(async (options = {}) => {
    const current = sequence.current + 1;
    sequence.current = current;
    if (!options.silent) applyView({ phase: 'loading' });
    try {
      const envelope = await call('plans', 'get', {});
      if (current !== sequence.current) return null;
      const data = envelope.value ?? {};
      const warnings = [];
      let materials = [];
      try {
        const materialEnvelope = await call('materials', 'list', {});
        materials = materialEnvelope.value?.materials ?? [];
      } catch (error) {
        warnings.push(t('plan.error.materials', { message: describeError(t, error) }));
      }
      let goal = null;
      if (data.plan?.goalId) {
        try {
          const goalEnvelope = await call('materials', 'getGoal', { id: data.plan.goalId });
          goal = goalEnvelope.value?.goal ?? null;
        } catch (error) {
          warnings.push(t('plan.error.goal', { message: describeError(t, error) }));
        }
      }
      let progressItems = [];
      if (data.applied !== null && data.applied !== undefined) {
        try {
          const progressEnvelope = await call('plans', 'progress', {});
          progressItems = progressEnvelope.value?.items ?? [];
        } catch (error) {
          warnings.push(t('plan.error.progress', { message: describeError(t, error) }));
        }
      }
      if (current !== sequence.current) return null;
      applyView({
        phase: 'ready',
        value: data,
        materials,
        goal,
        progressItems,
        warnings,
        revision: envelope.revision,
        error: null,
        notice: null,
        busy: false,
      });
      return data;
    } catch (error) {
      if (current !== sequence.current) return null;
      applyView(currentView => (currentView.phase === 'ready' && options.silent
        ? { ...currentView, error: t('plan.error.load', { message: describeError(t, error) }), busy: false }
        : { phase: 'error', message: describeError(t, error) }));
      return null;
    }
  }, [applyView, call, sequence, t]);

  useEffect(() => { void load(); }, [load]);

  const undo = useCallback(async () => {
    const current = viewRef.current;
    if (current.phase !== 'ready' || busy.current) return;
    const payload = undoPayload(current);
    if (payload === null) return;
    if (!confirmAction(t('plan.undo.confirm'))) return;
    busy.current = true;
    applyView(viewState => ({ ...viewState, busy: true, error: null, notice: null }));
    try {
      const envelope = await call('plans', 'undo', {...payload,expectedDraftRevision:viewRef.current.value?.draft?.draftRevision??0,requestId:globalThis.crypto.randomUUID()});
      const value = envelope.value;
      await load({ silent: true });
      busy.current = false;
      notifyStudyDataChanged('plans.undo');
      applyView(viewState => (viewState.phase === 'ready'
        ? {
          ...viewState,
          busy: false,
          notice: t('plan.undo.done', { number: payload.baseRevision, revision: value.plan.revision }),
        }
        : viewState));
    } catch (error) {
      busy.current = false;
      applyView(viewState => (viewState.phase === 'ready'
        ? { ...viewState, busy: false, error: t('plan.undo.failed', { message: describeError(t, error) }) }
        : viewState));
    }
  }, [applyView, busy, call, load, t]);

  const refresh = useCallback(() => {
    applyView(current => (current.phase === 'ready' ? { ...current, error: null, notice: null } : current));
    void load({ silent: true });
  }, [applyView, load]);

  const write = async (method, payload) => {
    if (busy.current) return;
    busy.current = true;
    applyView(v=>({...v,busy:true,error:null}));
    try {
      await call('plans',method,{...payload,expectedDraftRevision:viewRef.current.value?.draft?.draftRevision??0,requestId:globalThis.crypto.randomUUID()});
      await load({silent:true});
      notifyStudyDataChanged(`plans.${method}`);
    } catch(error) { applyView(v=>({...v,busy:false,error:error.message})); }
    finally { busy.current=false; }
  };
  return PlanView({
    create: h,
    t,
    view,
    workspaceItems,
    onRetry: () => { void load(); },
    onRefresh: refresh,
    onUndo: () => { void undo(); },
    onMoveBlock: async (block,date) => {
      try {
        await call('tasks','moveBlock',{id:block.id,date,start:block.start,end:block.end,requestId:globalThis.crypto.randomUUID()});
        await load({silent:true});
        notifyStudyDataChanged('plans.move');
      } catch(error) {applyView(v=>({...v,error:error.message}));}
    },
    onConfirm: () => {
      const data=viewRef.current.value;
      if (data.capacity?.requiresTrial && !confirmAction(t('daily.trialConfirm'))) return;
      void write(data.plan.revision ? 'revise':'confirm', {planId:data.plan.id,baseRevision:data.plan.revision,draftId:data.draft.id,expectedDraftRevision:data.draft.draftRevision,
        ...(data.plan.revision ? data.draft.data : {}),trial:data.capacity?.requiresTrial || data.draft.data.trial,reason:t(data.plan.revision ? 'daily.apply':'daily.confirm')});
    },
    onProgress: (item,status) => {
      const data=viewRef.current.value;
      let quantityDone,quantityTotal;
      if (status==='partial') {
        const done=globalThis.prompt?.(t('daily.doneQuantity'));
        if(done===null) return;
        const total=globalThis.prompt?.(t('daily.totalQuantity'));
        if(total===null) return;
        quantityDone=Number(done);quantityTotal=Number(total);
      }
      void write('recordProgress',{planId:data.plan.id,itemId:item.id,status,quantityDone,quantityTotal,confirmed:true});
    },
  });
}

/**
 * Render one state of the plan page.
 * @param {object} props - Render inputs; see `PlanPage` for producers.
 * @param {Function} props.create - React element factory.
 * @param {Function} props.t - Translator.
 * @param {object} props.view - Page state.
 * @returns {object} Section element.
 */
export function PlanView(props) {
  const { create, t, view } = props;
  const ready = view.phase === 'ready';
  const data = ready ? view.value : null;
  const plan = data?.plan ?? null;
  const applied = data?.applied ?? null;
  const draft = data?.draft ?? null;
  const revisions = data?.revisions ?? [];
  const capacity = data?.capacity ?? null;
  const materials = view.materials ?? [];
  const goal = view.goal ?? null;
  const materialsById = new Map(materials.map(material => [material.id, material]));
  const progressItems = view.progressItems ?? [];
  const progressByItem = new Map(progressItems.map(item => [item.id, item.progress]));
  const official = applied?.data ?? null;
  const visibleData = draft?.data ?? official;
  const items = Array.isArray(visibleData?.items) ? visibleData.items : [];
  const titlesById = new Map(items.map(item => [item.id, item.title]));
  const missing = ready ? missingPlanInfo({ plan, applied, draft, capacity, goal, materials }) : [];
  const workspaceLinks = resolveWorkspaceLinks(goal?.workspaceIds, props.workspaceItems ?? []);
  const undo = undoPayload(data);
  return create('section', {
    'data-testid': 'study-plan',
    'data-page': 'plan',
    'data-revision': plan?.revision ?? 0,
    style: ROOT_STYLE,
  },
  create('div', { style: HEADER_STYLE },
    create('div', null,
      create('h1', { style: TITLE_STYLE }, t('plan.title')),
      create('p', { style: SUBTITLE_STYLE }, t('plan.subtitle'))),
    create('div', { style: TOOLBAR_STYLE },
      create('button', { type: 'button', 'data-testid': 'plan-refresh', style: BUTTON_STYLE, disabled: !ready, onClick: props.onRefresh }, t('plan.refresh')),
      create('button', {
        type: 'button',
        'data-testid': 'plan-undo',
        style: undo === null ? BUTTON_STYLE : { ...BUTTON_STYLE, borderColor: 'currentColor' },
        disabled: undo === null || view.busy === true,
        title: t('plan.undo.note'),
        onClick: props.onUndo,
      }, view.busy === true ? t('plan.undo.busy') : t('plan.undo')))),
  ready && view.notice ? create('p', { 'data-testid': 'plan-notice', role: 'status', style: MESSAGE_STYLE }, view.notice) : null,
  ready && view.error ? create('p', { 'data-testid': 'plan-error', role: 'alert', style: ERROR_STYLE }, view.error) : null,
  ready && Array.isArray(view.warnings)
    ? view.warnings.map((warning, index) => create('p', { key: `warning-${index}`, 'data-testid': 'plan-warning', role: 'alert', style: ERROR_STYLE }, warning))
    : null,
  renderBody(create, t, props, { ready, plan, applied, draft, revisions, capacity, materialsById, titlesById, progressByItem, progress: data?.progress ?? null, missing, official, undo, workspaceLinks, onProgress:props.onProgress, onConfirm:props.onConfirm, busy:view.busy, onMoveBlock:props.onMoveBlock }));
}

/** Render the loading, error or empty state. */
function renderBody(create, t, props, derived) {
  const { view } = props;
  if (view.phase === 'loading') {
    return create('p', { 'data-testid': 'study-loading', role: 'status', style: MESSAGE_STYLE }, t('plan.loading'));
  }
  if (view.phase === 'error') {
    return create('div', { style: CARD_STYLE },
      create('p', { 'data-testid': 'study-error', role: 'alert', style: ERROR_STYLE }, t('plan.error.load', { message: view.message })),
      create('div', null, create('button', { type: 'button', 'data-testid': 'plan-retry', style: BUTTON_STYLE, onClick: props.onRetry }, t('plan.retry'))));
  }
  if (derived.plan === null) {
    return create('div', { 'data-testid': 'plan-empty', style: CARD_STYLE },
      create('h2', { style: SECTION_STYLE }, t('plan.empty.title')),
      create('p', { style: MESSAGE_STYLE }, t('plan.empty.body')),
      create('p', { style: NOTE_STYLE }, t('plan.empty.actionHint')));
  }
  const { draft, capacity } = derived;
  return create('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
    renderSummary(create, t, props, derived),
    renderTrial(create, t, derived),
    draft === null || draft === undefined ? null : renderDraft(create, t, derived),
    renderMissing(create, t, derived.missing),
    renderProjects(create, t, derived),
    renderGoals(create, t, derived),
    draft === null || draft === undefined ? renderCapacity(create, t, capacity) : null,
    renderProgress(create, t, derived),
    renderTasks(create, t, derived),
    renderRevisions(create, t, derived));
}

/** Render the formal revision card. */
function renderSummary(create, t, props, derived) {
  const { plan, applied, official } = derived;
  const officialItems = Array.isArray(official?.items) ? official.items : [];
  const statusKey = STATUS_KEYS[plan.status] ?? 'plan.status.active';
  // Review can leave part of a split item unscheduled; count the item once in
  // the summary rather than hiding the remainder behind its placed block.
  const unscheduled = plan.counts === undefined || plan.counts === null
    ? officialItems.filter(item => item.date === null).length
    : Number(plan.counts.unscheduledItems ?? 0) + Number(plan.counts.partialUnscheduledItems ?? 0);
  const projectCount = Array.isArray(official?.projects) ? official.projects.length : 0;
  return create('div', { 'data-testid': 'plan-summary', style: CARD_STYLE },
    create('div', { style: MAIN_STYLE },
      create('h2', { style: SECTION_STYLE }, plan.title),
      create('span', { 'data-testid': 'plan-status', style: BADGE_STYLE }, t(statusKey)),
      create('span', { 'data-testid': 'plan-revision', style: BADGE_STYLE }, t('plan.revision', { revision: plan.revision })),
      plan.status === 'trial' ? create('span', { style: PENDING_STYLE }, t('plan.status.trial')) : null),
    create('div', { style: SUMMARY_STYLE },
      projectCount === 0 ? null : create('span', { 'data-testid': 'plan-counts-projects' }, t('plan.counts.projects', { count: projectCount })),
      create('span', { 'data-testid': 'plan-counts' }, t('plan.counts', { items: officialItems.length, minutes: minutesOf(officialItems) })),
      unscheduled === 0 ? null : create('span', { 'data-testid': 'plan-counts-unscheduled' }, t('plan.counts.unscheduled', { count: unscheduled }))),
    derived.workspaceLinks.length === 0
      ? null
      : create('p', { 'data-testid': 'plan-workspaces', style: NOTE_STYLE }, joinParts([
        t('common.linkedWorkspaces'),
        ...derived.workspaceLinks.map(link => (link.missing ? t('common.workspaceMissing') : link.title ?? link.workspaceId)),
      ])),
    applied === null || applied === undefined ? null : create('p', { style: NOTE_STYLE }, joinParts([
      applied.reason ? t('plan.applied.reason', { reason: applied.reason }) : null,
      applied.appliedAt ? t('plan.applied.at', { at: formatTime(applied.appliedAt) }) : null,
    ])),
    derived.draft === null || derived.draft === undefined ? null : create('p', { 'data-testid': 'plan-draft-pending-note', style: NOTE_STYLE }, t('plan.notice.draftPending')));
}

/** Render the official trial banner and its review date. */
function renderTrial(create, t, derived) {
  const official = derived.official;
  if (official === null || official === undefined || official.trial !== true) return null;
  const reasons = [];
  if (derived.draft === null || derived.draft === undefined) {
    if (Array.isArray(derived.capacity?.risks)) reasons.push(...derived.capacity.risks);
  }
  return create('div', { 'data-testid': 'plan-trial', style: WARNING_CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('plan.trial.title')),
    create('p', { style: MESSAGE_STYLE }, official.reviewAt === null || official.reviewAt === undefined
      ? t('plan.trial.noReview')
      : t('plan.trial.body', { reviewAt: official.reviewAt })),
    reasons.length === 0
      ? null
      : create('div', null,
        create('strong', { style: { fontSize: '13px' } }, t('plan.trial.risks')),
        create('ul', { style: BULLETS_STYLE }, reasons.map((reason, index) => create('li', { key: `risk-${index}` }, reason)))));
}

/** Render the unconfirmed draft, its difference and its items. */
function renderDraft(create, t, derived) {
  const { draft, applied, capacity } = derived;
  const draftData = draft.data ?? {};
  const draftItems = Array.isArray(draftData.items) ? draftData.items : [];
  const diff = diffPlanDocuments(applied?.data ?? null, draftData);
  return create('div', { 'data-testid': 'plan-draft', style: DRAFT_CARD_STYLE },
    create('div', { style: MAIN_STYLE },
      create('h2', { style: SECTION_STYLE }, t('plan.draft.title')),
      create('span', { style: BADGE_STYLE }, t('plan.draft.badge'))),
    create('p', { style: MESSAGE_STYLE }, t('plan.draft.body')),
    create('button',{type:'button',style:BUTTON_STYLE,'data-testid':'plan-confirm',disabled:derived.busy===true,onClick:derived.onConfirm}, t(derived.plan.revision ? 'daily.apply':'daily.confirm')),
    create('p', { 'data-testid': 'plan-draft-confirm-hint', style: NOTE_STYLE }, t('plan.draft.confirmHint')),
    create('p', { 'data-testid': 'plan-draft-counts', style: NOTE_STYLE }, t('plan.draft.counts', { items: draftItems.length, minutes: minutesOf(draftItems) })),
    capacity?.requiresTrial === true
      ? create('p', { 'data-testid': 'plan-draft-trial', style: ERROR_STYLE }, t('plan.draft.trial'))
      : null,
    create('div', { 'data-testid': 'plan-draft-diff' },
      create('strong', { style: { fontSize: '13px' } }, t('plan.draft.diff')),
      create('p', { style: MESSAGE_STYLE }, summarizeDiff(t, diff)),
      renderDiffDetails(create, t, diff)),
    capacity === null || capacity === undefined ? null : renderCapacity(create, t, capacity),
    draftItems.length === 0 ? null : create('details', { 'data-testid': 'plan-draft-items' },
      create('summary', null, t('plan.draft.itemsSummary', { count: draftItems.length })),
      create('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        groupsOfProjects(draftData).map(group => renderTaskGroup(create, t, derived, group, { draft: true })))));
}

/** Render the missing-information card. */
function renderMissing(create, t, entries) {
  return create('div', { 'data-testid': 'plan-missing', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('plan.missing.title')),
    entries.length === 0
      ? create('p', { style: NOTE_STYLE }, t('plan.missing.none'))
      : create('ul', { style: BULLETS_STYLE }, entries.map((entry, index) => create('li', {
        key: `${entry.code}-${index}`,
        'data-testid': `plan-missing-${entry.code === 'goalField' ? entry.field : entry.code}`,
      }, missingEntryText(t, entry)))));
}

/** Render the plan's projects with their task counts and date range. */
function renderProjects(create, t, derived) {
  const data = derived.draft?.data ?? derived.official;
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  const items = Array.isArray(data?.items) ? data.items : [];
  const byProject = new Map(projects.map(project => [project.id, []]));
  const ungrouped = [];
  for (const item of items) {
    const bucket = typeof item.projectId === 'string' ? byProject.get(item.projectId) : undefined;
    if (bucket === undefined) ungrouped.push(item);
    else bucket.push(item);
  }
  return create('div', { 'data-testid': 'plan-projects', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('plan.projects.title')),
    projects.length === 0
      ? create('p', { 'data-testid': 'plan-projects-empty', style: NOTE_STYLE }, t('plan.projects.empty'))
      : create('ul', { 'data-testid': 'plan-project-list', style: LIST_STYLE }, projects.map(project => {
        const projectItems = byProject.get(project.id) ?? [];
        const dates = projectItems.map(item => item.date).filter(date => date !== null && date !== undefined).sort();
        const material = typeof project.materialId === 'string' ? derived.materialsById.get(project.materialId) : undefined;
        const meta = [
          t('plan.projects.counts', { count: projectItems.length, minutes: minutesOf(projectItems) }),
          dates.length === 0 ? null : t('plan.projects.range', { from: dates[0], to: dates[dates.length - 1] }),
          project.target ? t('plan.projects.target', { target: project.target }) : null,
          project.note ? t('plan.projects.note', { note: project.note }) : null,
          material ? t('plan.projects.material', { title: material.title }) : null,
        ];
        return create('li', { key: project.id, 'data-testid': `plan-project-${project.id}`, style: ROW_STYLE },
          create('div', { style: MAIN_STYLE },
            create('strong', null, project.title),
            create('span', { style: BADGE_STYLE }, t(projectKindKey(project.kind)))),
          create('p', { style: META_STYLE }, joinParts(meta)));
      })),
    ungrouped.length === 0
      ? null
      : create('p', { 'data-testid': 'plan-projects-ungrouped', style: NOTE_STYLE }, t('plan.projects.ungrouped', { count: ungrouped.length })));
}

/** Dictionary key for one project kind, falling back to `other`. */
function projectKindKey(kind) {
  return PROJECT_KIND_KEYS[kind] ?? PROJECT_KIND_KEYS.other;
}

/** Render stage goals and week goals from the newest document. */
function renderGoals(create, t, derived) {
  const data = derived.draft?.data ?? derived.official;
  const stageGoals = Array.isArray(data?.stageGoals) ? data.stageGoals : [];
  const weekGoals = Array.isArray(data?.weekGoals) ? data.weekGoals : [];
  return create('div', { 'data-testid': 'plan-goals', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('plan.goals.title')),
    create('div', null,
      create('h3', { style: { ...SECTION_STYLE, fontSize: '13px' } }, t('plan.goals.stage')),
      stageGoals.length === 0
        ? create('p', { 'data-testid': 'plan-goals-empty-stage', style: NOTE_STYLE }, t('plan.goals.emptyStage'))
        : create('ul', { 'data-testid': 'plan-stage-goals', style: LIST_STYLE }, stageGoals.map(goal => renderGoal(create, t, goal, 'stage')))),
    create('div', null,
      create('h3', { style: { ...SECTION_STYLE, fontSize: '13px' } }, t('plan.goals.week')),
      weekGoals.length === 0
        ? create('p', { 'data-testid': 'plan-goals-empty-week', style: NOTE_STYLE }, t('plan.goals.emptyWeek'))
        : create('ul', { 'data-testid': 'plan-week-goals', style: LIST_STYLE }, weekGoals.map(goal => renderGoal(create, t, goal, 'week')))));
}

/** Render one stage or week goal. */
function renderGoal(create, t, goal, kind) {
  const meta = [];
  if (kind === 'week' && goal.weekStart) meta.push(t('plan.goals.weekStart', { date: goal.weekStart }));
  if (goal.dueDate) meta.push(t('plan.goals.due', { date: goal.dueDate }));
  if (goal.target) meta.push(t('plan.goals.target', { target: goal.target }));
  if (goal.note) meta.push(t('plan.goals.note', { note: goal.note }));
  return create('li', { key: goal.id, 'data-testid': `plan-goal-${goal.id}`, style: ROW_STYLE },
    create('strong', null, goal.title),
    create('span', { style: { fontSize: '12px', opacity: 0.72 } }, joinParts(meta)));
}

/** Render the capacity report for the plan or draft it belongs to. */
function renderCapacity(create, t, capacity) {
  if (capacity === null || capacity === undefined) return null;
  const verdict = t(VERDICT_KEYS[capacity.verdict] ?? 'plan.capacity.verdict.unknown');
  const unscheduled = capacity.unscheduled ?? { count: 0, minutes: 0 };
  const unknownDays = Array.isArray(capacity.days)
    ? capacity.days.filter(day => day.availabilitySource === 'unknown').length
    : 0;
  return create('div', { 'data-testid': 'plan-capacity', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('plan.capacity.title')),
    create('p', { 'data-testid': 'plan-capacity-verdict', style: MESSAGE_STYLE }, verdict),
    create('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '12px', opacity: 0.78 } },
      unscheduled.count === 0 ? null : create('span', { 'data-testid': 'plan-capacity-unscheduled' }, t('plan.capacity.unscheduled', { count: unscheduled.count, minutes: unscheduled.minutes })),
      unknownDays === 0 ? null : create('span', { 'data-testid': 'plan-capacity-unknown' }, t('plan.capacity.unknownDays', { count: unknownDays }))),
    Array.isArray(capacity.risks) && capacity.risks.length > 0
      ? create('div', null,
        create('strong', { style: { fontSize: '13px' } }, t('plan.capacity.risks')),
        create('ul', { 'data-testid': 'plan-capacity-risks', style: BULLETS_STYLE }, capacity.risks.map((risk, index) => create('li', { key: `risk-${index}` }, risk))))
      : null);
}

/** Render the recorded progress summary, keeping "unrecorded" its own state. */
function renderProgress(create, t, derived) {
  const summary = derived.applied === null || derived.applied === undefined ? null : derived.progress;
  if (summary === null || summary === undefined) return null;
  const counts = summary.counts ?? {};
  return create('div', { 'data-testid': 'plan-progress', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('plan.progress.title')),
    create('p', { 'data-testid': 'plan-progress-counts', style: MESSAGE_STYLE }, t('plan.progress.counts', {
      unrecorded: counts.unrecorded ?? 0,
      done: counts.done ?? 0,
      pending: counts.pendingConfirmation ?? 0,
      cancelled: counts.cancelled ?? 0,
    })),
    create('p', { style: NOTE_STYLE }, t('plan.progress.note')));
}

/** Expand an item that was split into execution blocks into one row per block. */
function expandedItems(data) {
  return (Array.isArray(data?.items) ? data.items : []).flatMap(item => item.blocks?.length
    ? item.blocks.map(block => ({ ...item, ...block, id: item.id, blockId: block.id }))
    : [item]);
}

/** Split a plan document's items into one group per project, plus ungrouped work. */
function groupsOfProjects(data) {
  const items = expandedItems(data);
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  if (projects.length === 0) return [{ project: null, items }];
  const groups = projects
    .map(project => ({ project, items: items.filter(item => item.projectId === project.id) }))
    .filter(group => group.items.length > 0);
  const known = new Set(projects.map(project => project.id));
  const ungrouped = items.filter(item => typeof item.projectId !== 'string' || !known.has(item.projectId));
  return ungrouped.length === 0 ? groups : [...groups, { project: null, items: ungrouped }];
}

/** Render the formal task arrangement grouped by project, then by date. */
function renderTasks(create, t, derived) {
  const official = derived.official;
  const items = expandedItems(official);
  return create('div', { 'data-testid': 'plan-tasks', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('plan.tasks.title')),
    items.length === 0
      ? create('p', { 'data-testid': 'plan-tasks-empty', style: MESSAGE_STYLE }, t('plan.tasks.empty'))
      : create('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        groupsOfProjects(official).map(group => renderTaskGroup(create, t, derived, group, {}))),
    items.length === 0 ? null : create('p', { 'data-testid': 'plan-tasks-time-note', style: NOTE_STYLE }, t('plan.tasks.timeNote')));
}

/** Render one project's tasks as dated sections; unscheduled work stays visible. */
function renderTaskGroup(create, t, derived, group, options) {
  const scheduled = group.items
    .filter(item => item.date !== null && item.date !== undefined)
    .sort((left, right) => left.date.localeCompare(right.date)
      || String(left.start ?? '').localeCompare(String(right.start ?? ''))
      || left.id.localeCompare(right.id));
  const unscheduled = group.items.filter(item => item.date === null || item.date === undefined);
  const byDate = new Map();
  for (const item of scheduled) {
    const bucket = byDate.get(item.date) ?? [];
    bucket.push(item);
    byDate.set(item.date, bucket);
  }
  const heading = group.project === null
    ? null
    : create('div', { style: MAIN_STYLE },
      create('h3', { style: { ...SECTION_STYLE, fontSize: '14px' } }, group.project.title),
      create('span', { style: BADGE_STYLE }, t(projectKindKey(group.project.kind))),
      create('span', { style: { fontSize: '12px', opacity: 0.7 } }, t('plan.projects.counts', {
        count: group.items.length,
        minutes: minutesOf(group.items),
      })));
  return create('section', {
    key: group.project?.id ?? 'ungrouped',
    'data-testid': group.project === null ? 'plan-tasks-ungrouped' : `plan-project-tasks-${group.project.id}`,
    style: { display: 'flex', flexDirection: 'column', gap: '8px' },
  },
  heading,
  [...byDate.entries()].map(([date, dayItems]) => create('section', { key: date, 'data-testid': `plan-day-${date}`, style: DAY_STYLE,
    onDragOver: event => event.preventDefault(),
    onDrop: event => {
      event.preventDefault();
      try {
        const block = JSON.parse(event.dataTransfer.getData('application/study-block'));
        derived.onMoveBlock?.(block, date);
      } catch { /* A drop that carries no block is ignored. */ }
    } },
  create('div', { style: DAY_HEADER_STYLE },
    create('strong', null, date),
    create('span', { style: { fontSize: '12px', opacity: 0.7 } }, t('plan.tasks.minutes', { count: minutesOf(dayItems) }))),
  create('ul', { style: LIST_STYLE }, dayItems.map(item => renderItem(create, t, derived, item, options))))),
  unscheduled.length === 0 ? null : create('section', { key: 'unscheduled', 'data-testid': 'plan-unscheduled', style: DAY_STYLE },
    create('div', { style: DAY_HEADER_STYLE },
      create('strong', null, t('plan.tasks.unscheduled')),
      create('span', { style: { fontSize: '12px', opacity: 0.7 } }, t('plan.tasks.minutes', { count: minutesOf(unscheduled) }))),
    create('p', { style: NOTE_STYLE }, t('plan.tasks.unscheduledHint')),
    create('ul', { style: LIST_STYLE }, unscheduled.map(item => renderItem(create, t, derived, item, options)))));
}

/** Render one plan item with its citation, metadata and progress state. */
function renderItem(create, t, derived, item, options) {
  const progress = derived.progressByItem.get(item.id) ?? item.progress ?? null;
  const status = progress?.status ?? 'unrecorded';
  const statusKey = PROGRESS_KEYS[status] ?? PROGRESS_KEYS.unrecorded;
  const source = materialSourceOf(item, derived.materialsById);
  const dependencyTitles = (Array.isArray(item.dependencies) ? item.dependencies : [])
    .map(id => derived.titlesById.get(id) ?? id);
  const sourceLabel = sourceLabelOf(t, source);
  return create('li', { key: item.blockId ?? item.id, 'data-testid': `plan-item-${item.id}`, style: ROW_STYLE,
    draggable:!options.draft && Boolean(item.blockId ?? item.blockIds?.[0]),
    onDragStart:event=>event.dataTransfer.setData('application/study-block',JSON.stringify({id:item.blockId??item.blockIds?.[0],start:item.start,end:item.end})) },
    options.draft ? null : create('div',{style:TOOLBAR_STYLE}, ['done','partial','not_started','cancelled'].map(status=>create('button',{
      type:'button',key:status,style:BUTTON_STYLE,disabled:derived.busy===true,'data-testid':`plan-progress-${item.id}-${status}`,onClick:()=>derived.onProgress?.(item,status)},t(status==='not_started'?'daily.notStarted':`daily.${status}`)))),
    create('div', { style: { flex: '1 1 340px' } },
      create('div', { style: MAIN_STYLE },
        create('strong', null, item.title),
        options.draft === true ? create('span', { style: PENDING_STYLE }, t('plan.draft.badge')) : null,
        item.date === null ? create('span', { 'data-testid': `plan-item-unscheduled-${item.id}`, style: PENDING_STYLE }, t('plan.tasks.unscheduled')) : null,
        item.flexible === false ? create('span', { style: BADGE_STYLE }, t('plan.tasks.fixed')) : null,
        create('span', { 'data-testid': `plan-item-progress-${item.id}`, style: BADGE_STYLE }, t(statusKey)),
        progress?.recorded === true && progress?.confirmed === false
          ? create('span', { style: PENDING_STYLE }, t('plan.progress.pending'))
          : null),
      create('div', { style: META_STYLE },
        item.date === null || item.date === undefined
          ? null
          : create('span', { 'data-testid': `plan-item-date-${item.id}` }, t('plan.tasks.date', { date: item.date })),
        create('span', { 'data-testid': `plan-item-time-${item.id}` }, item.start !== null && item.start !== undefined && item.end !== null && item.end !== undefined
          ? t('plan.tasks.time', { start: item.start, end: item.end })
          : t('plan.tasks.noTime')),
        create('span', null, t('plan.tasks.minutes', { count: item.estimateMinutes })),
        item.subject === null || item.subject === undefined ? null : create('span', null, t('plan.tasks.subject', { subject: item.subject })),
        item.source === null || item.source === undefined ? null : create('span', null, t('plan.tasks.source', { source: t(`plan.tasks.source.${item.source}`) })),
        dependencyTitles.length === 0 ? null : create('span', null, t('plan.tasks.dependencies', { titles: joinParts(dependencyTitles) }))),
      item.completion === null || item.completion === undefined ? null : create('p', { style: { ...NOTE_STYLE, margin: '3px 0 0' } }, t('plan.tasks.completion', { text: item.completion })),
      item.note === null || item.note === undefined ? null : create('p', { style: { ...NOTE_STYLE, margin: '3px 0 0' } }, t('plan.tasks.note', { note: item.note })),
      source.present
        ? create('details', { 'data-testid': `plan-item-source-${item.id}`, style: SOURCE_STYLE },
          create('summary', null, t('plan.source.summary', { label: sourceLabel })),
          renderSource(create, t, source))
        : create('p', { 'data-testid': `plan-item-source-none-${item.id}`, style: SOURCE_STYLE }, t('plan.source.none'))));
}

/** Render the opened material citation. */
function renderSource(create, t, source) {
  const lines = [];
  if (source.material !== null) {
    lines.push(create('p', { key: 'material', style: { margin: 0 } }, t('plan.source.book', { title: source.material.title })));
    lines.push(create('p', { key: 'meta', style: { margin: 0 } }, t('plan.source.materialMeta', {
      kind: source.material.kind,
      edition: source.material.edition ?? '—',
      subject: source.material.subject ?? '—',
    })));
    if (source.material.source?.ref) {
      lines.push(create('p', { key: 'ref', style: { margin: 0 } }, t('plan.source.ref', {
        ref: source.material.source.ref,
        kind: source.material.source.kind,
      })));
    }
    if (Array.isArray(source.material.missing) && source.material.missing.length > 0) {
      lines.push(create('p', { key: 'material-missing', style: { margin: 0 } }, t('plan.source.unverified', {
        fields: joinParts(source.material.missing.map(field => MATERIAL_MISSING_KEYS[field] === undefined ? field : t(MATERIAL_MISSING_KEYS[field]))),
      })));
    }
  } else if (source.missingMaterial) {
    lines.push(create('p', { key: 'missing-material', style: { margin: 0 } }, t('plan.source.missingMaterial', { id: source.materialId })));
  }
  const locator = joinParts([
    source.chapter,
    source.page === null ? null : t('plan.source.page', { page: source.page }),
    source.exercise === null ? null : t('plan.source.exercise', { exercise: source.exercise }),
  ]);
  if (locator !== '') {
    lines.push(create('p', { key: 'locator', style: { margin: 0 } }, t('plan.source.locator', { locator })));
  }
  if (source.unverified.length > 0) {
    lines.push(create('p', { 'data-testid': 'plan-source-unverified', key: 'unverified', style: { margin: 0 } }, t('plan.source.unverified', {
      fields: joinParts(source.unverified.map(field => SOURCE_FIELD_KEYS[field] === undefined ? field : t(SOURCE_FIELD_KEYS[field]))),
    })));
  }
  return create('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, lines);
}

/** One-line label for the citation summary. */
function sourceLabelOf(t, source) {
  if (source.material !== null) {
    const parts = [t('plan.source.book', { title: source.material.title })];
    if (source.chapter) parts.push(source.chapter);
    if (source.page !== null) parts.push(t('plan.source.page', { page: source.page }));
    if (source.exercise !== null) parts.push(t('plan.source.exercise', { exercise: source.exercise }));
    if (source.page === null) parts.push(t('plan.source.pageUnknown'));
    return joinParts(parts);
  }
  const locator = joinParts([
    source.chapter,
    source.page === null ? null : t('plan.source.page', { page: source.page }),
    source.exercise === null ? null : t('plan.source.exercise', { exercise: source.exercise }),
  ]);
  if (locator !== '') return locator;
  return t('plan.source.none');
}

/** Render every revision with its summary; the newest difference can expand. */
function renderRevisions(create, t, derived) {
  const revisions = derived.revisions ?? [];
  return create('div', { 'data-testid': 'plan-revisions', style: CARD_STYLE },
    create('h2', { style: SECTION_STYLE }, t('plan.revisions.title')),
    revisions.length === 0
      ? create('p', { 'data-testid': 'plan-revisions-empty', style: NOTE_STYLE }, t('plan.revisions.empty'))
      : create('div', null,
        create('p', { style: NOTE_STYLE }, t('plan.revisions.lastNote')),
        create('ul', { 'data-testid': 'plan-revision-list', style: LIST_STYLE }, revisions.map(revision => renderRevision(create, t, revision)))));
}

/** Render one revision row. */
function renderRevision(create, t, revision) {
  const meta = [];
  if (revision.reason) meta.push(t('plan.revisions.reason', { reason: revision.reason }));
  if (revision.appliedAt) meta.push(t('plan.revisions.time', { at: formatTime(revision.appliedAt) }));
  if (revision.undoneBy !== null && revision.undoneBy !== undefined) {
    meta.push(t('plan.revisions.undoneBy', { number: revision.undoneBy }));
  }
  return create('li', { key: revision.id ?? `revision-${revision.number}`, 'data-testid': `plan-revision-${revision.number}`, style: ROW_STYLE },
    create('div', { style: MAIN_STYLE },
      create('strong', null, t('plan.revisions.item', { number: revision.number })),
      create('span', { style: BADGE_STYLE }, t(ACTION_KEYS[revision.action] ?? revision.action)),
      create('span', { style: BADGE_STYLE }, t(REVISION_STATUS_KEYS[revision.status] ?? revision.status))),
    meta.length === 0 ? null : create('p', { style: NOTE_STYLE }, joinParts(meta)),
    create('details', { 'data-testid': `plan-revision-diff-${revision.number}`, style: DETAIL_STYLE },
      create('summary', null, t('plan.revisions.diff', { summary: summarizeDiff(t, revision.diff) })),
      renderDiffDetails(create, t, revision.diff)));
}

/** Render the added, removed and changed lists of one diff. */
function renderDiffDetails(create, t, diff) {
  if (diff === null || diff === undefined) return null;
  const added = Array.isArray(diff.added) ? diff.added : [];
  const removed = Array.isArray(diff.removed) ? diff.removed : [];
  const changed = Array.isArray(diff.changed) ? diff.changed : [];
  const titleOf = entry => entry.title ?? entry.id;
  const changedText = entry => `${titleOf(entry)} (${joinParts((entry.fields ?? []).map(field => t(`plan.diff.field.${field}`)))})`;
  const groups = [
    added.length === 0 ? null : create('p', { key: 'added', style: { margin: 0 } }, `${t('plan.diff.added')}: ${joinParts(added.map(titleOf))}`),
    removed.length === 0 ? null : create('p', { key: 'removed', style: { margin: 0 } }, `${t('plan.diff.removed')}: ${joinParts(removed.map(titleOf))}`),
    changed.length === 0 ? null : create('p', { key: 'changed', style: { margin: 0 } }, `${t('plan.diff.changed')}: ${joinParts(changed.map(changedText))}`),
  ].filter(Boolean);
  if (groups.length === 0) return create('p', { style: { margin: 0 } }, t('plan.diff.noChanges'));
  return create('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, groups);
}

/** Ask before a destructive action; tests and embedded views may not have `confirm`. */
function confirmAction(message) {
  const confirm = globalThis.confirm;
  return typeof confirm === 'function' ? confirm(message) !== false : true;
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
