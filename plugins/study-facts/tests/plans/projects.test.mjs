/**
 * Plan projects: a plan groups its tasks into named projects, each task keeps
 * one project id, and a confirmed plan carries the project and its assigned
 * date onto the execution task the workbench reads.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { boot, createMaterial, dateAfter, item, planPayload } from './helpers.mjs';

const PROJECTS = [
  { id: 'proj_chapter', title: '教材章节', kind: 'chapter', target: '过完前四章' },
  { id: 'proj_workbook', title: '练习册', kind: 'workbook' },
];

/** A draft payload with two projects, one dated task each, and no time of day. */
function withProjects(overrides = {}) {
  return planPayload({
    projects: PROJECTS,
    items: [
      item({ id: 'item_chapter', projectId: 'proj_chapter', title: '读第三章', start: null, end: null }),
      item({ id: 'item_workbook', projectId: 'proj_workbook', title: '第三章习题 1-10', start: null, end: null }),
    ],
    ...overrides,
  });
}

test('projects group tasks and a confirmed plan projects them onto dated execution tasks', async t => {
  const h = await boot(t);
  const draft = await h.ok('saveDraft', withProjects());

  assert.equal(draft.plan.counts.projects, 2);
  assert.deepEqual(draft.draft.data.projects.map(project => project.id), ['proj_chapter', 'proj_workbook']);
  assert.equal(draft.draft.data.items[0].projectId, 'proj_chapter');
  assert.equal(draft.draft.data.items[1].projectId, 'proj_workbook');
  assert.equal(draft.draft.data.items[0].start, null);

  const confirmed = await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  assert.equal(confirmed.plan.revision, 1);
  assert.equal(confirmed.revision.data.projects.length, 2);

  const day = await h.ctx.study.call('tasks', 'day', { date: dateAfter(0) }, {});
  assert.equal(day.ok, true, JSON.stringify(day));
  const chapter = day.value.tasks.find(task => task.title === '读第三章');
  const workbook = day.value.tasks.find(task => task.title === '第三章习题 1-10');
  assert.equal(chapter.scheduledDate, dateAfter(0));
  assert.equal(chapter.projectId, 'proj_chapter');
  assert.equal(chapter.projectTitle, '教材章节');
  assert.equal(workbook.projectId, 'proj_workbook');
  assert.equal(workbook.projectTitle, '练习册');
  assert.deepEqual(chapter.planItem, { planId: draft.plan.id, itemId: 'item_chapter' });
});

test('a task must reference an existing project and project ids stay unique', async t => {
  const h = await boot(t);

  const unknown = await h.fail('saveDraft', withProjects({
    items: [item({ id: 'item_1', projectId: 'proj_missing' })],
  }));
  assert.equal(unknown.code, 'invalid');
  assert.equal(unknown.details.field, 'items[0].projectId');
  assert.equal(unknown.details.projectId, 'proj_missing');

  const duplicate = await h.fail('saveDraft', withProjects({
    projects: [PROJECTS[0], { ...PROJECTS[1], id: 'proj_chapter' }],
  }));
  assert.equal(duplicate.code, 'invalid');
  assert.equal(duplicate.details.field, 'projects[1].id');

  const missingMaterial = await h.fail('saveDraft', withProjects({
    projects: [{ ...PROJECTS[0], materialId: 'material_gone' }, PROJECTS[1]],
  }));
  assert.equal(missingMaterial.code, 'not_found');

  const material = await createMaterial(h);
  const withMaterial = await h.ok('saveDraft', withProjects({
    projects: [{ ...PROJECTS[0], materialId: material.id }, PROJECTS[1]],
  }));
  assert.equal(withMaterial.draft.data.projects[0].materialId, material.id);
});

test('an existing database without the project columns gains them on boot', async t => {
  const h = await boot(t, { cleanup: false });
  await h.fiber.dispose();
  const database = new DatabaseSync(join(h.directory, 'study.db'));
  database.exec('ALTER TABLE study_task DROP COLUMN project_id');
  database.exec('ALTER TABLE study_task DROP COLUMN project_title');
  database.close();

  const reopened = await boot(t, { directory: h.directory, cleanup: false });
  const created = await reopened.ctx.study.call('tasks', 'createTask', { title: '旧库任务' }, { requestId: 'old-db-task' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.value.task.projectId, null);
  assert.equal(created.value.task.projectTitle, null);
  assert.equal(created.value.task.scheduledDate, null);
  await reopened.fiber.dispose();
  await rm(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('items without a project are kept, and an omitted project list is inherited on revision', async t => {
  const h = await boot(t);
  const draft = await h.ok('saveDraft', withProjects({
    items: [
      item({ id: 'item_chapter', projectId: 'proj_chapter', title: '读第三章', start: null, end: null }),
      item({ id: 'item_loose', projectId: null, title: '未归组任务', start: null, end: null }),
    ],
  }));
  assert.equal(draft.draft.data.items[1].projectId, null);
  assert.equal(draft.draft.data.projects.length, 2);

  await h.ok('confirm', { planId: draft.plan.id, baseRevision: 0 });
  const renamed = await h.ok('revise', {
    planId: draft.plan.id,
    baseRevision: 1,
    reason: '项目改名',
    projects: [{ ...PROJECTS[0], title: '教材精读' }, PROJECTS[1]],
    items: draft.draft.data.items,
  });
  assert.equal(renamed.plan.revision, 2);
  assert.equal(renamed.changes.projectsChanged, true);
  assert.equal(renamed.changes.projects.changed.length, 1);
  assert.deepEqual(renamed.changes.projects.changed[0].fields, ['title']);

  // A payload that edits only tasks keeps the projects it did not resend.
  const taskOnly = await h.ok('revise', {
    planId: draft.plan.id,
    baseRevision: 2,
    reason: '只调整任务',
    items: renamed.revision.data.items.map(entry => ({ ...entry, note: '调整说明' })),
  });
  assert.deepEqual(taskOnly.revision.data.projects.map(project => project.title), ['教材精读', '练习册']);
  assert.equal(taskOnly.revision.data.items[0].projectId, 'proj_chapter');
});
