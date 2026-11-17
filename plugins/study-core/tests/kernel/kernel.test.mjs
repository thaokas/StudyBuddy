import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStudyDatabase } from '../../host/db.mjs';
import { createKernel, localDate } from '../../host/kernel.mjs';
import { createRegistry } from '../../host/registry.mjs';

const MODULES = [{
  id: 'demo',
  deps: [],
  schemaVersion: 1,
  schema: [
    'CREATE TABLE demo_items (id TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT',
    'CREATE TABLE demo_log (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL) STRICT',
  ],
}];

function fixedClock(initial = new Date(2026, 10, 10, 9, 0, 0)) {
  let current = initial;
  return {
    now: () => new Date(current.getTime()),
    set: value => { current = value; },
  };
}

async function openHarness(t, { definitions = MODULES, clock = fixedClock() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'study-kernel-'));
  const kernels = [];
  t.after(async () => {
    for (const kernel of kernels) await kernel.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const database = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
  database.verifyModules(definitions);
  await database.applyModuleSchemas(definitions);
  const registry = createRegistry();
  const kernel = createKernel({ database, registry, modules: definitions, now: clock.now });
  kernels.push(kernel);
  return {
    directory,
    database,
    registry,
    kernel,
    clock,
    track: value => { kernels.push(value); return value; },
  };
}

test('a read returns its value with the stored revision', async t => {
  const { kernel } = await openHarness(t);
  kernel.register('tasks', { methods: { ping: payload => ({ pong: payload.value ?? null }) } });
  assert.deepEqual(await kernel.call('tasks', 'ping', { value: 'x' }), { ok: true, value: { pong: 'x' }, revision: 0 });
  assert.deepEqual(await kernel.call('tasks', 'ping'), { ok: true, value: { pong: null }, revision: 0 });
  assert.equal(kernel.revision(), 0);
});

test('a declared write bumps the revision once and records the request and change', async t => {
  const { kernel, database } = await openHarness(t);
  let calls = 0;
  kernel.register('tasks', {
    methods: {
      add(payload, api) {
        calls += 1;
        api.db.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', payload.id, payload.label);
        api.change({ entity: 'task', entityId: payload.id, action: 'create', after: { label: payload.label }, reason: '测试写入' });
        return { id: payload.id };
      },
    },
    writes: ['add'],
  });

  const result = await kernel.call('tasks', 'add', { id: 't1', label: '第一章' }, { actor: 'agent', requestId: 'req-1' });
  assert.deepEqual(result, { ok: true, value: { id: 't1' }, revision: 1 });
  assert.equal(calls, 1);
  assert.equal(database.get('SELECT COUNT(*) AS count FROM request_log').count, 1);
  assert.deepEqual({ ...database.get('SELECT actor, entity, entity_id, action, after_json FROM change_log') }, {
    actor: 'agent', entity: 'task', entity_id: 't1', action: 'create', after_json: '{"label":"第一章"}',
  });

  const replay = await kernel.call('tasks', 'add', { id: 't1', label: '第一章' }, { actor: 'ui', requestId: 'req-1' });
  assert.deepEqual(replay, result);
  assert.equal(calls, 1);
  assert.equal(kernel.revision(), 1);
  assert.equal(database.get('SELECT COUNT(*) AS count FROM demo_items').count, 1);
});

test('reusing a requestId for different content is a conflict without side effects', async t => {
  const { kernel, database } = await openHarness(t);
  kernel.register('tasks', {
    methods: { add: (payload, api) => { api.db.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', payload.id, payload.label); return payload.id; } },
    writes: ['add'],
  });

  await kernel.call('tasks', 'add', { id: 't1', label: 'A' }, { requestId: 'same-id' });
  const conflict = await kernel.call('tasks', 'add', { id: 't2', label: 'B' }, { requestId: 'same-id' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');
  assert.equal(conflict.details.requestId, 'same-id');
  assert.equal(kernel.revision(), 1);
  assert.equal(database.get('SELECT COUNT(*) AS count FROM demo_items').count, 1);
});

test('a stale expectedRevision is rejected with the latest revision', async t => {
  const { kernel, database } = await openHarness(t);
  kernel.register('tasks', {
    methods: { add: (payload, api) => { api.db.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', payload.id, payload.label); return payload.id; } },
    writes: ['add'],
  });

  await kernel.call('tasks', 'add', { id: 't1', label: 'A' }, { expectedRevision: 0, requestId: randomUUID() });
  const stale = await kernel.call('tasks', 'add', { id: 't2', label: 'B' }, { expectedRevision: 0, requestId: randomUUID() });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'conflict');
  assert.deepEqual(stale.details, { expectedRevision: 0, revision: 1 });
  assert.equal(database.get('SELECT COUNT(*) AS count FROM demo_items').count, 1);

  const fresh = await kernel.call('tasks', 'add', { id: 't3', label: 'C' }, { expectedRevision: 1, requestId: randomUUID() });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.revision, 2);
});

test('two concurrent calls at the same revision apply only one write', async t => {
  const { kernel, database } = await openHarness(t);
  kernel.register('tasks', {
    methods: {
      async slow(payload, api) {
        await new Promise(resolve => setTimeout(resolve, 20));
        api.db.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', payload.id, payload.label);
        return payload.id;
      },
    },
    writes: ['slow'],
  });

  const [first, second] = await Promise.all([
    kernel.call('tasks', 'slow', { id: 'a', label: 'A' }, { expectedRevision: 0, requestId: 'race-a' }),
    kernel.call('tasks', 'slow', { id: 'b', label: 'B' }, { expectedRevision: 0, requestId: 'race-b' }),
  ]);
  const results = [first, second];
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok && result.code === 'conflict').length, 1);
  assert.equal(kernel.revision(), 1);
  assert.equal(database.get('SELECT COUNT(*) AS count FROM demo_items').count, 1);
  assert.equal(database.get('SELECT COUNT(*) AS count FROM request_log').count, 1);
});

test('unknown namespaces, methods, and invalid requests fail with service codes', async t => {
  const { kernel } = await openHarness(t);
  kernel.register('tasks', { methods: { ping: () => 'pong' } });

  assert.equal((await kernel.call('plans', 'ping')).code, 'not_found');
  assert.equal((await kernel.call('tasks', 'missing')).code, 'not_found');
  assert.equal((await kernel.call('tasks', 'ping', [])).code, 'invalid');
  assert.equal((await kernel.call('tasks', 'ping', 'text')).code, 'invalid');
  assert.equal((await kernel.call('tasks', 'ping', {}, { requestId: '' })).code, 'invalid');
  assert.equal((await kernel.call('tasks', 'ping', {}, { requestId: 7 })).code, 'invalid');
  assert.equal((await kernel.call('tasks', 'ping', {}, { expectedRevision: -1 })).code, 'invalid');
  assert.equal((await kernel.call('tasks', 'ping', {}, { expectedRevision: 1.5 })).code, 'invalid');
  assert.equal((await kernel.call('tasks', 'ping', {}, { actor: 'nobody' })).code, 'invalid');
});

test('revision, history, and idempotent replay survive a restart', async t => {
  const harness = await openHarness(t);
  const { kernel, database, clock, directory, track } = harness;
  kernel.register('tasks', {
    methods: { add: (payload, api) => { api.db.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', payload.id, payload.label); api.change({ entity: 'task', entityId: payload.id, action: 'create' }); return { id: payload.id }; } },
    writes: ['add'],
  });
  const first = await kernel.call('tasks', 'add', { id: 't1', label: 'A' }, { requestId: 'persisted-1', actor: 'ui' });
  assert.deepEqual(first, { ok: true, value: { id: 't1' }, revision: 1 });
  await kernel.close();
  database.close();

  const reopened = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
  assert.deepEqual(reopened.verifyModules(MODULES), { blocked: null, unknownModules: [] });
  await reopened.applyModuleSchemas(MODULES);
  const registry = createRegistry();
  const kernel2 = track(createKernel({ database: reopened, registry, modules: MODULES, now: clock.now }));
  registry.register('tasks', {
    methods: { add: (payload, api) => { api.db.run('INSERT INTO demo_items (id, label) VALUES (?, ?)', payload.id, payload.label); return { id: payload.id }; } },
    writes: ['add'],
  });

  assert.equal(kernel2.revision(), 1);
  assert.deepEqual(await kernel2.call('tasks', 'add', { id: 't1', label: 'A' }, { requestId: 'persisted-1' }), first);
  assert.equal(reopened.get('SELECT COUNT(*) AS count FROM demo_items').count, 1);
  assert.equal(reopened.get('SELECT COUNT(*) AS count FROM change_log').count, 1);
  assert.equal((await kernel2.call('tasks', 'add', { id: 't2', label: 'B' }, { expectedRevision: 1, requestId: randomUUID() })).revision, 2);
});

test('the day snapshot is written once per local day and does not bump the revision', async t => {
  const clock = fixedClock();
  const { kernel, database } = await openHarness(t, { clock });
  kernel.register('tasks', { methods: { ping: () => 'pong' } });

  assert.equal(database.get('SELECT COUNT(*) AS count FROM day_snapshot').count, 0);
  await kernel.call('tasks', 'ping');
  await kernel.call('tasks', 'ping');
  assert.equal(database.get('SELECT COUNT(*) AS count FROM day_snapshot').count, 1);
  const snapshot = JSON.parse(database.get('SELECT plan_json FROM day_snapshot').plan_json);
  assert.equal(snapshot.date, '2026-11-10');
  assert.deepEqual(snapshot.items, []);
  assert.equal(kernel.revision(), 0);

  clock.set(new Date(2026, 10, 11, 8, 0, 0));
  await kernel.call('tasks', 'ping');
  assert.equal(database.get('SELECT COUNT(*) AS count FROM day_snapshot').count, 2);
  const status = kernel.status();
  assert.equal(status.today.date, '2026-11-11');
  assert.equal(status.today.snapshotAt, clock.now().toISOString());
  assert.equal(status.revision, 0);
});

test('a day snapshot provider enriches the once-per-day plan', async t => {
  const { kernel, database } = await openHarness(t);
  const dispose = kernel.setDaySnapshotProvider(({ date, revision }) => ({ items: [{ id: 'warmup' }], date, revision }));
  try {
    kernel.register('tasks', { methods: { ping: () => 'pong' } });
    await kernel.call('tasks', 'ping');
  } finally {
    dispose();
  }
  const snapshot = JSON.parse(database.get('SELECT plan_json FROM day_snapshot').plan_json);
  assert.deepEqual(snapshot.items, [{ id: 'warmup' }]);
  assert.equal(snapshot.date, '2026-11-10');
  assert.equal(snapshot.revision, 0);
});

test('an incompatible module schema refuses writes but still answers reads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-kernel-'));
  const file = join(directory, 'study.db');
  let database = await openStudyDatabase({ file });
  database.verifyModules(MODULES);
  await database.applyModuleSchemas(MODULES);
  database.close();

  database = await openStudyDatabase({ file });
  const verification = database.verifyModules([{ ...MODULES[0], schemaVersion: 2 }]);
  assert.equal(verification.blocked.reason, 'module-schema-mismatch');
  const registry = createRegistry();
  const kernel = createKernel({ database, registry, modules: [] });
  t.after(async () => {
    await kernel.close();
    await rm(directory, { recursive: true, force: true });
  });

  registry.register('tasks', { methods: { ping: () => 'pong', add: () => 'added' }, writes: ['add'] });
  assert.equal((await kernel.call('tasks', 'ping')).ok, true);
  assert.equal((await kernel.call('tasks', 'ping')).value, 'pong');
  assert.equal(kernel.status().blocked.modules[0].id, 'demo');

  const write = await kernel.call('tasks', 'add', {}, { requestId: randomUUID() });
  assert.equal(write.ok, false);
  assert.equal(write.code, 'unavailable');
  assert.match(write.details.recovery, /备份/);
});

test('a nested call joins the caller transaction and rolls back with it', async t => {
  const { kernel, database } = await openHarness(t);
  kernel.register('memory', {
    methods: {
      note: payload => { database.run('INSERT INTO demo_log (note) VALUES (?)', payload.note); return { note: payload.note }; },
    },
    writes: ['note'],
  });
  kernel.register('tasks', {
    methods: {
      async compose(payload, api) {
        const nested = await api.kernel.call('memory', 'note', { note: payload.note }, { actor: 'internal', requestId: `${api.requestId}:nested` });
        assert.equal(nested.ok, true);
        if (payload.fail === true) throw new Error('outer failure');
        return { nestedRevision: nested.revision };
      },
    },
    writes: ['compose'],
  });

  const ok = await kernel.call('tasks', 'compose', { note: 'kept' }, { requestId: 'keep-nested' });
  assert.equal(ok.ok, true);
  assert.equal(ok.revision, 2);
  assert.equal(database.get('SELECT COUNT(*) AS count FROM demo_log').count, 1);

  const failed = await kernel.call('tasks', 'compose', { note: 'discarded', fail: true }, { requestId: 'fail-nested' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'unavailable');
  assert.equal(database.get('SELECT COUNT(*) AS count FROM demo_log').count, 1);
  assert.equal(kernel.revision(), 2);
});

test('a non-JSON result fails loudly and rolls the write back', async t => {
  const { kernel, database } = await openHarness(t);
  kernel.register('tasks', { methods: { broken: () => ({ big: 10n }) }, writes: ['broken'] });
  const result = await kernel.call('tasks', 'broken', {}, { requestId: 'broken-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unavailable');
  assert.match(result.message, /JSON/);
  assert.equal(kernel.revision(), 0);
  assert.equal(database.get('SELECT COUNT(*) AS count FROM request_log').count, 0);
});

test('status reports storage, modules, namespaces, and today', async t => {
  const clock = fixedClock();
  const { kernel } = await openHarness(t, { clock });
  kernel.register('kernel', { methods: { status: (_payload, api) => api.kernel.status() } });
  const result = await kernel.call('kernel', 'status', {}, { actor: 'ui' });
  assert.equal(result.ok, true);
  const status = result.value;
  assert.equal(status.revision, 0);
  assert.equal(status.blocked, null);
  assert.equal(status.database.journalMode, 'wal');
  assert.equal(status.database.coreSchemaVersion, 1);
  assert.ok(status.database.file.endsWith('study.db'));
  assert.deepEqual(status.modules, [{ id: 'demo', deps: [], schemaVersion: 1, schemaStatements: 2 }]);
  assert.deepEqual(status.namespaces, [{ ns: 'kernel', methods: ['status'], writes: [] }]);
  assert.equal(status.today.date, localDate(clock.now()));
  assert.equal(status.today.snapshotAt, clock.now().toISOString());
  assert.equal(status.serverTime, clock.now().toISOString());
});

test('registration through the kernel reaches the same registry', async t => {
  const { kernel } = await openHarness(t);
  const dispose = kernel.register('timer', { methods: { read: () => 1 } });
  assert.equal((await kernel.call('timer', 'read')).ok, true);
  dispose();
  assert.equal((await kernel.call('timer', 'read')).code, 'not_found');
});

test('closing the kernel waits for queued work and refuses later calls', async t => {
  const { kernel } = await openHarness(t);
  let finished = false;
  kernel.register('tasks', {
    methods: {
      async slow() { await new Promise(resolve => setTimeout(resolve, 30)); finished = true; return 'done'; },
    },
    writes: ['slow'],
  });
  const pending = kernel.call('tasks', 'slow', {}, { requestId: randomUUID() });
  await kernel.close();
  assert.equal(finished, true);
  assert.deepEqual(await pending, { ok: true, value: 'done', revision: 1 });
  assert.equal((await kernel.call('tasks', 'slow')).code, 'unavailable');
});
