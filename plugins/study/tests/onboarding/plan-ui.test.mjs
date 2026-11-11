/**
 * Plan page: definition, every rendered state, the draft/formal difference,
 * trial risks, missing information, clickable material sources and undo
 * payload. Views are rendered through the pure `PlanView` with no browser.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../client/support/react-stub.mjs';
import {
  CAPACITY, DRAFT_DATA, GOAL, GOAL_PARTIAL, ITEM, MATERIAL, PLAN_DATA, PROJECT,
  byTestId, draftView, loadDictionary, planGet, revisionView, text, translatorFor,
} from './helpers.mjs';

installReactStub();

const planModule = await import('../../client/pages/plan.js');
const {
  PlanView, diffPlanDocuments, materialSourceOf, missingPlanInfo, summarizeDiff, undoPayload,
} = planModule;
const page = planModule.default;
const dictionary = await loadDictionary();

const create = (type, props, ...children) => ({ type, props: props ?? {}, children });
const zh = translatorFor(dictionary, 'zh');
const en = translatorFor(dictionary, 'en');

/** Base ready page state. */
function readyView(overrides = {}) {
  return {
    phase: 'ready',
    value: planGet(),
    materials: [MATERIAL],
    goal: GOAL,
    progressItems: [],
    warnings: [],
    revision: 1,
    error: null,
    notice: null,
    busy: false,
    ...overrides,
  };
}

/** The callbacks the view receives; click handlers are optional per test. */
function viewProps(t, view, extra = {}) {
  return {
    create,
    t,
    view,
    workspaceItems: [],
    onRetry: () => {},
    onRefresh: () => {},
    onUndo: () => {},
    ...extra,
  };
}

/** Render and fail on an unresolved dictionary key. */
function render(t, view, extra = {}) {
  const tree = PlanView(viewProps(t, view, extra));
  const rendered = text(tree);
  assert.doesNotMatch(rendered, /plan\.[a-z]/, `未解析的文案键：${rendered}`);
  assert.doesNotMatch(rendered, /onboarding\.[a-z]/, `未解析的文案键：${rendered}`);
  return { tree, rendered };
}

describe('plan page definition', () => {
  it('satisfies the { key, order, label, Page } contract', () => {
    assert.equal(page.key, 'plan');
    assert.equal(page.order, 16);
    assert.equal(page.label, 'plan.panel');
    assert.equal(typeof page.Page, 'function');
    assert.ok(dictionary.zh[page.label]);
    assert.ok(dictionary.en[page.label]);
  });

  it('renders the loading state before the first read resolves', () => {
    const tree = page.Page({ t: zh, call: () => new Promise(() => {}) });
    assert.match(text(tree), /正在读取计划/);
    assert.ok(byTestId(tree, 'study-loading'));
  });

  it('renders a read failure with retry', () => {
    const { tree } = render(zh, { phase: 'error', message: 'boom' });
    assert.ok(byTestId(tree, 'study-error'));
    assert.ok(byTestId(tree, 'plan-retry'));
  });
});

describe('empty plan', () => {
  it('points at the onboarding flow and offers no undo', () => {
    const { tree, rendered } = render(zh, readyView({
      value: { plan: null, applied: null, draft: null, capacity: null, progress: null, revisions: [], notice: null },
      materials: [],
      goal: null,
    }));
    assert.ok(byTestId(tree, 'plan-empty'));
    assert.match(rendered, /还没有学习计划/);
    assert.match(rendered, /草案确认前不会改变正式安排/);
    assert.equal(byTestId(tree, 'plan-undo').props.disabled, true);
  });
});

describe('formal plan', () => {
  it('renders stage and week goals, tasks, progress and the formal revision', () => {
    const progressItems = [{
      ...ITEM,
      progress: {
        status: 'partial',
        recorded: true,
        confirmed: false,
        quantityDone: 2,
        quantityTotal: 5,
        note: 'two done',
        date: '2026-11-11',
        at: '2026-11-11T12:00:00.000Z',
        actor: 'student',
      },
    }];
    const { tree, rendered } = render(zh, readyView({ progressItems }));
    assert.match(rendered, /Mathematics study plan/);
    assert.match(rendered, /正式修订 1/);
    assert.match(rendered, /Finish calculus/);
    assert.match(rendered, /Chapter 2/);
    assert.match(rendered, /Chapter 2 exercises 1-10/);
    assert.match(rendered, /19:00–20:00/);
    assert.match(rendered, /部分完成/);
    assert.match(rendered, /待确认/);
    assert.equal(byTestId(tree, 'plan-progress-counts').children[0].includes('未记录 1'), true);
    assert.equal(byTestId(tree, 'plan-undo').props.disabled, false);
  });

  it('groups tasks under their projects and keeps dates separate from clock times', () => {
    const { tree, rendered } = render(zh, readyView());
    assert.ok(byTestId(tree, 'plan-projects'));
    assert.match(text(byTestId(tree, 'plan-project-proj_1')), /Calculus workbook/);
    assert.match(text(byTestId(tree, 'plan-project-proj_1')), /Finish chapters 1-4/);
    assert.equal(text(byTestId(tree, 'plan-counts-projects')), '2 个项目');
    assert.ok(byTestId(tree, 'plan-project-tasks-proj_1'));
    assert.match(text(byTestId(tree, 'plan-project-tasks-proj_1')), /Chapter 2 exercises 1-10/);
    assert.match(text(byTestId(tree, 'plan-item-date-item_1')), /2026-11-11/);
    assert.ok(byTestId(tree, 'plan-tasks-time-note'));
    assert.match(text(byTestId(tree, 'plan-tasks-time-note')), /工作台/);
    assert.doesNotMatch(rendered, /plan\.(projects|tasks|missing)\.[a-z]/);
  });

  it('names a plan without projects and tasks that belong to none', () => {
    const legacy = { ...PLAN_DATA, projects: [], items: [{ ...ITEM, projectId: null }] };
    const first = render(zh, readyView({ value: planGet({ applied: revisionView({ data: legacy }) }) }));
    assert.ok(byTestId(first.tree, 'plan-projects-empty'));
    assert.ok(byTestId(first.tree, 'plan-missing-noProjects'));

    const mixed = { ...PLAN_DATA, items: [{ ...ITEM, projectId: null }] };
    const second = render(zh, readyView({ value: planGet({ applied: revisionView({ data: mixed }) }) }));
    assert.ok(byTestId(second.tree, 'plan-projects-ungrouped'));
    assert.ok(byTestId(second.tree, 'plan-missing-ungrouped'));
  });

  it('keeps "unrecorded" distinct from "pending confirmation"', () => {
    const progressItems = [{
      ...ITEM,
      progress: {
        status: 'unrecorded',
        recorded: false,
        confirmed: false,
        quantityDone: null,
        quantityTotal: null,
        note: null,
        date: null,
        at: null,
        actor: null,
      },
    }];
    const { tree, rendered } = render(zh, readyView({ progressItems }));
    assert.match(rendered, /未记录/);
    const itemText = text(byTestId(tree, 'plan-item-item_1'));
    assert.doesNotMatch(itemText, /待确认/, '未记录不是待确认');
    assert.equal(text(byTestId(tree, 'plan-item-progress-item_1')), '未记录');
  });

  it('shows the goal’s linked DSH workspaces and a deleted link honestly', () => {
    const goal = { ...GOAL, workspaceIds: ['ws_a', 'ws_gone'] };
    const { tree, rendered } = render(zh, readyView({ goal }), {
      workspaceItems: [{ workspaceId: 'ws_a', title: '数学工作区', path: 'D:/study/math' }],
    });
    assert.match(rendered, /关联工作区/);
    const line = byTestId(tree, 'plan-workspaces');
    assert.match(text(line), /数学工作区/);
    assert.match(text(line), /工作区已不可用/);
  });

  it('shows the latest revision difference and keeps older ones readable', () => {
    const { tree, rendered } = render(zh, readyView());
    assert.match(rendered, /修订记录/);
    assert.match(rendered, /新增 1 项/);
    assert.ok(byTestId(tree, 'plan-revision-1'));
    assert.ok(byTestId(tree, 'plan-revision-diff-1'));
    assert.match(text(byTestId(tree, 'plan-revision-diff-1')), /Chapter 2 exercises 1-10/);
  });

  it('opens a material source with its metadata, locator and unverified fields', () => {
    const { tree } = render(zh, readyView());
    const source = byTestId(tree, 'plan-item-source-item_1');
    assert.ok(source, '材料来源必须是可点开的 details');
    assert.equal(source.type, 'details');
    const summary = source.children[0];
    assert.equal(summary.type, 'summary');
    assert.match(text(summary), /Calculus workbook/);
    assert.match(text(summary), /chapter 2/);
    assert.match(text(summary), /页码未核实/);
    const body = text(source);
    assert.match(body, /calculus\.txt/, '资料导入来源应可见');
    assert.match(body, /未核实：页码/);
  });

  it('marks an item without a material and a missing material honestly', () => {
    const withoutMaterial = { ...PLAN_DATA, items: [{ ...ITEM, materialId: null, locator: { chapter: 'chapter 4', page: 12, exercise: null, unverified: [] } }] };
    const first = render(zh, readyView({
      value: planGet({ applied: revisionView({ data: withoutMaterial }) }),
    }));
    assert.ok(byTestId(first.tree, 'plan-item-source-item_1'));
    assert.match(text(byTestId(first.tree, 'plan-item-source-item_1')), /chapter 4/);

    const missing = render(zh, readyView({
      value: planGet({ applied: revisionView({ data: { ...PLAN_DATA, items: [{ ...ITEM, materialId: 'gone' }] } }) }),
    }));
    assert.match(text(byTestId(missing.tree, 'plan-item-source-item_1')), /找不到资料 gone/);
  });

  it('annotates missing goal fields, unscheduled work and unverified sources', () => {
    const value = planGet({
      applied: revisionView({ data: { ...PLAN_DATA, items: [{ ...ITEM, date: null, start: null, end: null }] } }),
      capacity: CAPACITY,
    });
    const { tree } = render(zh, readyView({ value, goal: GOAL_PARTIAL }));
    assert.ok(byTestId(tree, 'plan-missing-examYear'));
    assert.ok(byTestId(tree, 'plan-missing-deadline'));
    assert.ok(byTestId(tree, 'plan-missing-unscheduled'));
    assert.ok(byTestId(tree, 'plan-missing-unverifiedLocator'));
    assert.ok(byTestId(tree, 'plan-missing-unknownAvailability'));
    assert.match(text(byTestId(tree, 'plan-missing-unscheduled')), /1 项没有安排日期/);
  });

  it('renders a trial plan with its review date and risks', () => {
    const base = planGet();
    const trialData = { ...PLAN_DATA, trial: true, reviewAt: '2027-01-10' };
    const value = {
      ...base,
      plan: { ...base.plan, status: 'trial', trial: true, reviewAt: '2027-01-10' },
      applied: { ...base.applied, trial: true, reviewAt: '2027-01-10', data: trialData },
      capacity: { ...base.capacity, risks: ['Over capacity by 30 minutes'] },
    };
    const { tree, rendered } = render(zh, readyView({ value }));
    assert.ok(byTestId(tree, 'plan-trial'));
    assert.match(rendered, /复查日期：2027-01-10/);
    assert.match(rendered, /Over capacity by 30 minutes/);
    assert.ok(byTestId(tree, 'plan-capacity-risks'));
  });
});

describe('draft', () => {
  it('shows the unconfirmed draft, its difference and its tasks', () => {
    const base = planGet();
    const value = {
      ...base,
      plan: { ...base.plan, hasDraft: true },
      draft: draftView(),
      capacity: CAPACITY,
    };
    const { tree, rendered } = render(zh, readyView({ value }));
    assert.ok(byTestId(tree, 'plan-draft'));
    assert.match(rendered, /未确认草案/);
    assert.match(rendered, /确认前不会改变正式安排/);
    assert.match(rendered, /新增 1 项、调整 0 项、移除 1 项/);
    assert.match(rendered, /计划标题有变化/);
    assert.ok(byTestId(tree, 'plan-draft-items'));
    assert.match(text(byTestId(tree, 'plan-draft-items')), /Chapter 3 preview/);
    assert.ok(byTestId(tree, 'plan-draft-pending-note'));
    assert.ok(byTestId(tree, 'plan-draft-confirm-hint'));
  });

  it('keeps the undo payload explicit about a pending draft', () => {
    const base = planGet();
    const value = { ...base, draft: draftView() };
    assert.deepEqual(undoPayload(value), { planId: 'plan_1', baseRevision: 1, draftId: 'draft_1', expectedDraftRevision: 1 });
    assert.deepEqual(undoPayload(base), { planId: 'plan_1', baseRevision: 1 });
    assert.equal(undoPayload({ ...base, plan: { ...base.plan, revision: 0 } }), null);
    assert.equal(undoPayload(null), null);
  });
});

describe('pure plan helpers', () => {
  it('diffs added, removed and changed items plus document-level changes', () => {
    const changed = { ...DRAFT_DATA, title: PLAN_DATA.title, items: [{ ...ITEM, estimateMinutes: 90 }] };
    const diff = diffPlanDocuments(PLAN_DATA, changed);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.changed.length, 1);
    assert.deepEqual(diff.changed[0].fields, ['estimateMinutes']);
    assert.equal(diff.titleChanged, false);
    assert.equal(diff.goalsChanged, false);
    assert.equal(diff.availabilityChanged, false);
    assert.equal(diff.totals.beforeMinutes, 60);
    assert.equal(diff.totals.afterMinutes, 90);
    assert.match(summarizeDiff(zh, diff), /调整 1 项/);
  });

  it('reports a changed project list in the page diff', () => {
    const diff = diffPlanDocuments(PLAN_DATA, { ...PLAN_DATA, projects: [PROJECT] });
    assert.equal(diff.projectsChanged, true);
    assert.equal(diffPlanDocuments(PLAN_DATA, PLAN_DATA).projectsChanged, false);
    assert.match(summarizeDiff(zh, diff), /项目划分有变化/);
  });

  it('reports every missing-information entry the page can name', () => {
    assert.deepEqual(missingPlanInfo({ plan: null }), [{ code: 'noPlan' }]);
    const entries = missingPlanInfo({
      plan: planGet().plan,
      applied: null,
      draft: draftView(),
      capacity: CAPACITY,
      goal: GOAL_PARTIAL,
      materials: [MATERIAL],
    });
    const codes = entries.map(entry => entry.code);
    assert.ok(codes.includes('goalField'));
    assert.ok(codes.includes('unscheduled'));
    assert.ok(codes.includes('unknownAvailability'));
    assert.ok(codes.includes('unverifiedLocator'));
    assert.ok(codes.includes('draftOnly'));
    assert.equal(codes.includes('noGoal'), false);
    const missingMaterial = missingPlanInfo({
      plan: planGet().plan,
      applied: revisionView({ data: { ...PLAN_DATA, items: [{ ...ITEM, materialId: 'gone' }] } }),
      draft: null,
      capacity: CAPACITY,
      goal: GOAL,
      materials: [MATERIAL],
    });
    assert.ok(missingMaterial.some(entry => entry.code === 'missingMaterial' && entry.count === 1));
  });

  it('resolves a material source without claiming an unverified locator', () => {
    const byId = new Map([[MATERIAL.id, MATERIAL]]);
    const source = materialSourceOf(ITEM, byId);
    assert.equal(source.present, true);
    assert.equal(source.material.title, 'Calculus workbook');
    assert.equal(source.chapter, 'chapter 2');
    assert.equal(source.page, null);
    assert.deepEqual(source.unverified, ['page']);
    assert.equal(source.missingMaterial, false);
    const missing = materialSourceOf({ ...ITEM, materialId: 'gone', locator: null }, byId);
    assert.equal(missing.missingMaterial, true);
    assert.deepEqual(materialSourceOf({ title: 'bare' }, byId), {
      present: false,
      materialId: null,
      material: null,
      chapter: null,
      page: null,
      exercise: null,
      unverified: [],
      missingMaterial: false,
    });
  });

  it('renders the same formal plan in English with no Chinese text', () => {
    const { rendered } = render(en, readyView());
    assert.doesNotMatch(rendered, /[\u3400-\u9fff]/);
    assert.match(rendered, /Study plan/);
    assert.match(rendered, /Material source/);
    assert.match(rendered, /Revision history/);
  });
});
