/**
 * Shared harness for the S3 memory tests: a real SQLite file, the real kernel,
 * the memory module (and optionally learning), a fake Cordis context with an
 * event bus and recorded system-prompt contexts, and a fixed clock.
 *
 * Learning rows are inserted directly where a test only needs evidence; the
 * capture path is exercised only when a test asks for it.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStudyDatabase } from '../../../study-core/host/db.mjs';
import { createKernel } from '../../../study-core/host/kernel.mjs';
import { createRegistry } from '../../../study-core/host/registry.mjs';
import * as memory from '../../host/modules/memory.mjs';
import * as learning from '../../../study-learning/host/modules/learning.mjs';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Printable clock with an explicit advance step.
 * @param {Date} initial - Start instant.
 * @returns {{ now: () => Date, advance: (milliseconds: number) => void, set: (date: Date) => void }} Clock.
 */
export function fixedClock(initial = new Date(2026, 10, 10, 9, 0, 0)) {
  let current = new Date(initial.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); },
    set(date) { current = new Date(date.getTime()); },
  };
}

/**
 * Open the memory module (and optionally learning) over a fresh database.
 * @param {import('node:test').TestContext} t - Test context for teardown.
 * @param {{ initial?: Date, memoryFile?: object, withLearning?: boolean, directory?: string, beforeApply?: (database: object) => void }} [options] - Fixture options.
 * @returns {Promise<object>} Harness.
 */
export async function openMemoryHarness(t, { initial, memoryFile, withLearning = false, directory: existing, beforeApply } = {}) {
  const directory = existing ?? await mkdtemp(join(tmpdir(), 'study-memory-s3-'));
  const clock = fixedClock(initial);
  if (memoryFile !== undefined) {
    await writeFile(join(directory, 'memory.json'), typeof memoryFile === 'string' ? memoryFile : JSON.stringify(memoryFile, null, 2));
  }
  const database = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
  database.exec("CREATE TABLE IF NOT EXISTS study_goal (id TEXT PRIMARY KEY, active INTEGER) STRICT");
  database.run("INSERT OR IGNORE INTO study_goal (id, active) VALUES ('memory-goal', 1)");

  const definitions = [];
  if (withLearning) {
    database.exec("CREATE TABLE IF NOT EXISTS study_task (id TEXT PRIMARY KEY, subject TEXT, material_ref TEXT) STRICT");
    database.exec("CREATE TABLE IF NOT EXISTS study_tutoring_link (session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL) STRICT");
    definitions.push({ id: learning.id, deps: learning.deps, schema: learning.schema, schemaVersion: learning.schemaVersion });
  }
  definitions.push({ id: memory.id, deps: memory.deps, schema: memory.schema, schemaVersion: memory.schemaVersion });
  database.verifyModules(definitions);
  await database.applyModuleSchemas(definitions);
  beforeApply?.(database);
  const kernel = createKernel({ database, registry: createRegistry(), modules: definitions, now: clock.now });

  const pending = new Set();
  const listeners = new Map();
  const tools = {};
  const contexts = [];
  const services = {
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
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    tools: {
      register(definition) {
        tools[definition.name] = definition;
        return () => { delete tools[definition.name]; };
      },
    },
    effect: work => work(),
    inject: (_deps, callback) => callback({
      effect: work => work(),
      systemPrompt: { context: section => { contexts.push(section); return () => {}; } },
    }),
  };

  if (withLearning) learning.apply(services, kernel);
  await memory.apply(services, kernel);
  t.after(async () => {
    await kernel.close().catch(() => {});
    if (existing === undefined) {
      // The reopened harness may still hold WAL files when hooks run in
      // registration order; a leaked temp directory is better than a hung test.
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  const settle = async (rounds = 12) => {
    for (let round = 0; round < rounds; round += 1) {
      await new Promise(resolve => setImmediate(resolve));
      if (pending.size > 0) await Promise.all([...pending].map(promise => promise.catch(() => {})));
    }
  };

  let seq = 0;
  const harness = {
    directory,
    database,
    kernel,
    clock,
    tools,
    contexts,
    listeners,
    settle,
    rows: (sql, ...params) => database.all(sql, ...params),
    row: (sql, ...params) => database.get(sql, ...params),
    count: (sql, ...params) => Number(database.get(sql, ...params).count),
    call: (ns, method, payload = {}, options = { actor: 'ui' }) => kernel.call(ns, method, payload, options),
    write: (ns, method, payload = {}, requestId = 'test:' + (++seq)) => kernel.call(ns, method, payload, { actor: 'ui', requestId }),
    async ok(ns, method, payload = {}, options) {
      const result = options === undefined ? await harness.call(ns, method, payload) : await kernel.call(ns, method, payload, options);
      assert.equal(result.ok, true, ns + '.' + method + ' should succeed: ' + JSON.stringify(result));
      return result.value;
    },
    async writeOk(ns, method, payload = {}, requestId) {
      const result = await harness.write(ns, method, payload, requestId);
      assert.equal(result.ok, true, ns + '.' + method + ' should succeed: ' + JSON.stringify(result));
      return result.value;
    },
    remember(payload, options = { actor: 'ui', requestId: 'remember:' + (++seq) }) {
      return kernel.call('memory', 'remember', payload, options);
    },
    recall(payload = {}, options = { actor: 'ui' }) {
      return kernel.call('memory', 'recall', payload, options);
    },
    forget(payload, options = { actor: 'ui', requestId: 'forget:' + (++seq) }) {
      return kernel.call('memory', 'forget', payload, options);
    },
    profileGet() {
      return kernel.call('memory', 'profileGet', {}, { actor: 'ui' });
    },
    profileExplain(key) {
      return kernel.call('memory', 'profileExplain', { key }, { actor: 'ui' });
    },
    profileSet(key, level, options = { actor: 'ui', requestId: 'set:' + (++seq) }) {
      return kernel.call('memory', 'profileSet', { key, level }, options);
    },
    refreshTraits(requestId = 'refresh:' + (++seq)) {
      return kernel.call('memory', 'refreshTraits', {}, { actor: 'system', requestId });
    },
    contextText() {
      const section = contexts.find(item => item.name === 'study:memory');
      assert.notEqual(section, undefined, 'the memory context should be registered');
      return section.text({});
    },
    emit(event, payload) { services.emit(event, payload); },
    emitInbox({ sessionId, messageId, text, kind = 'user' }) {
      const id = messageId ?? 'msg-' + (++seq);
      for (const listener of listeners.get('agent/inbox/claimed') ?? []) {
        listener({ agent: { id: sessionId }, message: { id, source: { kind }, content: [{ type: 'text', text }] } });
      }
      return id;
    },
    insertEpisode(episode) {
      const base = {
        goalId: 'memory-goal',
        sessionId: 'session-1',
        subject: null,
        openedAt: '2026-11-10T01:00:00.000Z',
        closedAt: null,
        status: 'closed',
        problemCount: 1,
        resolution: null,
      };
      const row = { ...base, ...episode };
      database.run(
        `INSERT INTO study_episode
          (id, goal_id, session_id, subject, opened_at, closed_at, status, problem_count, stuck_json, method_json,
           resolution, confidence, summary, boundary_source, continuation_of, merged_into, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 'rule', NULL, NULL, ?, ?)`,
        row.id, row.goalId, row.sessionId, row.subject, row.openedAt, row.closedAt, row.status, row.problemCount,
        row.resolution, row.openedAt, row.closedAt ?? row.openedAt,
      );
      return row;
    },
    insertProblem(problem) {
      const row = {
        episodeId: 'ep-1',
        position: 0,
        text: '题目',
        createdAt: '2026-11-10T01:00:00.000Z',
        reaskedFrom: null,
        reaskCount: 0,
        ...problem,
      };
      database.run(
        `INSERT INTO study_episode_problem
          (id, episode_id, position, text, norm, hash, sketch, status, resolution, reasked_from, reask_count, created_at)
         VALUES (?, ?, ?, ?, '', 'hash-' || ?, '', 'open', NULL, ?, ?, ?)`,
        row.id, row.episodeId, row.position, row.text, row.id, row.reaskedFrom, row.reaskCount, row.createdAt,
      );
      return row;
    },
    insertSignal(signal) {
      const row = { episodeId: 'ep-1', problemId: null, turnId: null, kind: 'confused', at: '2026-11-10T01:00:00.000Z', source: 'rule', ...signal };
      database.run(
        'INSERT INTO study_signal (id, episode_id, problem_id, turn_id, kind, at, value_json, source) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
        'sig-' + (++seq), row.episodeId, row.problemId, row.turnId, row.kind, row.at, row.source,
      );
      return row;
    },
  };
  return harness;
}

/**
 * A re-ask burst: one original problem and n newer re-asked problems in their
 * own units, each after the given gap.
 * @param {object} harness - Test harness.
 * @param {{
 *   count: number,
 *   start: Date,
 *   stepMs: number,
 *   goalId?: string,
 *   withClosures?: boolean,
 *   sessionId?: string,
 * }} options - Burst geometry.
 * @returns {Array<{ episodeId: string, at: string }>} Evidence instants.
 */
export function seedReaskBurst(harness, { count, start, stepMs, goalId = 'memory-goal', sessionId = 'session-1', prefix = 'burst' }) {
  const events = [];
  let previous = null;
  for (let index = 0; index < count; index += 1) {
    const at = new Date(start.getTime() + index * stepMs);
    const iso = at.toISOString();
    const episodeId = prefix + '-ep-' + index;
    harness.insertEpisode({
      id: episodeId,
      goalId,
      sessionId,
      openedAt: iso,
      closedAt: new Date(at.getTime() + 10 * MINUTE).toISOString(),
      resolution: 'unresolved',
    });
    const problemId = prefix + '-prob-' + index;
    harness.insertProblem({
      id: problemId,
      episodeId,
      createdAt: iso,
      text: '同一类题 ' + prefix + ' ' + index,
      reaskedFrom: previous,
      reaskCount: 0,
    });
    if (previous !== null) {
      harness.database.run('UPDATE study_episode_problem SET reask_count = reask_count + 1 WHERE id = ?', previous);
    }
    events.push({ episodeId, problemId, at: iso });
    previous = problemId;
  }
  return events;
}
