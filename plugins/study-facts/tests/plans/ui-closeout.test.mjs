import test from 'node:test';
import assert from 'node:assert/strict';
import { installReactStub } from '../../../study-outcomes/tests/client/support/react-stub.mjs';
import { loadDictionary, translatorFor, planGet, text, byTestId } from '../onboarding/helpers.mjs';
installReactStub();
const { PlanView } = await import('../../client/pages/plan.js');
const t = translatorFor(await loadDictionary(), 'zh');
const create = (type, props, ...children) => ({ type, props: props ?? {}, children });

test('plan page exposes daily refinement, distant workload and timer-based suggestions', () => {
  const data = planGet();
  data.rolling = { start: '2026-11-15', end: '2026-11-21', horizonDays: 7,
    refinement: { needed: true }, distantWork: [{ id: 'far', title: '强化阶段', targetDate: '2026-12-01', estimateMinutes: 90 }] };
  data.estimationSuggestions = [{ itemId: data.applied.data.items[0].id, originalEstimateMinutes: 60, suggestedEstimateMinutes: 85, actualMinutes: 85 }];
  const tree = PlanView({ create, t, view: { phase: 'ready', value: data, materials: [], progressItems: [], warnings: [] }, workspaceItems: [], onRefine: () => {} });
  assert.ok(byTestId(tree, 'plan-refine-today'));
  const rendered = text(tree);
  assert.match(rendered, /细化今天/);
  assert.match(rendered, /强化阶段/);
  assert.match(rendered, /85/);
  assert.doesNotMatch(rendered, /plan\.[a-z]/);
});
