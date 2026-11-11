import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CORE_SCHEMA_VERSION, openStudyDatabase } from '../../host/db.mjs';
import { StudyError } from '../../host/registry.mjs';

const DEMO = [{
  id: 'demo',
  deps: [],
  schemaVersion: 1,
  schema: ['CREATE TABLE demo_items (id TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT'],
}];

const OTHER = [{
  id: 'other',
  deps: [],
  schemaVersion: 1,
  schema: ['CREATE TABLE other_items (id TEXT PRIMARY KEY) STRICT'],
}];

/** One temporary directory; databases close before the directory is removed. */
async function setup(t) {
  const state = { directory: await mkdtemp(join(tmpdir(), 'study-db-')), closers: [] };
  t.after(async () => {
    for (const close of state.closers.reverse()) {
      try { close(); } catch { /* A failed cleanup close must not hide the test result. */ }
    }
    await rm(state.directory, { recursive: true, force: true });
  });
  state.file = join(state.directory, 'study.db');
  state.open = async () => {
    const database = await openStudyDatabase({ file: state.file });
    state.closers.push(() => database.close());
    return database;
  };
  return state;
}

test('opens a WAL database with the core tables and a seeded revision', async t => {
  const state = await setup(t);
  const database = await state.open();

  assert.equal(database.file, state.file);
  assert.equal(database.blocked, null);
  assert.deepEqual(database.unknownModules, []);
  assert.equal(database.get('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(database.get('PRAGMA user_version').user_version, CORE_SCHEMA_VERSION);
  assert.equal(database.readMeta('revision'), '0');
  for (const table of ['meta', 'module_schema', 'request_log', 'change_log', 'day_snapshot']) {
    assert.equal(
      database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table).name,
      table,
    );
  }
});

test('module schemas are applied once and survive a reopen', async t => {
  const state = await setup(t);

  let database = await state.open();
  assert.deepEqual(database.verifyModules(DEMO), { blocked: null, unknownModules: [] });
  await database.applyModuleSchemas(DEMO);
  database.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', 'a', '任务');
  assert.equal(database.get('SELECT schema_version FROM module_schema WHERE module_id = ?', 'demo').schema_version, 1);
  database.close();

  database = await state.open();
  assert.deepEqual(database.verifyModules(DEMO), { blocked: null, unknownModules: [] });
  await database.applyModuleSchemas(DEMO);
  assert.equal(database.get('SELECT label FROM demo_items WHERE id = ?', 'a').label, '任务');
});

test('an unknown core layout is rejected with backup guidance', async t => {
  const state = await setup(t);
  const raw = new DatabaseSync(state.file);
  raw.exec('PRAGMA user_version = 99');
  raw.close();

  await assert.rejects(openStudyDatabase({ file: state.file }), error => {
    assert.ok(error instanceof StudyError);
    assert.equal(error.code, 'unavailable');
    assert.equal(error.details.databaseVersion, 99);
    assert.equal(error.details.supportedVersion, CORE_SCHEMA_VERSION);
    assert.match(error.details.recovery, /备份/);
    return true;
  });
});

test('a file that is not a SQLite database fails with recovery guidance', async t => {
  const state = await setup(t);
  await writeFile(state.file, 'this is not a database');

  await assert.rejects(openStudyDatabase({ file: state.file }), error => {
    assert.ok(error instanceof StudyError);
    assert.equal(error.code, 'unavailable');
    assert.match(error.details.recovery, /备份/);
    return true;
  });
});

test('a module schema mismatch blocks every write and names the recovery step', async t => {
  const state = await setup(t);

  let database = await state.open();
  database.verifyModules(DEMO);
  await database.applyModuleSchemas(DEMO);
  database.close();

  database = await state.open();
  const upgraded = [{ ...DEMO[0], schemaVersion: 2 }];
  const verification = database.verifyModules(upgraded);
  assert.equal(verification.blocked.reason, 'module-schema-mismatch');
  assert.deepEqual(verification.blocked.modules, [{ id: 'demo', databaseVersion: 1, supportedVersion: 2 }]);
  assert.match(verification.blocked.recovery, /备份/);

  assert.throws(() => database.assertWritable(), error => {
    assert.equal(error.code, 'unavailable');
    assert.equal(error.details.modules[0].id, 'demo');
    return true;
  });
  await assert.rejects(database.applyModuleSchemas(upgraded), error => error.code === 'unavailable');
  // Reads stay available so the mismatch can be inspected.
  assert.equal(database.get('SELECT COUNT(*) AS count FROM demo_items').count, 0);
});

test('removed modules are reported but do not block writes', async t => {
  const state = await setup(t);

  let database = await state.open();
  database.verifyModules([...DEMO, ...OTHER]);
  await database.applyModuleSchemas([...DEMO, ...OTHER]);
  database.close();

  database = await state.open();
  const verification = database.verifyModules(DEMO);
  assert.equal(verification.blocked, null);
  assert.deepEqual(verification.unknownModules, ['other']);
  assert.doesNotThrow(() => database.assertWritable());
});

test('transactions commit, roll back, and nest through savepoints', async t => {
  const state = await setup(t);
  const database = await state.open();
  await database.applyModuleSchemas(DEMO);

  const count = () => database.get('SELECT COUNT(*) AS count FROM demo_items').count;

  await database.transaction(async () => {
    database.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', 'a', 'A');
    await assert.rejects(database.transaction(async () => {
      database.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', 'b', 'B');
      throw new Error('inner failure');
    }), /inner failure/);
    assert.equal(count(), 1);
  });
  assert.equal(count(), 1);

  await assert.rejects(database.transaction(async () => {
    database.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', 'c', 'C');
    throw new Error('outer failure');
  }), /outer failure/);
  assert.equal(count(), 1);
});

test('change_log is append-only at the storage layer', async t => {
  const state = await setup(t);
  const database = await state.open();

  database.run(
    'INSERT INTO change_log (at, actor, entity, entity_id, action, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    '2026-11-10T00:00:00.000Z', 'system', 'task', 't1', 'create', null, '{"label":"A"}', null,
  );
  assert.throws(() => database.run('UPDATE change_log SET reason = ? WHERE id = 1', 'edited'), /append-only/);
  assert.throws(() => database.run('DELETE FROM change_log'), /append-only/);
  assert.equal(database.get('SELECT COUNT(*) AS count FROM change_log').count, 1);
});

test('day_snapshot is written once per date and stays immutable', async t => {
  const state = await setup(t);
  const database = await state.open();

  database.run('INSERT OR IGNORE INTO day_snapshot (date, plan_json, created_at) VALUES (?, ?, ?)', '2026-11-10', '{"items":["first"]}', '2026-11-10T00:00:00.000Z');
  database.run('INSERT OR IGNORE INTO day_snapshot (date, plan_json, created_at) VALUES (?, ?, ?)', '2026-11-10', '{"items":["second"]}', '2026-11-10T01:00:00.000Z');
  assert.equal(database.get('SELECT plan_json FROM day_snapshot WHERE date = ?', '2026-11-10').plan_json, '{"items":["first"]}');
  assert.throws(() => database.run('UPDATE day_snapshot SET plan_json = ? WHERE date = ?', '{"items":[]}', '2026-11-10'), /write-once/);
  assert.throws(() => database.run('DELETE FROM day_snapshot'), /write-once/);
});

test('a closed database refuses further work with unavailable', async t => {
  const state = await setup(t);
  const database = await state.open();
  database.close();
  assert.throws(() => database.get('SELECT 1 AS one'), error => error.code === 'unavailable');
  assert.doesNotThrow(() => database.close());
});
