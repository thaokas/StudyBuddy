/**
 * Shared harness for the S4 analysis / review tests: a real SQLite file, the
 * real kernel, learning and review modules, the memory tables (empty, so traits
 * fall back to defaults), a fixed clock, and deterministic seed helpers.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStudyDatabase } from '../../host/db.mjs';
import { createKernel } from '../../host/kernel.mjs';
import { createRegistry } from '../../host/registry.mjs';
import * as learning from '../../host/modules/learning.mjs';
import * as review from '../../host/modules/review.mjs';
import { SCHEMA as MEMORY_SCHEMA } from '../../host/memory/store.mjs';

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function fixedClock(initial) {
  let current = new Date(initial.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); },
    set(value) { current = value instanceof Date ? new Date(value.getTime()) : new Date(value); },
  };
}

/**
 * Boot learning + review over a temporary database.
 * @param {import('node:test').TestContext} t - Test context for teardown.
 * @param {{ initial?: Date }} [options] - Start instant.
 * @returns {Promise<object>} Harness.
 */
export async function openS4Harness(t, { initial = new Date(2026, 10, 11, 10, 0, 0) } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'study-s4-'));
  const clock = fixedClock(initial);
  const database = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
  database.exec(`
    CREATE TABLE IF NOT EXISTS study_goal (id TEXT PRIMARY KEY, active INTEGER) STRICT;
    INSERT OR IGNORE INTO study_goal (id, active) VALUES ('goal-1', 1);
    CREATE TABLE IF NOT EXISTS study_task (id TEXT PRIMARY KEY, subject TEXT, material_ref TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS study_tutoring_link (session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL) STRICT;
  `);
  database.exec(MEMORY_SCHEMA.join(';\n'));

  const definitions = [
    {
      id: learning.id,
      deps: learning.deps,
      schema: learning.schema,
      schemaVersion: learning.schemaVersion,
      apply: learning.apply,
    },
    {
      id: review.id,
      deps: review.deps,
      schema: review.schema,
      schemaVersion: review.schemaVersion,
      apply: review.apply,
    },
  ];
  const verification = database.verifyModules(definitions);
  assert.equal(verification.blocked, null, `module schemas should verify: ${JSON.stringify(verification.blocked)}`);
  await database.applyModuleSchemas(definitions);

  const registry = createRegistry();
  const kernel = createKernel({ database, registry, modules: definitions, now: clock.now });
  const listeners = new Map();
  const tools = {};
  let requestSeq = 0;
  const ctx = {
    study: {
      register: (ns, impl) => registry.register(ns, impl),
      call: (...args) => kernel.call(...args),
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
      register(tool) {
        tools[tool.name] = tool;
        return () => { delete tools[tool.name]; };
      },
    },
    effect: work => work(),
  };
  for (const definition of definitions) await definition.apply(ctx, kernel);
  if (!registry.has('memory')) {
    registry.register('memory', {
      methods: {
        profileGet: () => ({
          goalId: 'goal-1',
          traits: [{ key: 'explain_detail', text: '默认详细度', level: 3, max: 5, active: false }],
        }),
      },
    });
  }
  await kernel.ensureDaySnapshot();
  t.after(async () => {
    await kernel.close().catch(() => {});
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort on Windows WAL */ }
  });

  const iso = value => (value instanceof Date ? value : new Date(value)).toISOString();

  const harness = {
    directory,
    database,
    kernel,
    registry,
    clock,
    tools,
    iso,
    rows: (sql, ...params) => database.all(sql, ...params),
    row: (sql, ...params) => database.get(sql, ...params),
    count: (sql, ...params) => Number(database.get(sql, ...params).count),
    async call(namespace, method, payload = {}) {
      return kernel.call(namespace, method, payload, { actor: 'ui' });
    },
    async callOk(namespace, method, payload = {}) {
      const result = await harness.call(namespace, method, payload);
      assert.equal(result.ok, true, `${namespace}.${method} should succeed: ${JSON.stringify(result)}`);
      return result.value;
    },
    async write(namespace, method, payload = {}, requestId = `test:${++requestSeq}`) {
      return kernel.call(namespace, method, payload, { actor: 'ui', requestId });
    },
    async writeOk(namespace, method, payload = {}, requestId) {
      const result = await harness.write(namespace, method, payload, requestId);
      assert.equal(result.ok, true, `${namespace}.${method} should succeed: ${JSON.stringify(result)}`);
      return result.value;
    },
    /**
     * Insert one closed unit.
     * @param {{ id: string, openedAt: string, subject?: string|null, resolution?: string|null, status?: string }} options
     *   Unit fields.
     * @returns {object} Unit.
     */
    seedEpisode({ id, openedAt, subject = '数学', resolution = null, status = 'closed' }) {
      database.run(
        `INSERT OR REPLACE INTO study_episode
          (id, goal_id, session_id, subject, opened_at, closed_at, status, problem_count, stuck_json, method_json,
           resolution, confidence, summary, boundary_source, continuation_of, merged_into, created_at, updated_at)
         VALUES (?, 'goal-1', 'session-1', ?, ?, ?, ?, 0, NULL, NULL, ?, NULL, NULL, 'rule', NULL, NULL, ?, ?)`,
        id,
        subject,
        openedAt,
        status === 'open' ? null : openedAt,
        status,
        resolution,
        openedAt,
        openedAt,
      );
      return { id, openedAt, subject, resolution, status };
    },
    /**
     * Insert one problem. `text` defaults to a readable placeholder.
     * @param {{ id: string, episodeId: string, sketch: string, createdAt: string, reaskedFrom?: string|null, reaskCount?: number, status?: string, text?: string|null }} options
     *   Problem fields.
     * @returns {object} Problem.
     */
    seedProblem({ id, episodeId, sketch, createdAt, reaskedFrom = null, reaskCount = 0, status = 'open', text = null }) {
      database.run(
        `INSERT OR REPLACE INTO study_episode_problem
          (id, episode_id, position, text, norm, hash, sketch, status, resolution, reasked_from, reask_count, created_at)
         VALUES (?, ?, 0, ?, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
        id,
        episodeId,
        text ?? `题目 ${id}`,
        `hash-${id}`,
        sketch,
        status,
        reaskedFrom,
        reaskCount,
        createdAt,
      );
      database.run(
        'UPDATE study_episode SET problem_count = (SELECT COUNT(*) FROM study_episode_problem WHERE episode_id = ?) WHERE id = ?',
        episodeId,
        episodeId,
      );
      return { id, episodeId, sketch, createdAt, reaskedFrom, reaskCount, status };
    },
    /** Insert one topic row with its subject metadata. */
    seedTopic({ id, name, subject = '数学', createdAt = clock.now().toISOString() }) {
      database.run(
        `INSERT OR REPLACE INTO study_topic (id, goal_id, name, aliases_json, parent_id, material_ref, created_at)
         VALUES (?, 'goal-1', ?, ?, NULL, NULL, ?)`,
        id,
        name,
        JSON.stringify({ subject }),
        createdAt,
      );
      return { id, name, subject };
    },
    /** Link one unit to one topic. */
    seedLink(episodeId, topicId, confidence = 1) {
      database.run(
        `INSERT OR REPLACE INTO study_episode_topic (episode_id, topic_id, confidence, source)
         VALUES (?, ?, ?, 'rule')`,
        episodeId,
        topicId,
        confidence,
      );
    },
    /** Insert one learning turn and link it to a unit. */
    seedTurn({ id, episodeId, at, text, position = 0 }) {
      database.run(
        `INSERT OR REPLACE INTO study_turn
          (id, goal_id, session_id, message_id, turn_no, at, intent, is_learning, subject, text, text_hash,
           text_pruned_at, attachments_json, task_id, material_ref, episode_id, classified_by, classifier_version, created_at)
         VALUES (?, 'goal-1', 'session-1', ?, NULL, ?, 'question', 1, '数学', ?, ?, NULL, NULL, NULL, NULL, ?, 'rule', 'rule-v1', ?)`,
        id,
        `msg-${id}`,
        at,
        text,
        `hash-${id}`,
        episodeId,
        at,
      );
      database.run(
        'INSERT OR REPLACE INTO study_episode_turn (episode_id, turn_id, position, role, ambiguous) VALUES (?, ?, ?, ?, 0)',
        episodeId,
        id,
        position,
        position === 0 ? 'ask' : 'clarify',
      );
      return { id, episodeId, at, text };
    },
  };
  return harness;
}
