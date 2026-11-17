/**
 * The v1 memory.json -> SQLite migration: backup, field mapping, verification,
 * idempotency, and the read-only fallback after a failed import.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openMemoryHarness } from './helpers.mjs';

const LEGACY = {
  version: 1,
  updatedAt: '2026-11-01T01:00:00.000Z',
  items: [
    {
      id: 'mem_aaaaaaaaaaaa',
      goalId: 'memory-goal',
      kind: 'preference',
      text: '我更喜欢在上午学习数学。',
      createdAt: '2026-10-01T01:00:00.000Z',
      updatedAt: '2026-10-02T01:00:00.000Z',
      expiresAt: null,
      source: { actor: 'agent', requestId: 'legacy-1', at: '2026-10-02T01:00:00.000Z', note: '来自旧对话' },
    },
    {
      id: 'mem_bbbbbbbbbbbb',
      kind: 'state',
      text: '这几天在准备期中考试。',
      createdAt: '2026-10-03T01:00:00.000Z',
      updatedAt: '2026-10-03T01:00:00.000Z',
      expiresAt: '2026-11-20T01:00:00.000Z',
      source: { actor: 'ui', requestId: null, at: '2026-10-03T01:00:00.000Z' },
    },
    {
      id: 'mem_cccccccccccc',
      kind: 'observation',
      text: '换元后常忘记改上下限。',
      createdAt: '2026-10-04T01:00:00.000Z',
      updatedAt: '2026-10-04T01:00:00.000Z',
      expiresAt: null,
      source: { actor: 'agent', at: '2026-10-04T01:00:00.000Z' },
    },
  ],
  tombstones: [
    {
      id: 'mem_dddddddddddd',
      contentHash: normalizeHash('已经删掉的旧记忆。'),
      goalId: 'memory-goal',
      deletedAt: '2026-10-05T01:00:00.000Z',
      source: { actor: 'ui', at: '2026-10-05T01:00:00.000Z' },
    },
    {
      id: 'mem_eeeeeeeeeeee',
      contentHash: 'raw-hash-without-goal',
      deletedAt: '2026-10-06T01:00:00.000Z',
      source: { actor: 'agent', at: '2026-10-06T01:00:00.000Z' },
    },
  ],
};

test('the v1 file is backed up and imported into the three tables', async t => {
  const harness = await openMemoryHarness(t, { memoryFile: LEGACY });

  const original = await readFile(join(harness.directory, 'memory.json'), 'utf8');
  const backup = await readFile(join(harness.directory, 'memory.v1.backup.json'), 'utf8');
  assert.equal(backup, original, '备份必须是原文件的逐字副本');

  const items = harness.rows('SELECT * FROM study_memory_item ORDER BY id');
  assert.equal(items.length, 3);
  const preference = items.find(item => item.id === 'mem_aaaaaaaaaaaa');
  assert.equal(preference.kind, 'preference');
  assert.equal(preference.goal_id, 'memory-goal');
  assert.equal(preference.text, '我更喜欢在上午学习数学。');
  assert.equal(preference.status, 'active');
  assert.equal(preference.source_kind, 'explicit');
  assert.equal(preference.source_actor, 'agent');
  assert.equal(preference.valid_from, '2026-10-01T01:00:00.000Z');
  assert.equal(preference.created_at, '2026-10-01T01:00:00.000Z');
  assert.equal(preference.updated_at, '2026-10-02T01:00:00.000Z');
  assert.equal(preference.valid_until, null);
  assert.equal(preference.confidence, 1);

  const state = items.find(item => item.id === 'mem_bbbbbbbbbbbb');
  assert.equal(state.goal_id, 'memory-goal', '缺失 goalId 时填当前目标');
  assert.equal(state.valid_until, '2026-11-20T01:00:00.000Z');

  const tombstones = harness.rows('SELECT * FROM study_memory_tombstone ORDER BY id');
  assert.equal(tombstones.length, 2);
  assert.equal(tombstones[0].content_hash, LEGACY.tombstones[0].contentHash);
  assert.equal(tombstones[0].goal_id, 'memory-goal');
  assert.equal(tombstones[1].goal_id, 'memory-goal');
  assert.match(tombstones[0].source_json, /ui/);

  const legacy = JSON.parse(harness.row('SELECT json FROM study_memory_state').json);
  assert.equal(legacy.items.length, 3);
  assert.equal(legacy.tombstones.length, 2);

  const listed = await harness.recall({});
  assert.equal(listed.value.items.length, 3);
  assert.equal(harness.row("SELECT schema_version FROM module_schema WHERE module_id = 'memory'").schema_version, 1);
  assert.notEqual(harness.row("SELECT name FROM sqlite_master WHERE name = 'study_memory_evidence'"), undefined);
});

test('a migrated tombstone still suppresses the same content', async t => {
  const harness = await openMemoryHarness(t, { memoryFile: LEGACY });
  const result = await harness.remember(
    { text: '已经删掉的旧记忆。', kind: 'preference' },
    { actor: 'agent', requestId: 'rebuild-after-migration' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'suppressed');
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_memory_item'), 3);
});

test('legacy memories become student scoped and preserve their original source in recall and export', async t => {
  const h = await openMemoryHarness(t, { memoryFile: LEGACY });
  const recalled = await h.ok('memory', 'recall');
  const item = recalled.items.find(x => x.id === 'mem_aaaaaaaaaaaa');
  assert.equal(item.scope, 'student');
  assert.equal(item.source.note, '来自旧对话');
  assert.equal(item.source.requestId, 'legacy-1');
  const exported = await h.ok('memory', 'export');
  assert.equal(exported.items.find(x => x.id === item.id).scope, 'student');
});

test('migration is idempotent, keeps memory.json as the export source, and stops writing it', async t => {
  const harness = await openMemoryHarness(t, { memoryFile: LEGACY });
  const before = await readFile(join(harness.directory, 'memory.json'), 'utf8');
  const backup = await readFile(join(harness.directory, 'memory.v1.backup.json'), 'utf8');

  const saved = await harness.remember({ text: '新的偏好。', kind: 'preference' });
  assert.equal(saved.ok, true);
  const after = await readFile(join(harness.directory, 'memory.json'), 'utf8');
  assert.equal(after, before, '迁移后不再写 memory.json');
  assert.equal(await readFile(join(harness.directory, 'memory.v1.backup.json'), 'utf8'), backup);

  await harness.kernel.close();
  const reopened = await openMemoryHarness(t, { directory: harness.directory, initial: harness.clock.now() });
  assert.equal(reopened.count('SELECT COUNT(*) AS count FROM study_memory_item'), 4);
  assert.equal(reopened.count('SELECT COUNT(*) AS count FROM study_memory_tombstone'), 2);
});

test('the study_memory_state row is also migrated when memory.json is absent', async t => {
  const harness = await openMemoryHarness(t, {
    beforeApply(database) {
      database.exec('CREATE TABLE IF NOT EXISTS study_memory_state (id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL) STRICT');
      database.run('INSERT INTO study_memory_state (id, json) VALUES (1, ?)', JSON.stringify(LEGACY));
    },
  });
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_memory_item'), 3);
  const backup = await readFile(join(harness.directory, 'memory.v1.backup.json'), 'utf8');
  assert.match(backup, /换元后常忘记改上下限/);
});

test('a failed import rolls back, keeps the file, and switches to unavailable', async t => {
  const harness = await openMemoryHarness(t, {
    memoryFile: LEGACY,
    beforeApply(database) {
      database.exec("CREATE TRIGGER fail_memory_item BEFORE INSERT ON study_memory_item BEGIN SELECT RAISE(ABORT, 'boom'); END");
    },
  });

  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_memory_item'), 0);
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_memory_tombstone'), 0);
  const source = await readFile(join(harness.directory, 'memory.json'), 'utf8');
  assert.equal(source, JSON.stringify(LEGACY, null, 2));
  const backup = await readFile(join(harness.directory, 'memory.v1.backup.json'), 'utf8');
  assert.equal(backup, source);

  const listed = await harness.recall({});
  assert.equal(listed.ok, false);
  assert.equal(listed.code, 'unavailable');
  assert.match(listed.message, /memory\.v1\.backup\.json/);
  assert.match(listed.message, /boom/);

  const saved = await harness.remember({ text: '不应该写入', kind: 'preference' });
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'unavailable');
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_memory_item'), 0);

  // The contract still renders the source read-only so the next prompt does
  // not silently lose the student's remembered preferences.
  const fallback = harness.contextText();
  assert.match(fallback, /学习记忆/);
  assert.match(fallback, /上午学习数学/);

  harness.database.exec('DROP TRIGGER fail_memory_item');
  await harness.kernel.close();
  const reopened = await openMemoryHarness(t, { directory: harness.directory, initial: harness.clock.now() });
  assert.equal(reopened.count('SELECT COUNT(*) AS count FROM study_memory_item'), 3);
  assert.equal(reopened.count('SELECT COUNT(*) AS count FROM study_memory_tombstone'), 2);
});

function normalizeHash(text) {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    .replace(/[，。！？、；：,.!?;:'"“”‘’（）()\[\]{}<>《》]/g, '');
  return createHash('sha256').update(normalized).digest('hex');
}
