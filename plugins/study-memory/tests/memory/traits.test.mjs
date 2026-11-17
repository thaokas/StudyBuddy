/**
 * Teaching-parameter traits: Beta evidence, auto-effect thresholds, the weekly
 * one-step limit, sensitive cold start, eight-week decay, user correction, and
 * the compiled tutoring contract.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DAY,
  openMemoryHarness,
  seedReaskBurst,
} from './helpers.mjs';
import {
  ACTIVE_CONFIDENCE,
  decideTrait,
  gateConfidence,
  traitSpec,
  valueOfLevel,
  levelOf,
} from '../../host/memory/traits.mjs';

const NOW = new Date('2026-01-21T09:00:00.000Z');

function burstStart(now, days = 20) {
  return new Date(now.getTime() - days * DAY);
}

test('five re-asks over three units and fourteen days raise explain_detail one level', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  seedReaskBurst(harness, { count: 6, start: burstStart(NOW), stepMs: 4 * DAY, prefix: 'first' });
  const refreshed = await harness.writeOk('memory', 'refreshTraits', {}, 'traits:first');
  assert.deepEqual(refreshed.changed.map(entry => [entry.key, entry.to]), [['explain_detail', 4]]);

  const profile = await harness.ok('memory', 'profileGet');
  const detail = profile.traits.find(trait => trait.key === 'explain_detail');
  assert.equal(detail.level, 4);
  assert.equal(detail.defaultLevel, 3);
  assert.equal(detail.sourceKind, 'inferred');
  assert.equal(detail.active, true);
  assert.ok(detail.confidence >= ACTIVE_CONFIDENCE);
  assert.ok(detail.evidenceCount >= 5);
  assert.match(detail.text, /补前置|详细/);

  const evidence = harness.rows('SELECT * FROM study_memory_evidence ORDER BY ref_id');
  assert.equal(evidence.length, 5);
  assert.ok(evidence.every(row => row.ref_kind === 'problem' && row.weight > 0));
  const version = harness.row("SELECT * FROM study_memory_item WHERE kind = 'trait' AND key = 'explain_detail'");
  assert.equal(version.status, 'active');
  assert.equal(version.source_kind, 'inferred');
  assert.equal(version.superseded_by, null);
  assert.equal(JSON.parse(version.value_json).level, 4);

  assert.match(harness.contextText(), /【讲解契约】/);
  assert.match(harness.contextText(), /详细度 4\/5/);
});

test('five more re-asks a week later raise the second level, but not within seven days', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  seedReaskBurst(harness, { count: 6, start: burstStart(NOW), stepMs: 4 * DAY, prefix: 'first' });
  await harness.writeOk('memory', 'refreshTraits', {}, 'traits:first');
  assert.equal((await harness.ok('memory', 'profileGet')).traits.find(trait => trait.key === 'explain_detail').level, 4);

  // Two days later the evidence pushes the desired level up, but the weekly
  // step guard keeps the stored level.
  harness.clock.advance(2 * DAY);
  seedReaskBurst(harness, { count: 6, start: burstStart(harness.clock.now(), 2), stepMs: 0, prefix: 'early' });
  const early = await harness.writeOk('memory', 'refreshTraits', {}, 'traits:early');
  assert.deepEqual(early.changed, []);
  assert.equal((await harness.ok('memory', 'profileGet')).traits.find(trait => trait.key === 'explain_detail').level, 4);

  // Six more days (eight since the first change) allow one more step.
  harness.clock.advance(6 * DAY);
  seedReaskBurst(harness, { count: 6, start: burstStart(harness.clock.now(), 12), stepMs: 3 * DAY, prefix: 'second' });
  const second = await harness.writeOk('memory', 'refreshTraits', {}, 'traits:second');
  assert.deepEqual(second.changed.map(entry => [entry.key, entry.to]), [['explain_detail', 5]]);
  assert.equal((await harness.ok('memory', 'profileGet')).traits.find(trait => trait.key === 'explain_detail').level, 5);
});

test('sensitive traits wait for three independent units over fourteen days', async t => {
  const spec = traitSpec('explain_detail');
  const base = {
    value: 0.86,
    confidence: 0.87,
    totalWeight: 5,
    units: 5,
    spanDays: 16,
    latestAt: NOW.toISOString(),
    evidence: [],
  };
  const cold = decideTrait({ spec, stats: { ...base, units: 2 }, current: undefined, now: NOW });
  assert.equal(cold.active, false);
  assert.equal(cold.reason, 'cold_start');
  assert.equal(cold.level, 3);

  const short = decideTrait({ spec, stats: { ...base, spanDays: 10 }, current: undefined, now: NOW });
  assert.equal(short.active, false);
  assert.equal(short.reason, 'cold_start');

  const ready = decideTrait({ spec, stats: base, current: undefined, now: NOW });
  assert.equal(ready.active, true);
  assert.equal(ready.level, 4);
});

test('the confidence gate separates 0.69 from 0.71 and only orders soft traits', () => {
  const detail = traitSpec('explain_detail');
  assert.equal(gateConfidence(detail, 0.69).allowed, false);
  assert.equal(gateConfidence(detail, 0.71).allowed, true);
  assert.equal(gateConfidence(traitSpec('example_first'), 0.6).allowed, true);
  assert.equal(gateConfidence(traitSpec('step_granularity'), 0.55).allowed, true);
  assert.equal(gateConfidence(traitSpec('pace'), 0.6).allowed, false);

  const stats = {
    value: 0.9,
    confidence: 0.69,
    totalWeight: 4,
    units: 4,
    spanDays: 30,
    latestAt: NOW.toISOString(),
    evidence: [],
  };
  const blocked = decideTrait({ spec: detail, stats, current: undefined, now: NOW });
  assert.equal(blocked.active, false);
  assert.equal(blocked.level, 3);
  const allowed = decideTrait({ spec: detail, stats: { ...stats, confidence: 0.71 }, current: undefined, now: NOW });
  assert.equal(allowed.active, true);
  assert.equal(allowed.level, 5);
});

test('level and value mappings round-trip on each trait grid', () => {
  for (const key of ['explain_detail', 'hint_preference', 'pace', 'example_first', 'step_granularity', 'check_frequency']) {
    const spec = traitSpec(key);
    for (let level = spec.min; level <= spec.max + 1e-9; level += spec.step) {
      assert.equal(levelOf(spec, valueOfLevel(spec, level)), Number(level.toFixed(6)));
    }
  }
});

test('eight weeks without new evidence fall back to the default in place', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  seedReaskBurst(harness, { count: 6, start: burstStart(NOW), stepMs: 4 * DAY, prefix: 'first' });
  await harness.writeOk('memory', 'refreshTraits', {}, 'traits:first');
  assert.equal((await harness.ok('memory', 'profileGet')).traits.find(trait => trait.key === 'explain_detail').level, 4);

  harness.clock.advance(57 * DAY);
  const decayed = await harness.writeOk('memory', 'refreshTraits', {}, 'traits:decay');
  assert.deepEqual(decayed.changed.map(entry => [entry.key, entry.to, entry.reason]), [['explain_detail', 3, 'decay']]);
  const profile = await harness.ok('memory', 'profileGet');
  const detail = profile.traits.find(trait => trait.key === 'explain_detail');
  assert.equal(detail.level, 3);
  assert.equal(detail.active, false);
  const decayedItem = harness.row("SELECT * FROM study_memory_item WHERE kind = 'trait' AND key = 'explain_detail' ORDER BY rowid DESC LIMIT 1");
  assert.equal(decayedItem.status, 'active');
  assert.equal(decayedItem.superseded_by, null);
  assert.equal(JSON.parse(decayedItem.value_json).level, 3);
  const log = harness.row("SELECT * FROM change_log WHERE action = 'trait.decay' ORDER BY id DESC LIMIT 1");
  assert.notEqual(log, undefined);
});

test('merging the evidence units falls back to the default level', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  seedReaskBurst(harness, { count: 6, start: burstStart(NOW), stepMs: 4 * DAY, prefix: 'first' });
  await harness.writeOk('memory', 'refreshTraits', {}, 'traits:first');
  assert.equal((await harness.ok('memory', 'profileGet')).traits.find(trait => trait.key === 'explain_detail').level, 4);

  harness.database.run("UPDATE study_episode SET status = 'merged' WHERE id LIKE 'first-ep-%'");
  await harness.writeOk('memory', 'refreshTraits', {}, 'traits:merged');
  const profile = await harness.ok('memory', 'profileGet');
  const detail = profile.traits.find(trait => trait.key === 'explain_detail');
  assert.equal(detail.level, 3);
  assert.equal(detail.active, false);
});

test('a user correction takes effect immediately and supersedes the inferred version', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  await harness.remember({ text: '我更喜欢在上午学习数学。', kind: 'preference' }, { requestId: 'pref-1', actor: 'ui' });
  seedReaskBurst(harness, { count: 6, start: burstStart(NOW), stepMs: 4 * DAY, prefix: 'first' });
  await harness.writeOk('memory', 'refreshTraits', {}, 'traits:first');
  assert.match(harness.contextText(), /详细度 4\/5/);

  const corrected = await harness.writeOk('memory', 'profileSet', { key: 'explain_detail', level: 3 }, 'correct-1');
  assert.equal(corrected.trait.level, 3);
  assert.equal(corrected.trait.sourceKind, 'user_edit');
  assert.equal(corrected.trait.confidence, 1);

  const rows = harness.rows("SELECT * FROM study_memory_item WHERE kind = 'trait' AND key = 'explain_detail' ORDER BY rowid ASC");
  const inferred = rows[0];
  const manual = rows.at(-1);
  assert.equal(inferred.superseded_by, manual.id);
  assert.equal(manual.source_kind, 'user_edit');
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_memory_item WHERE kind = \'trait\''), 2);

  const snapshot = harness.contextText();
  assert.doesNotMatch(snapshot, /详细度/);
  assert.match(snapshot, /学习记忆/);
  assert.match(snapshot, /上午学习数学/);
});

test('a correction is held until three new units over fourteen days arrive', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  seedReaskBurst(harness, { count: 6, start: burstStart(NOW), stepMs: 4 * DAY, prefix: 'first' });
  await harness.writeOk('memory', 'refreshTraits', {}, 'traits:first');
  await harness.writeOk('memory', 'profileSet', { key: 'explain_detail', level: 3 }, 'correct-1');

  // Five re-asks after the correction, but only two independent units.
  harness.clock.advance(20 * DAY);
  const second = seedReaskBurst(harness, { count: 6, start: burstStart(harness.clock.now(), 20), stepMs: 4 * DAY, prefix: 'after' });
  harness.database.run("UPDATE study_episode SET status = 'merged' WHERE id LIKE 'after-ep-%' AND id NOT IN (?, ?)", second[0].episodeId, second[1].episodeId);
  await harness.writeOk('memory', 'refreshTraits', {}, 'traits:still-manual');
  assert.equal((await harness.ok('memory', 'profileGet')).traits.find(trait => trait.key === 'explain_detail').level, 3);
  assert.equal((await harness.ok('memory', 'profileGet')).traits.find(trait => trait.key === 'explain_detail').sourceKind, 'user_edit');

  // Three units over fourteen days replace the manual value.
  harness.database.run("UPDATE study_episode SET status = 'closed' WHERE id LIKE 'after-ep-%'");
  await harness.writeOk('memory', 'refreshTraits', {}, 'traits:replaced');
  const profile = await harness.ok('memory', 'profileGet');
  const detail = profile.traits.find(trait => trait.key === 'explain_detail');
  assert.equal(detail.level, 4);
  assert.equal(detail.sourceKind, 'inferred');
});

test('profileExplain exposes evidence ids and times but the contract never does', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  await harness.remember({ text: '我更喜欢在上午学习数学。', kind: 'preference' }, { requestId: 'pref-1', actor: 'ui' });
  seedReaskBurst(harness, { count: 6, start: burstStart(NOW), stepMs: 4 * DAY, prefix: 'first' });
  await harness.writeOk('memory', 'refreshTraits', {}, 'traits:first');

  const explained = await harness.profileExplain('explain_detail');
  assert.equal(explained.ok, true);
  assert.equal(explained.value.evidence.length, 5);
  assert.ok(explained.value.evidence.every(entry => entry.refKind === 'problem' && entry.refId.length > 0 && entry.at.length > 0));
  assert.ok(explained.value.computed.confidence >= ACTIVE_CONFIDENCE);
  assert.equal(explained.value.decision.level, 4);

  const contract = harness.contextText();
  assert.match(contract, /【讲解契约】/);
  assert.match(contract, /【相关记忆】/);
  assert.match(contract, /上午学习数学/);
  assert.doesNotMatch(contract, /first-prob/);
  assert.doesNotMatch(contract, /置信度|依据|证据|confidence/);
  assert.ok(contract.length <= 600, '契约应保持在 token 预算内：' + contract.length);
});

test('a manual hint preference appears in the contract and disappears at the default', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  await harness.writeOk('memory', 'profileSet', { key: 'hint_preference', level: 0 }, 'hint-1');
  assert.match(harness.contextText(), /解题先给下一步提示/);

  await harness.writeOk('memory', 'profileSet', { key: 'hint_preference', level: 0.5 }, 'hint-2');
  assert.doesNotMatch(harness.contextText(), /解题/);
  assert.equal(harness.contextText(), '');
});

test('a learning change event triggers one refresh pass', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  seedReaskBurst(harness, { count: 6, start: burstStart(NOW), stepMs: 4 * DAY, prefix: 'first' });
  assert.equal(harness.count("SELECT COUNT(*) AS count FROM study_memory_item WHERE kind = 'trait'"), 0);
  harness.emit('study/learning/changed', { kind: 'capture', episodeId: 'first-ep-5' });
  await harness.settle();
  assert.equal(harness.count("SELECT COUNT(*) AS count FROM study_memory_item WHERE kind = 'trait' AND key = 'explain_detail'"), 1);
  assert.equal((await harness.ok('memory', 'profileGet')).traits.find(trait => trait.key === 'explain_detail').level, 4);
});

test('profileSet rejects unknown traits and off-grid levels', async t => {
  const harness = await openMemoryHarness(t, { initial: NOW, withLearning: true });
  const unknown = await harness.profileSet('unknown', 1);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'invalid');
  const offGrid = await harness.profileSet('explain_detail', 2.5);
  assert.equal(offGrid.ok, false);
  assert.equal(offGrid.code, 'invalid');
  const outOfRange = await harness.profileSet('pace', 2);
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.code, 'invalid');
});
