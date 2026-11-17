/**
 * Onboarding page: definition, every step's rendered state, the resumable
 * progress, the minimal-info parsers and the trial acknowledgement gate.
 * Views are rendered through the pure `OnboardingView`, so no browser, DOM or
 * real service is involved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../../../study-outcomes/tests/client/support/react-stub.mjs';
import {
  CAPACITY, GOAL, GOAL_PARTIAL, MATERIAL, byTestId, draftView, loadDictionary,
  memoryStorage, planGet, revisionView, text, translatorFor,
} from './helpers.mjs';

installReactStub();

const onboarding = await import('../../client/pages/onboarding.js');
const {
  OnboardingView, STORAGE_KEY, defaultBriefDraft, defaultPlanForm, emptyBriefDraft, emptyGoalDraft, emptyPlanForm,
  emptyOnboardingState, goalDraftFrom, goalMissingFields, mergeStoredGoalDraft, parseBrief, parseConfirm, parseGoalDraft,
  parsePlanForm, readOnboardingState, resolveStep, restartOnboarding, skipOnboarding,
  writeOnboardingState,
} = onboarding;
const page = onboarding.default;
const dictionary = await loadDictionary();

const create = (type, props, ...children) => ({ type, props: props ?? {}, children });

/** Base ready session state. */
function readyView(overrides = {}) {
  return {
    phase: 'ready',
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
    trialAcknowledged: false,
    reviewAt: '',
    notice: null,
    warnings: [],
    busy: false,
    confirmDiff: null,
    ...overrides,
  };
}

/** No-op callbacks plus optional recorders. */
function viewProps(t, view, extra = {}) {
  return {
    create,
    t,
    view,
    workspaceItems: [],
    onRetry: () => {},
    onReload: () => {},
    onGoalField: () => {},
    onGoalWorkspace: () => {},
    onGoalSave: () => {},
    onMaterialToggle: () => {},
    onMaterialsContinue: () => {},
    onBriefField: () => {},
    onBriefStart: () => {},
    onBriefManual: () => {},
    onDraftContinue: () => {},
    onPlanField: () => {},
    onDraftSave: () => {},
    onTrialAck: () => {},
    onReviewAt: () => {},
    onConfirm: () => {},
    onBack: () => {},
    onLater: () => {},
    onSkip: () => {},
    onRestart: () => {},
    ...extra,
  };
}

/** Render through the shared element factory and fail on an unresolved dictionary key. */
function render(t, view, extra = {}) {
  const tree = OnboardingView(viewProps(t, view, extra));
  const rendered = text(tree);
  assert.doesNotMatch(rendered, /onboarding\.[a-z]/, `未解析的文案键：${rendered}`);
  assert.doesNotMatch(rendered, /plan\.[a-z]/, `未解析的文案键：${rendered}`);
  return { tree, rendered };
}

const zh = translatorFor(dictionary, 'zh');
const en = translatorFor(dictionary, 'en');

it('offers a goal conversation resume without hiding the local form', () => {
  let resumed = false;
  const { tree } = render(zh, readyView({ planningSessionId: 'session-a' }), { onResume: () => { resumed = true; } });
  const button = byTestId(tree, 'onboarding-resume');
  assert.ok(button);
  button.props.onClick();
  assert.equal(resumed, true);
  assert.ok(byTestId(tree, 'onboarding-goal'));
});

describe('onboarding page definition', () => {
  it('satisfies the { key, order, label, Page } contract', () => {
    assert.equal(page.key, 'onboarding');
    assert.equal(page.order, 1);
    assert.equal(page.label, 'onboarding.panel');
    assert.equal(typeof page.Page, 'function');
    assert.ok(dictionary.zh[page.label]);
    assert.ok(dictionary.en[page.label]);
  });

  it('renders the loading state before the first read resolves', () => {
    const tree = page.Page({ t: zh, call: () => new Promise(() => {}) });
    assert.match(text(tree), /正在读取目标和计划/);
    assert.ok(byTestId(tree, 'study-loading'));
  });
});

describe('onboarding state helpers', () => {
  it('persists and restores the resumable step and form fields', () => {
    const storage = memoryStorage();
    const state = {
      ...emptyOnboardingState(),
      phase: 'brief',
      goalId: 'goal_1',
      selectedMaterialIds: ['material_1'],
      goalDraft: { ...emptyGoalDraft(), exam: 'Mathematics' },
      planForm: { ...emptyPlanForm(), planTitle: 'Plan v2', itemTitle: 'Exercises' },
      briefDraft: { ...emptyBriefDraft(), planTitle: 'Plan v3', stageGoal: 'Finish chapter four', dailyMinutes: '90' },
    };
    assert.equal(writeOnboardingState(storage, state), true);
    const restored = readOnboardingState(storage);
    assert.equal(restored.phase, 'brief');
    assert.equal(restored.goalId, 'goal_1');
    assert.deepEqual(restored.selectedMaterialIds, ['material_1']);
    assert.equal(restored.goalDraft.exam, 'Mathematics');
    assert.equal(restored.planForm.planTitle, 'Plan v2');
    assert.equal(restored.briefDraft.stageGoal, 'Finish chapter four');
    assert.equal(restored.briefDraft.dailyMinutes, '90');
    assert.equal(storage.dump()[STORAGE_KEY].includes('"phase":"brief"'), true);
  });

  it('resumes a legacy manual draft position instead of forgetting it', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ phase: 'draft' }) });
    assert.equal(readOnboardingState(storage).phase, 'draft');
  });

  it('falls back to an empty state for corrupt or unknown stored values', () => {
    assert.equal(readOnboardingState(memoryStorage({ [STORAGE_KEY]: '{oops' })).phase, 'goal');
    assert.equal(readOnboardingState(memoryStorage({ [STORAGE_KEY]: '[]' })).phase, 'goal');
    const unknown = readOnboardingState(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ phase: 'elsewhere' }) }));
    assert.equal(unknown.phase, 'goal');
  });

  it('reports a blocked storage area instead of throwing', () => {
    const blocked = { setItem() { throw new Error('quota'); }, getItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    assert.equal(writeOnboardingState(blocked, emptyOnboardingState()), false);
    assert.equal(readOnboardingState(blocked).phase, 'goal');
  });

  it('resolves the step from the server state before the stored step', () => {
    assert.equal(resolveStep({ storedPhase: 'materials', plan: null, draft: null }), 'materials');
    assert.equal(resolveStep({ storedPhase: 'brief', plan: null, draft: null }), 'brief');
    assert.equal(resolveStep({ storedPhase: 'goal', plan: { id: 'p', revision: 0 }, draft: { id: 'd' } }), 'confirm');
    assert.equal(resolveStep({ storedPhase: 'confirm', plan: { id: 'p', revision: 1 }, draft: null }), 'done');
    assert.equal(resolveStep({ storedPhase: 'done', plan: { id: 'p', revision: 1 }, draft: null }), 'done');
    assert.equal(resolveStep({ storedPhase: 'confirm', plan: null, draft: null }), 'draft');
    assert.equal(resolveStep({ storedPhase: 'skipped', plan: null, draft: null }), 'skipped');
  });

  it('skips and restarts purely locally', () => {
    const skipped = skipOnboarding(emptyOnboardingState());
    assert.equal(skipped.phase, 'skipped');
    assert.equal(restartOnboarding().phase, 'goal');
    assert.deepEqual(restartOnboarding().selectedMaterialIds, []);
  });
});

describe('goal step', () => {
  it('accepts only the exam name and reports the optional fields as missing', () => {
    const parsed = parseGoalDraft({ ...emptyGoalDraft(), exam: '  Postgraduate mathematics  ' });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.payload, {
      exam: 'Postgraduate mathematics',
      examYear: null,
      deadline: null,
      dailyMinutes: null,
      note: null,
      workspaceIds: [],
      active: true,
    });
    assert.equal(parseGoalDraft({ ...emptyGoalDraft(), exam: '   ' }).field, 'exam');
    assert.equal(parseGoalDraft({ ...emptyGoalDraft(), exam: 'x', examYear: '1800' }).field, 'examYear');
    assert.equal(parseGoalDraft({ ...emptyGoalDraft(), exam: 'x', dailyMinutes: 'abc' }).field, 'dailyMinutes');
  });

  it('turns a stored goal into the form and lists its missing fields', () => {
    assert.deepEqual(goalDraftFrom(GOAL_PARTIAL), {
      exam: GOAL_PARTIAL.exam,
      examYear: '',
      deadline: '',
      dailyMinutes: '',
      note: '',
      workspaceIds: [],
    });
    assert.deepEqual(goalMissingFields(GOAL_PARTIAL), ['examYear', 'deadline', 'dailyMinutes']);
    assert.deepEqual(goalMissingFields(GOAL), []);
  });

  it('restores stored workspace selections and fills legacy drafts from the goal', () => {
    const stored = readOnboardingState(memoryStorage({
      [STORAGE_KEY]: JSON.stringify({
        phase: 'goal',
        goalDraft: { ...emptyGoalDraft(), exam: 'Mathematics', workspaceIds: ['ws_a', 'ws_b'] },
      }),
    }));
    assert.deepEqual(stored.goalDraft.workspaceIds, ['ws_a', 'ws_b']);
    assert.equal(stored.workspaceSelectionStored, true);

    const legacy = readOnboardingState(memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ phase: 'goal', goalDraft: { exam: 'Mathematics' } }),
    }));
    assert.equal(legacy.workspaceSelectionStored, false);
    assert.deepEqual(mergeStoredGoalDraft(legacy, { ...GOAL, workspaceIds: ['ws_a'] }).workspaceIds, ['ws_a']);
    assert.deepEqual(mergeStoredGoalDraft(stored, { ...GOAL, workspaceIds: ['ws_z'] }).workspaceIds, ['ws_a', 'ws_b']);
  });

  it('selects several DSH workspaces and keeps a deleted link removable', () => {
    const changes = [];
    const view = readyView({
      goalDraft: { ...emptyGoalDraft(), exam: 'Mathematics', workspaceIds: ['ws_a', 'ws_gone'] },
    });
    const { tree, rendered } = render(zh, view, {
      workspaceItems: [
        { workspaceId: 'ws_a', title: '数学工作区', path: 'D:/study/math' },
        { workspaceId: 'ws_b', title: '英语工作区', path: 'D:/study/english' },
      ],
      onGoalWorkspace: (id, checked) => { changes.push([id, checked]); },
    });
    assert.match(rendered, /关联工作区/);
    assert.equal(byTestId(tree, 'onboarding-goal-workspace-ws_a').props.checked, true);
    assert.equal(byTestId(tree, 'onboarding-goal-workspace-ws_b').props.checked, false);
    const stale = byTestId(tree, 'onboarding-goal-workspace-ws_gone');
    assert.equal(stale.props.checked, true);
    assert.match(text(byTestId(tree, 'onboarding-goal-workspace-row-ws_gone')), /工作区已不可用/);
    byTestId(tree, 'onboarding-goal-workspace-ws_b').props.onChange({ target: { checked: true } });
    assert.deepEqual(changes, [['ws_b', true]]);
  });

  it('explains the empty workspace list without blocking the goal', () => {
    const { tree, rendered } = render(en, readyView({ goalDraft: { ...emptyGoalDraft(), exam: 'Mathematics' } }));
    assert.ok(byTestId(tree, 'onboarding-goal-workspaces-empty'));
    assert.match(rendered, /No DSH workspace yet/);
  });

  it('renders the minimal form and the missing information without blocking', () => {
    const { tree, rendered } = render(zh, readyView({ goalDraft: goalDraftFrom(GOAL_PARTIAL), goal: GOAL_PARTIAL }));
    assert.ok(byTestId(tree, 'onboarding-goal-form'));
    assert.ok(byTestId(tree, 'onboarding-refresh'));
    assert.equal(byTestId(tree, 'onboarding-goal-form').props.name, undefined);
    assert.ok(byTestId(tree, 'onboarding-missing-deadline'));
    assert.ok(byTestId(tree, 'onboarding-missing-dailyMinutes'));
    assert.match(rendered, /考试年份/);
    assert.match(rendered, /还缺这些信息/);
    assert.match(rendered, /保存目标并继续/);
    assert.match(rendered, /稍后继续/);
    assert.match(rendered, /先不创建/);
  });

  it('renders the same step in English with no Chinese text', () => {
    const { rendered } = render(en, readyView({ goalDraft: goalDraftFrom(GOAL_PARTIAL), goal: GOAL_PARTIAL }));
    assert.doesNotMatch(rendered, /[\u3400-\u9fff]/);
    assert.match(rendered, /Exam year/);
  });
});

describe('materials step', () => {
  it('continues with no material and names the conversational import path', () => {
    const { tree, rendered } = render(zh, readyView({ step: 'materials', goal: GOAL }));
    assert.ok(byTestId(tree, 'onboarding-materials-empty'));
    assert.match(rendered, /还没有导入材料/);
    assert.ok(byTestId(tree, 'onboarding-materials-continue'));
  });

  it('renders selectable materials and their provenance gaps', () => {
    const toggles = [];
    const { tree, rendered } = render(en, readyView({
      step: 'materials',
      goal: GOAL,
      materials: [MATERIAL],
      selectedMaterialIds: ['material_1'],
    }), { onMaterialToggle: id => toggles.push(id) });
    const toggle = byTestId(tree, 'onboarding-material-toggle-material_1');
    assert.ok(toggle);
    assert.equal(toggle.props.checked, true);
    toggle.props.onChange();
    assert.deepEqual(toggles, ['material_1']);
    assert.match(rendered, /Calculus workbook/);
    assert.match(rendered, /Missing: edition · contents/);
  });
});

describe('brief step', () => {
  it('normalizes only what the student wrote', () => {
    assert.deepEqual(parseBrief({ briefDraft: emptyBriefDraft(), goal: null, selectedMaterialIds: [] }), {
      ok: true,
      payload: { brief: { planTitle: null, stageGoal: null, constraints: null, notes: null, dailyMinutes: null, materialIds: [] } },
    });
    const parsed = parseBrief({
      briefDraft: { planTitle: '  数学冲刺  ', stageGoal: ' 过完前四章 ', dailyMinutes: '120', constraints: '', notes: '第一章已学' },
      goal: GOAL,
      selectedMaterialIds: ['material_1', '', 'material_2'],
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.payload.goalId, GOAL.id);
    assert.deepEqual(parsed.payload.brief, {
      planTitle: '数学冲刺',
      stageGoal: '过完前四章',
      constraints: null,
      notes: '第一章已学',
      dailyMinutes: 120,
      materialIds: ['material_1', 'material_2'],
    });
  });

  it('rejects an impossible daily budget', () => {
    assert.deepEqual(parseBrief({ briefDraft: { ...emptyBriefDraft(), dailyMinutes: '2000' }, goal: null, selectedMaterialIds: [] }), {
      ok: false,
      field: 'dailyMinutes',
    });
    assert.deepEqual(parseBrief({ briefDraft: { ...emptyBriefDraft(), dailyMinutes: '1.5' }, goal: null, selectedMaterialIds: [] }), {
      ok: false,
      field: 'dailyMinutes',
    });
  });

  it('prefills the title and daily minutes from the goal', () => {
    const brief = defaultBriefDraft(undefined, GOAL, zh);
    assert.equal(brief.planTitle, `${GOAL.exam} 学习计划`);
    assert.equal(brief.dailyMinutes, String(GOAL.dailyMinutes));
    const typed = defaultBriefDraft({ planTitle: '我的计划', dailyMinutes: '45' }, GOAL, zh);
    assert.equal(typed.planTitle, '我的计划');
    assert.equal(typed.dailyMinutes, '45');
  });

  it('renders the brief form and hands off to the assistant', () => {
    const calls = [];
    const view = readyView({
      step: 'brief',
      goal: GOAL,
      materials: [MATERIAL],
      selectedMaterialIds: ['material_1'],
      briefDraft: { ...emptyBriefDraft(), planTitle: '数学冲刺', dailyMinutes: '120' },
    });
    const { tree, rendered } = render(zh, view, {
      onBriefStart: () => calls.push('start'),
      onBriefManual: () => calls.push('manual'),
    });
    assert.ok(byTestId(tree, 'onboarding-brief-form'));
    assert.ok(byTestId(tree, 'onboarding-brief-summary-goal'));
    assert.ok(byTestId(tree, 'onboarding-brief-summary-materials'));
    assert.match(rendered, /让助手开始规划/);
    assert.match(rendered, /不用助手，自己写草案/);
    assert.match(rendered, /已选材料：1 份/);
    assert.match(rendered, /确认之前不会改变正式安排/);
    byTestId(tree, 'onboarding-brief-form').props.onSubmit({ preventDefault() {} });
    byTestId(tree, 'onboarding-brief-manual').props.onClick();
    assert.deepEqual(calls, ['start', 'manual']);
  });

  it('asks for the exam when no goal exists yet', () => {
    const { rendered } = render(en, readyView({ step: 'brief', goal: null }));
    assert.match(rendered, /No goal yet/);
    assert.doesNotMatch(rendered, /[\u3400-\u9fff]/);
  });
});

describe('draft step', () => {
  it('shows an existing draft and routes to confirmation instead of overwriting it', () => {
    const calls = [];
    const plan = {
      ...planGet().plan,
      status: 'draft',
      revision: 0,
      hasDraft: true,
      appliedRevision: null,
    };
    const { tree, rendered } = render(zh, readyView({
      step: 'draft',
      goal: GOAL_PARTIAL,
      plan,
      draft: draftView(),
      applied: null,
      capacity: CAPACITY,
      materials: [MATERIAL],
    }), { onDraftContinue: () => calls.push('continue') });
    assert.ok(byTestId(tree, 'onboarding-draft-existing'));
    assert.equal(byTestId(tree, 'onboarding-draft-form'), undefined);
    assert.match(rendered, /已经有一份未确认草案/);
    assert.match(rendered, /1 项、约 30 分钟/);
    byTestId(tree, 'onboarding-draft-continue').props.onClick();
    assert.deepEqual(calls, ['continue']);
  });

  it('prefills the plan title from the goal without hardcoding a noun', () => {
    const form = defaultPlanForm(emptyPlanForm(), GOAL, zh);
    assert.equal(form.planTitle, 'Postgraduate mathematics 学习计划');
    assert.equal(defaultPlanForm(emptyPlanForm(), null, zh).planTitle, '');
  });

  it('accepts a title-only draft and never invents a date or a slot', () => {
    const parsed = parsePlanForm({
      form: { ...emptyPlanForm(), planTitle: 'My plan', itemTitle: '', estimateMinutes: '' },
      goal: GOAL,
      plan: null,
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.payload.title, 'My plan');
    assert.equal(parsed.payload.baseRevision, 0);
    assert.deepEqual(parsed.payload.items, []);
    assert.equal(parsed.payload.availability, undefined);
    assert.equal(parsed.payload.planId, undefined);
    assert.equal(parsed.payload.goalId, 'goal_1');
  });

  it('forwards one declared task without scheduling it', () => {
    const parsed = parsePlanForm({
      form: {
        ...emptyPlanForm(),
        planTitle: 'My plan',
        itemTitle: 'Chapter 2 exercises',
        estimateMinutes: '45',
        materialId: 'material_1',
      },
      goal: GOAL,
      plan: null,
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.payload.items.length, 1);
    const item = parsed.payload.items[0];
    assert.equal(item.title, 'Chapter 2 exercises');
    assert.equal(item.estimateMinutes, 45);
    assert.equal(item.date, null);
    assert.equal(item.start, null);
    assert.equal(item.end, null);
    assert.equal(item.materialId, 'material_1');
    assert.equal(parsed.payload.availability, undefined);
  });

  it('adds availability only when both a date and minutes are declared', () => {
    const withDate = parsePlanForm({
      form: { ...emptyPlanForm(), planTitle: 'My plan', date: '2026-11-11', availabilityMinutes: '90' },
      goal: GOAL,
      plan: { id: 'plan_1', revision: 2, goalId: 'goal_1' },
    });
    assert.equal(withDate.ok, true);
    assert.deepEqual(withDate.payload.availability, [{ date: '2026-11-11', minutes: 90 }]);
    assert.equal(withDate.payload.planId, 'plan_1');
    assert.equal(withDate.payload.baseRevision, 2);

    const noDate = parsePlanForm({
      form: { ...emptyPlanForm(), planTitle: 'My plan', availabilityMinutes: '90' },
      goal: GOAL,
      plan: null,
    });
    assert.equal(noDate.ok, false);
    assert.equal(noDate.field, 'availabilityDate');
    assert.equal(parsePlanForm({ form: { ...emptyPlanForm() }, goal: GOAL, plan: null }).field, 'title');
  });
});

describe('confirmation and trial gate', () => {
  it('builds a plain confirmation when the draft fits', () => {
    const plan = { ...planGet().plan, revision: 0 };
    const parsed = parseConfirm({
      plan,
      draft: draftView(),
      capacity: CAPACITY,
      trialAcknowledged: false,
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.payload, { planId: 'plan_1', baseRevision: 0, expectedDraftRevision: 1 });
    assert.equal(parsed.trial, false);
  });

  it('blocks a risky confirmation until the trial acknowledgement', () => {
    const plan = { ...planGet().plan, revision: 0 };
    const risky = { ...CAPACITY, verdict: 'over_capacity', requiresTrial: true, risks: ['Over capacity by 30 minutes'] };
    assert.equal(parseConfirm({ plan, draft: draftView(), capacity: risky, trialAcknowledged: false }).field, 'trial');
    const parsed = parseConfirm({
      plan,
      draft: draftView(),
      capacity: risky,
      trialAcknowledged: true,
      reviewAt: '2027-01-10',
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.payload, { planId: 'plan_1', baseRevision: 0, expectedDraftRevision: 1, trial: true, reviewAt: '2027-01-10' });
  });

  it('renders the risk, the ack, the review date and the missing information', () => {
    const plan = { ...planGet().plan, status: 'draft', revision: 0, hasDraft: true };
    const risky = {
      ...CAPACITY,
      verdict: 'over_capacity',
      requiresTrial: true,
      risks: ['Over capacity by 30 minutes'],
    };
    const { tree, rendered } = render(zh, readyView({
      step: 'confirm',
      goal: GOAL,
      plan,
      draft: draftView(),
      applied: null,
      capacity: risky,
      materials: [MATERIAL],
    }));
    assert.ok(byTestId(tree, 'onboarding-trial-gate'));
    assert.ok(byTestId(tree, 'onboarding-trial-ack'));
    assert.ok(byTestId(tree, 'onboarding-trial-risks'));
    assert.match(rendered, /需要试行确认/);
    assert.match(rendered, /超出可用时间/);
    assert.match(rendered, /1 项没有安排日期/);
    assert.match(rendered, /1 项的材料定位未核实/);
    assert.ok(byTestId(tree, 'onboarding-confirm-submit'));
  });

  it('renders a fitting confirmation without the trial gate', () => {
    const plan = { ...planGet().plan, status: 'draft', revision: 0, hasDraft: true };
    const { tree, rendered } = render(zh, readyView({
      step: 'confirm',
      goal: GOAL,
      plan,
      draft: draftView(),
      applied: null,
      capacity: { ...CAPACITY, requiresTrial: false, verdict: 'fits' },
      materials: [MATERIAL],
    }));
    assert.equal(byTestId(tree, 'onboarding-trial-gate'), undefined);
    assert.match(rendered, /容量检查：排得下/);
    assert.match(rendered, /草案不会改变正式安排/);
  });
});

describe('done and skipped states', () => {
  it('shows the confirmed revision and the change summary', () => {
    const data = planGet();
    const { tree } = render(zh, readyView({
      step: 'done',
      goal: GOAL,
      plan: { ...data.plan, revision: 2 },
      applied: data.applied,
      capacity: data.capacity,
      revisions: [revisionView({ number: 2, action: 'undo', diff: data.revisions[0].diff })],
      confirmDiff: data.revisions[0].diff,
    }));
    assert.ok(byTestId(tree, 'onboarding-done-status'));
    assert.match(text(tree), /正式修订 2/);
    assert.match(text(tree), /本次变更：新增 1 项/);
  });

  it('renders the skipped state with the local-operation promise and no writes', () => {
    const { tree, rendered } = render(zh, readyView({ step: 'skipped', goal: GOAL }));
    assert.ok(byTestId(tree, 'onboarding-skip-nowrite'));
    assert.match(rendered, /工作台、番茄钟和计划页都能继续用/);
    assert.match(rendered, /不会创建目标、草案或正式计划/);
    assert.ok(byTestId(tree, 'onboarding-restart'));
  });

  it('renders the server error with a retry action', () => {
    const { tree } = render(zh, { phase: 'error', message: 'boom' });
    assert.ok(byTestId(tree, 'study-error'));
    assert.ok(byTestId(tree, 'onboarding-retry'));
  });
});
