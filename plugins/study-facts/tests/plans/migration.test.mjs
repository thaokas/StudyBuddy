import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStudyDatabase } from '../../../study-core/host/db.mjs';
import { loadModuleDefinitions } from '../../../study-outcomes/host/index.mjs';
import { boot, dateAfter } from './helpers.mjs';

async function legacy(t, corrupt = false) {
  const directory = await mkdtemp(join(tmpdir(), 'study-foundation-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const db = await openStudyDatabase({ file: join(directory, 'study.db') });
  const modules = await loadModuleDefinitions(join(process.cwd(), 'plugins/study-facts/host/modules'));
  // Deliberately bypass current migrations: these are the shipped v1 tables.
  for (const module of modules) if (module.schema.length) {
    for (const ddl of module.schema) db.exec(ddl);
    db.run('INSERT INTO module_schema VALUES (?, ?, ?)', module.id, module.schemaVersion, new Date().toISOString());
  }
  const at = new Date().toISOString();
  const data = { title: 'legacy', goalId: 'old-goal', trial: false, reviewAt: null,
    stageGoals: [], weekGoals: [], availability: [{ date: dateAfter(), minutes: 120 }], assumptions: [], constraints: [],
    items: [{ id: 'old-item', title: 'legacy task', date: dateAfter(), start: '09:00', end: '10:00',
      subject: null, materialId: null, completion: null, note: null, locator: null, source: 'student',
      estimateMinutes: 60, flexible: true, dependencies: [] }] };
  db.run('INSERT INTO study_goal (id, exam, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', 'old-goal', 'legacy exam', at, at);
  db.run("INSERT INTO study_plan VALUES ('old-plan', 'old-goal', 'legacy', 'active', 1, 'old-rev', ?, ?)", at, at);
  db.run(`INSERT INTO study_plan_revision (id,plan_id,number,status,action,actor,snapshot_json,created_at,applied_at)
    VALUES ('old-rev','old-plan',1,'applied','confirm','ui',?,?,?)`, corrupt ? '{bad' : JSON.stringify(data), at, at);
  db.run(`INSERT INTO study_plan_draft VALUES ('old-plan','old-draft',1,?,'legacy draft','ui',?,?)`, JSON.stringify(data), at, at);
  db.run(`INSERT INTO study_plan_progress (plan_id,revision,item_id,date,status,confirmed,actor,at)
    VALUES ('old-plan',1,'old-item',?,'done',1,'ui',?)`, dateAfter(), at);
  db.close();
  return directory;
}

test('SB-01/03: migrate a plans-only v1 database, preserve progress, backup and draft revision', async t => {
  const directory = await legacy(t);
  const h = await boot(t, { directory, cleanup: false });
  const detail = await h.ok('get');
  assert.equal(detail.draft.draftRevision, 1);
  assert.equal(detail.progress.counts.done, 1);
  assert.ok(detail.applied.data.items[0].taskId);
  const db = new DatabaseSync(join(directory, 'study.db'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM study_plan_progress').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM study_task_progress').get().n, 1);
  assert.equal(db.prepare('SELECT legacy_progress_id FROM study_task_progress').get().legacy_progress_id, 1);
  assert.equal(db.prepare('SELECT source_revision FROM study_plan_task').get().source_revision, 1);
  await access(db.prepare("SELECT value FROM meta WHERE key = 'data_foundation_backup'").get().value);
  db.close();
  await h.fiber.dispose();
  const second = await boot(t, { directory, cleanup: false });
  const day = await second.ctx.study.call('tasks', 'day', {});
  assert.equal(day.value.tasks.length, 1);
  assert.equal(day.value.blocks.length, 1);
  await second.fiber.dispose();
});

test('SB-01: failed migration rolls back schema/data and retains an accessible backup', async t => {
  const directory = await legacy(t, true);
  await assert.rejects(boot(t, { directory, cleanup: false }), /迁移失败/);
  const db = new DatabaseSync(join(directory, 'study.db'));
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'data_foundation_version'").get(), undefined);
  assert.equal(db.prepare('PRAGMA table_info(study_task)').all().some(row => row.name === 'goal_id'), false);
  assert.equal(db.prepare('SELECT snapshot_json FROM study_plan_revision').get().snapshot_json, '{bad');
  assert.equal(db.prepare('SELECT count(*) AS n FROM study_plan_progress').get().n, 1);
  db.close();
});
