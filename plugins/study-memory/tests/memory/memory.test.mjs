import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openMemoryHarness } from './helpers.mjs';

const remember = (harness, payload, options = { actor: 'ui' }) => harness.remember({ ...payload }, { requestId: randomUUID(), ...options });
const recall = (harness, payload = {}) => harness.recall(payload);
const forget = (harness, payload) => harness.forget(payload, { requestId: randomUUID(), actor: 'ui' });

async function restart(t, harness) {
  await harness.kernel.close();
  return openMemoryHarness(t, { directory: harness.directory, initial: harness.clock.now() });
}

test('remember stores a preference with its time and source, and recall lists it', async t => {
  const harness = await openMemoryHarness(t);
  const saved = await remember(harness, { text: '我更喜欢在上午学习数学。', kind: 'preference' }, { actor: 'agent', requestId: 'req-1' });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.status, 'created');
  assert.equal(saved.value.item.source.actor, 'agent');
  assert.equal(saved.value.item.source.requestId, 'req-1');
  assert.match(saved.value.item.createdAt, /^2026-11-10T01:00:00\.000Z$/);
  assert.equal(saved.value.item.kindLabel, '偏好');

  const listed = await recall(harness);
  assert.equal(listed.ok, true);
  assert.equal(listed.value.items.length, 1);
  assert.equal(listed.value.items[0].text, '我更喜欢在上午学习数学。');
  assert.equal(listed.value.items[0].source.actor, 'agent');

  const stored = harness.row('SELECT * FROM study_memory_item');
  assert.equal(stored.kind, 'preference');
  assert.equal(stored.text, '我更喜欢在上午学习数学。');
  assert.equal(stored.goal_id, 'memory-goal');
  assert.equal(stored.status, 'active');
  assert.equal(stored.source_kind, 'explicit');
  assert.equal(stored.source_actor, 'agent');
  assert.equal(stored.valid_until, null);
  assert.equal(stored.superseded_by, null);
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_memory_item'), 1);
});

test('a restarted host reads the same memory table', async t => {
  const harness = await openMemoryHarness(t);
  await remember(harness, { text: '我不喜欢在晚上背英语单词。', kind: 'preference' });
  const reopened = await restart(t, harness);
  const listed = await recall(reopened);
  assert.equal(listed.value.items.length, 1);
  assert.equal(listed.value.items[0].text, '我不喜欢在晚上背英语单词。');
});

test('an expired short-term state is hidden from recall unless explicitly included', async t => {
  const harness = await openMemoryHarness(t);
  await remember(harness, { text: '这几天在准备期中考试。', kind: 'state', ttlMs: 60_000 });
  assert.equal((await recall(harness)).value.items.length, 1);
  harness.clock.advance(61_000);
  assert.equal((await recall(harness)).value.items.length, 0);
  const included = await recall(harness, { includeExpired: true });
  assert.equal(included.value.items.length, 1);
  assert.equal(included.value.items[0].expired, true);
});

test('delete leaves a tombstone, suppresses re-saving the same text, and survives a restart', async t => {
  const harness = await openMemoryHarness(t);
  const saved = await remember(harness, { text: '我更喜欢在上午学习数学。', kind: 'preference' });
  const id = saved.value.item.id;
  const deleted = await forget(harness, { id });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.value.ids, [id]);
  assert.equal((await recall(harness)).value.items.length, 0);

  const tombstone = harness.row('SELECT * FROM study_memory_tombstone WHERE id = ?', id);
  assert.notEqual(tombstone, undefined);
  assert.equal(tombstone.goal_id, 'memory-goal');
  assert.equal(typeof tombstone.content_hash, 'string');
  assert.doesNotMatch(tombstone.source_json, /上午学习数学/);
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_memory_item'), 0);

  const rebuilt = await remember(harness, { text: '我更喜欢在上午学习数学。', kind: 'preference' });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.value.status, 'suppressed');
  assert.equal((await recall(harness)).value.items.length, 0);

  const reopened = await restart(t, harness);
  assert.equal((await recall(reopened)).value.items.length, 0);
  const items = reopened.rows('SELECT * FROM study_memory_item');
  assert.deepEqual(items, []);
  const tombstones = reopened.rows('SELECT * FROM study_memory_tombstone');
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].id, id);
});

test('only the student can revoke a tombstone and remember the same text again', async t => {
  const harness = await openMemoryHarness(t);
  await remember(harness, { text: '我习惯用康奈尔笔记法。', kind: 'preference' });
  await forget(harness, { query: '康奈尔笔记法' });

  const rejected = await remember(harness, {
    text: '我习惯用康奈尔笔记法。', kind: 'preference', revokeTombstone: true,
  }, { actor: 'agent' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid');

  const restored = await remember(harness, {
    text: '我习惯用康奈尔笔记法。', kind: 'preference', revokeTombstone: true,
  }, { actor: 'ui' });
  assert.equal(restored.ok, true);
  assert.equal(restored.value.status, 'created');
  assert.equal((await recall(harness)).value.items.length, 1);
});

test('Chinese lexical recall matches the right record and ignores unrelated ones', async t => {
  const harness = await openMemoryHarness(t);
  await remember(harness, { text: '我更喜欢在上午学习数学。', kind: 'preference' });
  await remember(harness, { text: '我不喜欢在晚上背英语单词。', kind: 'preference' });

  const math = await recall(harness, { query: '上午学数学' });
  assert.equal(math.value.items.length, 1);
  assert.match(math.value.items[0].text, /上午学习数学/);

  const english = await recall(harness, { query: '晚上背英语单词' });
  assert.equal(english.value.items.length, 1);
  assert.match(english.value.items[0].text, /背英语单词/);

  const kindQuery = await recall(harness, { query: '学习偏好' });
  assert.equal(kindQuery.value.items.length, 2);
});

test('remember by id corrects a record without changing its creation time', async t => {
  const harness = await openMemoryHarness(t);
  const saved = await remember(harness, { text: '我更喜欢在上午学习数学。', kind: 'preference' });
  const id = saved.value.item.id;
  harness.clock.advance(60_000);
  const corrected = await remember(harness, { id, text: '我更喜欢在上午学习数学和物理。' });
  assert.equal(corrected.value.status, 'updated');
  assert.equal(corrected.value.item.text, '我更喜欢在上午学习数学和物理。');
  assert.equal(corrected.value.item.createdAt, saved.value.item.createdAt);
  assert.equal(corrected.value.item.updatedAt, '2026-11-10T01:01:00.000Z');

  const listed = await recall(harness);
  assert.equal(listed.value.items.length, 1);
});

test('correcting a short-term state keeps its kind and expiry when omitted', async t => {
  const harness = await openMemoryHarness(t);
  const saved = await remember(harness, { text: '这几天在准备期中考试。', kind: 'state', ttlMs: 3_600_000 });
  harness.clock.advance(60_000);
  const corrected = await remember(harness, { id: saved.value.item.id, text: '这几天在准备数学期中考试。' });
  assert.equal(corrected.value.item.kind, 'state');
  assert.equal(corrected.value.item.expiresAt, saved.value.item.expiresAt);
  const listed = await recall(harness);
  assert.equal(listed.value.items[0].kind, 'state');
});

test('plan and completion payloads are rejected instead of copied into memory', async t => {
  const harness = await openMemoryHarness(t);
  for (const payload of [
    { text: '复习第三章', kind: 'preference', plan: { chapters: [3] } },
    { text: '今天完成 5 题', kind: 'preference', completed: 5 },
    { text: '进度 60%', kind: 'preference', progress: 60 },
    { text: '任务 t1', kind: 'preference', taskId: 't1' },
  ]) {
    const result = await remember(harness, payload);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid');
    assert.match(result.message, /不接受字段/);
  }
  assert.deepEqual(harness.rows('SELECT * FROM study_memory_item'), []);
});

test('recall rejects plan-shaped fields too', async t => {
  const harness = await openMemoryHarness(t);
  const result = await recall(harness, { plan: '第三章' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid');
});

test('the conversation snapshot includes active preferences but not expired states', async t => {
  const harness = await openMemoryHarness(t);
  await remember(harness, { text: '我更喜欢在上午学习数学。', kind: 'preference' });
  const state = await remember(harness, { text: '这几天在准备期中考试。', kind: 'state', ttlMs: 60_000 });
  const before = harness.contextText();
  assert.match(before, /偏好/);
  assert.match(before, /上午学习数学/);
  assert.match(before, /短期状态/);

  harness.database.run('UPDATE study_memory_item SET valid_until = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', state.value.item.id);
  const after = harness.contextText();
  assert.match(after, /上午学习数学/);
  assert.doesNotMatch(after, /期中考试/);
});

test('a corrupt memory file fails loudly instead of being silently reset', async t => {
  const harness = await openMemoryHarness(t, { memoryFile: '{ not json' });
  const listed = await recall(harness);
  assert.equal(listed.ok, false);
  assert.equal(listed.code, 'unavailable');
  assert.match(listed.message, /不是合法 JSON/);
  const saved = await remember(harness, { text: '随便一条', kind: 'preference' });
  assert.equal(saved.ok, false);
  assert.equal(saved.code, 'unavailable');
  assert.equal((await readFile(join(harness.directory, 'memory.json'), 'utf8')), '{ not json');
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_memory_item'), 0);
  assert.match(harness.contextText(), /学习记忆暂时无法读取/);
});

test('a structurally invalid memory file is rejected too', async t => {
  const harness = await openMemoryHarness(t, {
    memoryFile: JSON.stringify({
      version: 1,
      items: [{ id: 'not-a-memory', kind: 'unknown' }],
      tombstones: [],
    }),
  });
  const listed = await recall(harness);
  assert.equal(listed.ok, false);
  assert.equal(listed.code, 'unavailable');
  assert.match(listed.message, /无法识别的记忆条目/);
});

test('the same requestId does not duplicate a memory', async t => {
  const harness = await openMemoryHarness(t);
  const options = { actor: 'agent', requestId: 'remember-once' };
  const first = await remember(harness, { text: '我更喜欢在上午学习数学。', kind: 'preference' }, options);
  const replay = await remember(harness, { text: '我更喜欢在上午学习数学。', kind: 'preference' }, options);
  assert.deepEqual(replay, first);
  assert.equal((await recall(harness)).value.items.length, 1);
  assert.equal(harness.kernel.revision(), 1);
});

test('deleting by a keyword removes only the matching memories', async t => {
  const harness = await openMemoryHarness(t);
  await remember(harness, { text: '我更喜欢在上午学习数学。', kind: 'preference' });
  await remember(harness, { text: '我不喜欢在晚上背英语单词。', kind: 'preference' });
  const deleted = await forget(harness, { query: '英语单词' });
  assert.equal(deleted.value.deleted, 1);
  const left = await recall(harness);
  assert.equal(left.value.items.length, 1);
  assert.match(left.value.items[0].text, /数学/);
});
