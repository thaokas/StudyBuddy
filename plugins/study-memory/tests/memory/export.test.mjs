/**
 * S4 memory export: a v1-compatible snapshot generated from the SQLite tables.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryHarness } from './helpers.mjs';

test('memory.export returns the current v1 kinds and tombstones from the tables', async t => {
  const h = await openMemoryHarness(t);
  const first = await h.remember({ text: '上午先学数学', kind: 'preference' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await h.remember({ text: '这周有点累', kind: 'state' });
  assert.equal(second.ok, true, JSON.stringify(second));
  const trait = await h.profileSet('explain_detail', 4);
  assert.equal(trait.ok, true, JSON.stringify(trait));

  const snapshot = await h.ok('memory', 'export');
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.items.length, 2);
  assert.ok(snapshot.items.every(item => ['preference', 'state', 'observation'].includes(item.kind)));
  assert.ok(snapshot.items.every(item => typeof item.source.actor === 'string'));
  assert.ok(snapshot.items.some(item => item.text === '上午先学数学'));
  assert.equal(typeof snapshot.exportedAt, 'string');
  assert.equal(snapshot.tombstones.length, 0);
  assert.match(snapshot.profileMarkdown, /# 学生画像/);
  assert.equal(snapshot.profileMarkdown.split('\n').filter(line => line.startsWith('- ')).length, 6);

  const forgotten = await h.forget({ query: '上午先学数学' });
  assert.equal(forgotten.ok, true, JSON.stringify(forgotten));
  const after = await h.ok('memory', 'export');
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].text, '这周有点累');
  assert.equal(after.tombstones.length, 1);
  assert.equal(typeof after.tombstones[0].contentHash, 'string');
});
