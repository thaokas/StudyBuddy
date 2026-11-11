import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { boot, dateAfter, item, planPayload } from './helpers.mjs';

const PLAN_ROUTES = [
  '/api/study/plans/list',
  '/api/study/plans/get',
  '/api/study/plans/revisions',
  '/api/study/plans/today',
  '/api/study/plans/week',
  '/api/study/plans/progress',
  '/api/study/plans/saveDraft',
  '/api/study/plans/discardDraft',
  '/api/study/plans/confirm',
  '/api/study/plans/revise',
  '/api/study/plans/undo',
  '/api/study/plans/recordProgress',
];

function contentOf(payload) {
  const { baseRevision, ...content } = payload;
  void baseRevision;
  return content;
}

async function changeCount(directory, action) {
  const database = new DatabaseSync(join(directory, 'study.db'), { readOnly: true });
  try {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM change_log WHERE entity = 'plan' AND action = ?").get(action).count);
  } finally {
    database.close();
  }
}

test('the plugin serves every plans method and exposes both tools', async t => {
  const harness = await boot(t);
  const planTool = harness.tools.find(tool => tool.name === 'study_plan');
  const progressTool = harness.tools.find(tool => tool.name === 'study_progress');
  assert.ok(planTool);
  assert.ok(progressTool);
  assert.deepEqual(planTool.parameters.properties.action.enum, ['today', 'week', 'get', 'draft', 'confirm', 'revise', 'undo']);
  assert.deepEqual(progressTool.parameters.properties.action.enum, ['read', 'record']);
  for (const path of PLAN_ROUTES) {
    assert.ok(harness.routes.some(route => route.path === path), `missing route ${path}`);
  }
});

test('the plan tool reads the same facts as the service for today, week, and get', async t => {
  const harness = await boot(t);
  const payload = planPayload();
  const draft = await harness.ok('saveDraft', payload);
  await harness.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });

  const todayTool = await harness.tool('study_plan', { action: 'today', planId: draft.plan.id });
  const todayService = await harness.ok('today', { planId: draft.plan.id });
  assert.deepEqual(todayTool, todayService);

  const weekTool = await harness.tool('study_plan', { action: 'week', planId: draft.plan.id, date: dateAfter(0) });
  const weekService = await harness.ok('week', { planId: draft.plan.id, date: dateAfter(0) });
  assert.deepEqual(weekTool, weekService);

  const getTool = await harness.tool('study_plan', { action: 'get', planId: draft.plan.id });
  const getService = await harness.ok('get', { planId: draft.plan.id });
  assert.deepEqual(getTool, getService);
});

test('the plan tool submits, confirms, revises, and undoes through the same service as the agent', async t => {
  const harness = await boot(t);
  const payload = planPayload({ title: '工具生成的计划' });
  const drafted = await harness.tool('study_plan', {
    action: 'draft',
    baseRevision: 0,
    requestId: 'tool-plan-draft',
    plan: contentOf(payload),
  });
  assert.equal(drafted.plan.revision, 0);
  assert.equal(drafted.plan.title, '工具生成的计划');
  assert.equal(drafted.draft.data.items.length, 2);

  const replay = await harness.tool('study_plan', {
    action: 'draft',
    baseRevision: 0,
    requestId: 'tool-plan-draft',
    plan: contentOf(payload),
  });
  assert.deepEqual(replay, drafted);
  assert.equal(await changeCount(harness.directory, 'draft'), 1);

  const confirmed = await harness.tool('study_plan', {
    action: 'confirm',
    baseRevision: 0,
  }, { callId: 'tool-plan-confirm' });
  assert.equal(confirmed.plan.revision, 1);
  assert.equal(confirmed.plan.title, '工具生成的计划');
  const items = confirmed.revision.data.items;

  const revised = await harness.tool('study_plan', {
    action: 'revise',
    baseRevision: 1,
    reason: '工具应用修订',
    plan: {
      title: '工具修订后的计划',
      items: [
        item({ id: items[0].id, title: items[0].title, estimateMinutes: 30 }),
        items[1],
      ],
    },
  }, { callId: 'tool-plan-revise' });
  assert.equal(revised.plan.revision, 2);
  assert.equal(revised.plan.title, '工具修订后的计划');
  assert.equal(revised.revision.reason, '工具应用修订');

  const undone = await harness.tool('study_plan', {
    action: 'undo',
    baseRevision: 2,
  }, { callId: 'tool-plan-undo' });
  assert.equal(undone.plan.revision, 3);
  assert.equal(undone.revision.action, 'undo');
  assert.equal(undone.plan.title, '工具生成的计划');

  const database = new DatabaseSync(join(harness.directory, 'study.db'), { readOnly: true });
  try {
    const rows = database.prepare("SELECT actor, action FROM change_log WHERE entity = 'plan' ORDER BY id").all();
    assert.deepEqual(rows.map(row => ({ ...row })), [
      { actor: 'agent', action: 'draft' },
      { actor: 'agent', action: 'confirm' },
      { actor: 'agent', action: 'revise' },
      { actor: 'agent', action: 'undo' },
    ]);
  } finally {
    database.close();
  }
});

test('the progress tool reads and records the same feedback as the service', async t => {
  const harness = await boot(t);
  const draft = await harness.ok('saveDraft', planPayload());
  const confirmed = await harness.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  const itemId = confirmed.revision.data.items[0].id;

  const recorded = await harness.tool('study_progress', {
    action: 'record',
    planId: draft.plan.id,
    itemId,
    status: 'partial',
    quantityDone: 3,
    quantityTotal: 10,
    note: '做完三题',
  }, { callId: 'tool-progress-record' });
  assert.equal(recorded.record.status, 'partial');
  assert.equal(recorded.record.actor, 'agent');
  assert.equal(recorded.progress.confirmed, true);

  const readTool = await harness.tool('study_progress', { action: 'read', planId: draft.plan.id, history: true });
  const readService = await harness.ok('progress', { planId: draft.plan.id, history: true });
  assert.deepEqual(readTool, readService);
  assert.equal(readTool.records.length, 1);
  assert.equal(readTool.items[0].progress.note, '做完三题');
});

test('tool failures keep the service code and message actionable', async t => {
  const harness = await boot(t);
  await assert.rejects(async () => harness.tool('study_plan', { action: 'draft', baseRevision: 0 }), /plan/);
  await assert.rejects(async () => harness.tool('study_plan', { action: 'delete_everything' }), /invalid arguments/);
  await assert.rejects(async () => harness.tool('study_progress', { action: 'forget' }), /invalid arguments/);

  const draft = await harness.ok('saveDraft', planPayload());
  await harness.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  await assert.rejects(
    async () => harness.tool('study_plan', { action: 'undo', planId: draft.plan.id, baseRevision: 0 }),
    /conflict|过期|最新/,
  );
  await assert.rejects(
    async () => harness.tool('study_progress', { action: 'record', planId: draft.plan.id, itemId: 'item_missing', status: 'done' }),
    /not_found|找不到/,
  );
});

test('the HTTP route writes as the ui actor and replays the same requestId', async t => {
  const harness = await boot(t);
  const route = harness.routes.find(entry => entry.path === '/api/study/plans/saveDraft');
  assert.ok(route);
  const payload = planPayload({ title: '界面提交的草案' });
  const body = JSON.stringify({ requestId: 'http-draft-1', expectedRevision: 0, expectedDraftRevision: 0, ...contentOf(payload), baseRevision: 0 });

  const first = await route.fetch(new Request('http://localhost/api/study/plans/saveDraft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }));
  assert.equal(first.status, 200);
  const firstEnvelope = await first.json();
  assert.equal(firstEnvelope.ok, true);
  assert.equal(firstEnvelope.value.plan.title, '界面提交的草案');

  const second = await route.fetch(new Request('http://localhost/api/study/plans/saveDraft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }));
  const secondEnvelope = await second.json();
  assert.deepEqual(secondEnvelope, firstEnvelope);

  const database = new DatabaseSync(join(harness.directory, 'study.db'), { readOnly: true });
  try {
    const rows = database.prepare("SELECT actor, action FROM change_log WHERE entity = 'plan' AND action = 'draft'").all();
    assert.deepEqual(rows.map(row => ({ ...row })), [{ actor: 'ui', action: 'draft' }]);
  } finally {
    database.close();
  }
});
