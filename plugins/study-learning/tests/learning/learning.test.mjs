import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStudyDatabase } from '../../../study-core/host/db.mjs';
import { createKernel } from '../../../study-core/host/kernel.mjs';
import { createRegistry } from '../../../study-core/host/registry.mjs';
import * as learning from '../../host/modules/learning.mjs';

/**
 * S1 evidence-layer tests: capture through the real kernel and SQLite file, with
 * a fake Cordis context that records the inbox listener and the tools instead of
 * booting DSH. The fake `ctx.study.call` tracks capture promises so a test can
 * wait for the fire-and-forget listener before asserting.
 */

function fixedClock(initial = new Date(2026, 10, 11, 9, 0, 0)) {
  let current = initial;
  return {
    now: () => new Date(current.getTime()),
    advance: milliseconds => { current = new Date(current.getTime() + milliseconds); },
  };
}

const MINUTE = 60 * 1000;

async function openLearning(t, { initial } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'study-learning-'));
  const clock = fixedClock(initial);
  const database = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
  // The module reads the goal and the tutoring link; the real modules own these
  // tables, so the harness creates just the columns capture touches.
  database.exec(`
    CREATE TABLE IF NOT EXISTS study_goal (id TEXT PRIMARY KEY, active INTEGER) STRICT;
    INSERT OR IGNORE INTO study_goal (id, active) VALUES ('goal-1', 1);
    CREATE TABLE IF NOT EXISTS study_task (id TEXT PRIMARY KEY, subject TEXT, material_ref TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS study_tutoring_link (session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL) STRICT;
  `);
  const definition = {
    id: learning.id,
    deps: learning.deps,
    schema: learning.schema,
    schemaVersion: learning.schemaVersion,
  };
  database.verifyModules([definition]);
  await database.applyModuleSchemas([definition]);
  const kernel = createKernel({ database, registry: createRegistry(), modules: [definition], now: clock.now });
  const listeners = new Map();
  const tools = {};
  const pending = new Set();
  let messageSeq = 0;
  let requestSeq = 0;
  const ctx = {
    study: {
      register: (ns, impl) => kernel.register(ns, impl),
      call: (...args) => {
        const promise = kernel.call(...args);
        pending.add(promise);
        promise.then(() => pending.delete(promise), () => pending.delete(promise));
        return promise;
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => { listeners.set(event, list.filter(item => item !== listener)); };
    },
    tools: {
      register(tool) {
        tools[tool.name] = tool;
        return () => {};
      },
    },
    effect: work => work(),
  };
  learning.apply(ctx, kernel);
  t.after(async () => { await kernel.close().catch(() => {}); });

  const settle = async () => {
    for (let round = 0; round < 50; round += 1) {
      if (pending.size > 0) {
        await Promise.all([...pending]);
        continue;
      }
      await new Promise(resolve => setImmediate(resolve));
      if (pending.size === 0) return;
    }
    throw new Error('capture did not settle');
  };

  const harness = {
    directory,
    database,
    kernel,
    clock,
    tools,
    rows: (sql, ...params) => database.all(sql, ...params),
    count: (sql, ...params) => Number(database.get(sql, ...params).count),
    link({ sessionId, taskId, subject = null }) {
      database.run('INSERT OR REPLACE INTO study_task (id, subject, material_ref) VALUES (?, ?, NULL)', taskId, subject);
      database.run('INSERT OR REPLACE INTO study_tutoring_link (session_id, task_id) VALUES (?, ?)', sessionId, taskId);
    },
    emit({ sessionId, messageId, text, kind = 'user', blocks = [] }) {
      const id = messageId ?? `msg-${++messageSeq}`;
      const listenersForEvent = listeners.get('agent/inbox/claimed') ?? [];
      assert.equal(listenersForEvent.length, 1, 'learning should subscribe to agent/inbox/claimed once');
      for (const listener of listenersForEvent) {
        listener({
          agent: { id: sessionId },
          message: { id, source: { kind }, content: [{ type: 'text', text }, ...blocks] },
        });
      }
      return id;
    },
    settle,
    call: (method, payload) => kernel.call('learning', method, payload, { actor: 'ui' }),
    capture: (payload, requestId = `test:${++requestSeq}`) => kernel.call('learning', 'capture', payload, { actor: 'system', requestId }),
    async ok(method, payload) {
      const result = await harness.call(method, payload);
      assert.equal(result.ok, true, `learning.${method} should succeed: ${JSON.stringify(result)}`);
      return result.value;
    },
    async emitAndSettle(options) {
      const id = harness.emit(options);
      await settle();
      return id;
    },
  };
  return harness;
}

test('an unrelated question after a subject change opens a second unit', async t => {
  const harness = await openLearning(t);
  harness.link({ sessionId: 's1', taskId: 'task-math', subject: '数学' });
  await harness.emitAndSettle({ sessionId: 's1', text: '怎么求 x^2 的导数？' });
  harness.clock.advance(MINUTE);
  harness.link({ sessionId: 's1', taskId: 'task-english', subject: '英语' });
  await harness.emitAndSettle({ sessionId: 's1', text: '再问一道，另一个问题：虚拟语气怎么用？' });

  const episodes = harness.rows('SELECT * FROM study_episode ORDER BY opened_at');
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].status, 'closed');
  assert.notEqual(episodes[0].closed_at, null);
  assert.equal(episodes[1].status, 'open');
  assert.equal(episodes[1].subject, '英语');
  assert.equal(episodes[0].problem_count, 1);
  assert.equal(episodes[1].problem_count, 1);
});

test('a same-question follow-up stays in one unit', async t => {
  const harness = await openLearning(t);
  await harness.emitAndSettle({ sessionId: 's1', text: '怎么求 x^2 的导数？' });
  harness.clock.advance(20 * 1000);
  await harness.emitAndSettle({ sessionId: 's1', text: '那这一步呢？' });

  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode'), 1);
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode_turn'), 2);
  const episode = harness.rows('SELECT * FROM study_episode')[0];
  assert.equal(episode.problem_count, 1);
  assert.equal(episode.status, 'open');
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode_turn WHERE ambiguous = 1'), 0);
});

test('the same message id is captured once even when delivered twice', async t => {
  const harness = await openLearning(t);
  const messageId = `msg-once-${Date.now()}`;
  const text = '怎么求 x^2 的导数？';
  await harness.emitAndSettle({ sessionId: 's2', messageId, text });
  await harness.emitAndSettle({ sessionId: 's2', messageId, text });

  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_turn'), 1);
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode'), 1);
  const turn = harness.rows('SELECT id FROM study_turn')[0];

  const replay = await harness.capture({ sessionId: 's2', messageId, text }, 'manual-replay');
  assert.equal(replay.ok, true);
  assert.equal(replay.value.status, 'duplicate');
  assert.equal(replay.value.turnId, turn.id);
  assert.equal(replay.value.episodeId, harness.rows('SELECT episode_id FROM study_turn')[0].episode_id);
});

test('a planning message is stored as a non-learning turn and opens no unit', async t => {
  const harness = await openLearning(t);
  await harness.emitAndSettle({ sessionId: 's3', text: '明天九点安排数学，计划做两套题' });

  const turns = harness.rows('SELECT * FROM study_turn');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].intent, 'planning');
  assert.equal(turns[0].is_learning, 0);
  assert.equal(turns[0].episode_id, null);
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode'), 0);
});

test('injected study-tutoring messages are ignored', async t => {
  const harness = await openLearning(t);
  await harness.emitAndSettle({ sessionId: 's4', text: '这是任务答疑注入的上下文', kind: 'study-tutoring' });
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_turn'), 0);
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode'), 0);
});

test('a gap longer than 30 minutes opens a new unit', async t => {
  const harness = await openLearning(t);
  await harness.emitAndSettle({ sessionId: 's5', text: '怎么解 2x + 3 = 7？' });
  harness.clock.advance(31 * MINUTE);
  await harness.emitAndSettle({ sessionId: 's5', text: '那这道题还有别的解法吗？' });

  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode'), 2);
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode_turn'), 2);
});

test('asking the same problem three days later is counted as a re-ask', async t => {
  const harness = await openLearning(t);
  const text = '求 sin(x) 的导数怎么算？';
  await harness.emitAndSettle({ sessionId: 's6', text });
  harness.clock.advance(3 * 24 * 60 * MINUTE);
  await harness.emitAndSettle({ sessionId: 's7', text });

  const problems = harness.rows('SELECT * FROM study_episode_problem ORDER BY created_at, rowid');
  assert.equal(problems.length, 2);
  assert.equal(problems[0].reask_count, 1);
  assert.equal(problems[0].status, 'reasked');
  assert.equal(problems[1].reasked_from, problems[0].id);
  assert.equal(problems[1].reask_count, 0);

  const signals = harness.rows("SELECT * FROM study_signal WHERE kind = 'reask'");
  assert.equal(signals.length, 1);
  assert.equal(signals[0].episode_id, problems[1].episode_id);
  assert.equal(signals[0].problem_id, problems[1].id);
});

test('a follow-up naming the second problem adds it to the same unit', async t => {
  const harness = await openLearning(t);
  await harness.emitAndSettle({ sessionId: 's8', text: '第一题：求 x^2 的导数，怎么算？' });
  harness.clock.advance(30 * 1000);
  await harness.emitAndSettle({ sessionId: 's8', text: '第2题：求 x^3 的导数，怎么算？' });

  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode'), 1);
  const problems = harness.rows('SELECT * FROM study_episode_problem ORDER BY position');
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map(problem => problem.episode_id), [problems[0].episode_id, problems[0].episode_id]);
  assert.deepEqual(problems.map(problem => problem.position), [0, 1]);
  assert.equal(harness.rows('SELECT * FROM study_episode')[0].problem_count, 2);
});

test('the fixture conversation follows the expected unit boundaries', async t => {
  const harness = await openLearning(t);
  harness.link({ sessionId: 'fixture', taskId: 'task-math', subject: '数学' });
  const script = [
    { text: '怎么解 2x + 3 = 7？', episode: 0 },
    { text: '那这一步为什么要减去 3？', episode: 0 },
    { text: '另一个问题：虚拟语气怎么用？', episode: 1, link: { taskId: 'task-english', subject: '英语' } },
    { text: '那这个例句呢？', episode: 1 },
    { text: '再问一道：定语从句怎么选关系词？', episode: 1 },
    { text: '怎么求自由落体的时间？', episode: 2, link: { taskId: 'task-physics', subject: '物理' } },
    { text: '为什么这里要用 g = 9.8？', episode: 2 },
    { text: '懂了，谢谢', episode: 2 },
  ];
  for (const step of script) {
    if (step.link !== undefined) harness.link({ sessionId: 'fixture', ...step.link });
    await harness.emitAndSettle({ sessionId: 'fixture', text: step.text });
    harness.clock.advance(10 * 1000);
  }

  const turns = harness.rows("SELECT rowid AS rid, episode_id, text FROM study_turn WHERE session_id = 'fixture' ORDER BY at, rowid");
  assert.equal(turns.length, script.length);
  const unitOrder = [];
  for (const turn of turns) if (!unitOrder.includes(turn.episode_id)) unitOrder.push(turn.episode_id);
  assert.equal(unitOrder.length, 3);
  assert.deepEqual(turns.map(turn => unitOrder.indexOf(turn.episode_id)), script.map(step => step.episode));

  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode'), 3);
  assert.equal(harness.count("SELECT COUNT(*) AS count FROM study_episode_turn WHERE ambiguous = 1"), 1);
  const ambiguousTurn = harness.rows(
    `SELECT t.text FROM study_episode_turn et JOIN study_turn t ON t.id = et.turn_id WHERE et.ambiguous = 1`,
  )[0];
  assert.match(ambiguousTurn.text, /再问一道/);

  const lastUnit = harness.rows('SELECT * FROM study_episode WHERE subject = ?', '物理')[0];
  assert.equal(lastUnit.resolution, 'understood');
  assert.equal(lastUnit.status, 'open');
});

test('the demo shape: two sessions, five user turns, three units, four problems', async t => {
  const harness = await openLearning(t);
  harness.link({ sessionId: 'demo-a', taskId: 'task-math', subject: '数学' });
  await harness.emitAndSettle({ sessionId: 'demo-a', text: '怎么解 2x + 3 = 7？' });
  harness.clock.advance(MINUTE);
  await harness.emitAndSettle({ sessionId: 'demo-a', text: '第2题：求 x^2 的导数怎么算？' });

  harness.link({ sessionId: 'demo-b', taskId: 'task-english', subject: '英语' });
  harness.clock.advance(MINUTE);
  await harness.emitAndSettle({ sessionId: 'demo-b', text: '虚拟语气怎么用？' });
  harness.clock.advance(MINUTE);
  harness.link({ sessionId: 'demo-b', taskId: 'task-physics', subject: '物理' });
  await harness.emitAndSettle({ sessionId: 'demo-b', text: '怎么求自由落体的时间？' });
  harness.clock.advance(MINUTE);
  await harness.emitAndSettle({ sessionId: 'demo-b', text: '那为什么这里要取 g = 9.8？' });

  const stats = await harness.ok('stats', {});
  assert.equal(stats.turns, 5);
  assert.equal(stats.learningTurns, 5);
  assert.equal(stats.episodes, 3);
  assert.equal(stats.problems, 4);
  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode_turn'), 5);
});

test('captured units are still listed after a restart', async t => {
  const harness = await openLearning(t);
  await harness.emitAndSettle({ sessionId: 'restart-1', text: '怎么求 x^2 的导数？' });
  const before = await harness.ok('list', {});
  assert.equal(before.total, 1);
  await harness.kernel.close();

  const database = await openStudyDatabase({ file: join(harness.directory, 'study.db'), now: harness.clock.now });
  const definition = {
    id: learning.id,
    deps: learning.deps,
    schema: learning.schema,
    schemaVersion: learning.schemaVersion,
  };
  database.verifyModules([definition]);
  await database.applyModuleSchemas([definition]);
  const kernel = createKernel({ database, registry: createRegistry(), modules: [definition], now: harness.clock.now });
  t.after(async () => { await kernel.close().catch(() => {}); });
  learning.apply({
    study: { register: (ns, impl) => kernel.register(ns, impl) },
    on: () => () => {},
    tools: { register: () => () => {} },
    effect: work => work(),
  }, kernel);

  const after = await kernel.call('learning', 'list', {}, { actor: 'ui' });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(after.value.total, 1);
  assert.equal(after.value.items[0].id, before.items[0].id);
  assert.equal(after.value.items[0].problems[0].text, before.items[0].problems[0].text);
});

test('study_questions lists units, returns one unit, and reports stats', async t => {
  const harness = await openLearning(t);
  await harness.emitAndSettle({ sessionId: 't1', text: '怎么求 x^2 的导数？' });
  harness.clock.advance(MINUTE);
  await harness.emitAndSettle({ sessionId: 't2', text: '虚拟语气怎么用？' });
  harness.clock.advance(MINUTE);
  await harness.emitAndSettle({ sessionId: 't3', text: '明天九点安排数学' });

  const tool = harness.tools.study_questions;
  assert.ok(tool, 'study_questions tool should be registered');
  assert.ok(harness.kernel.status().namespaces.some(entry => entry.ns === 'learning'), 'learning namespace should be visible in kernel.status');
  const exec = { signal: new AbortController().signal, callId: 'tool-1' };

  const listed = await tool.execute({ action: 'list' }, exec);
  assert.equal(listed.total, 2);
  assert.equal(listed.items.length, 2);
  assert.equal(listed.items[0].problems.length, 1);
  assert.match(tool.output.render({ action: 'list' }, listed)[0].text, /次问答/);

  const detail = await tool.execute({ action: 'get', id: listed.items[0].id }, exec);
  assert.equal(detail.episode.id, listed.items[0].id);
  assert.equal(detail.problems.length, 1);
  assert.equal(detail.turns.length, 1);
  assert.match(tool.output.render({ action: 'get' }, detail)[0].text, /道题/);

  const stats = await tool.execute({ action: 'stats' }, exec);
  assert.equal(stats.turns, 3);
  assert.equal(stats.learningTurns, 2);
  assert.equal(stats.episodes, 2);
  assert.equal(stats.problems, 2);
  assert.equal(stats.reaskRate, 0);
  assert.deepEqual(stats.bySubject, [{ subject: '未分类', episodes: 2, problems: 2 }]);
  assert.match(tool.output.render({ action: 'stats' }, stats)[0].text, /道题/);

  const searched = await harness.ok('list', { query: '导数' });
  assert.equal(searched.total, 1);
  assert.match(searched.items[0].problems[0].text, /导数/);
  const sameDay = await harness.ok('list', { from: '2026-11-11', to: '2026-11-11' });
  assert.equal(sameDay.total, 2);
  const later = await harness.ok('stats', { from: '2026-11-12' });
  assert.equal(later.episodes, 0);
  const missing = await harness.call('get', { id: 'ep_missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'not_found');
});

test('a capture failure is recorded as a gap instead of reaching the conversation', async t => {
  const harness = await openLearning(t);
  assert.doesNotThrow(() => harness.emit({ sessionId: 'gap-1', text: '查'.repeat(20_001) }));
  await harness.settle();

  assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_turn'), 0);
  const gaps = harness.rows('SELECT * FROM study_capture_gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].session_id, 'gap-1');
  assert.match(gaps[0].reason, /^invalid:/);
  assert.equal(gaps[0].resolved, 0);
});
