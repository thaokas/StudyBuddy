/**
 * Shared harness for the S2 learning tests: a real SQLite file, the real
 * kernel, a fake Cordis context that records the inbox listener and the
 * `agent/inbox/claimed` event, and a fixed clock. The window tick is exposed as
 * a callable so every test drives catch-up deterministically instead of waiting
 * for the ten-minute timer.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStudyDatabase } from '../../host/db.mjs';
import { createKernel } from '../../host/kernel.mjs';
import { createRegistry } from '../../host/registry.mjs';
import * as learning from '../../host/modules/learning.mjs';
import { runWindowTick } from '../../host/learning/window.mjs';

export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;

export function fixedClock(initial) {
  let current = new Date(initial.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); },
  };
}

/**
 * Open the learning module over a fresh database and expose the capture/query
 * helpers the tests need.
 * @param {import('node:test').TestContext} t - Test context for the after hook.
 * @param {{ initial: Date }} options - Start instant.
 * @returns {Promise<object>} Harness.
 */
export async function openLearningHarness(t, { initial }) {
  const directory = await mkdtemp(join(tmpdir(), 'study-learning-s2-'));
  const clock = fixedClock(initial);
  const database = await openStudyDatabase({ file: join(directory, 'study.db'), now: clock.now });
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
    throw new Error('learning calls did not settle');
  };

  const harness = {
    directory,
    database,
    kernel,
    clock,
    tools,
    rows: (sql, ...params) => database.all(sql, ...params),
    row: (sql, ...params) => database.get(sql, ...params),
    count: (sql, ...params) => Number(database.get(sql, ...params).count),
    link({ sessionId, taskId, subject = null }) {
      database.run('INSERT OR REPLACE INTO study_task (id, subject, material_ref) VALUES (?, ?, NULL)', taskId, subject);
      database.run('INSERT OR REPLACE INTO study_tutoring_link (session_id, task_id) VALUES (?, ?)', sessionId, taskId);
    },
    emit({ sessionId, messageId, text, kind = 'user', blocks = [] }) {
      const id = messageId ?? `msg-${++messageSeq}`;
      const subscribers = listeners.get('agent/inbox/claimed') ?? [];
      assert.equal(subscribers.length, 1, 'learning should subscribe to agent/inbox/claimed once');
      for (const listener of subscribers) {
        listener({
          agent: { id: sessionId },
          message: { id, source: { kind }, content: [{ type: 'text', text }, ...blocks] },
        });
      }
      return id;
    },
    async emitAndSettle(options) {
      const id = harness.emit(options);
      await settle();
      return id;
    },
    settle,
    call: (method, payload) => kernel.call('learning', method, payload, { actor: 'ui' }),
    write: (method, payload, requestId = `test:${++requestSeq}`) => kernel.call('learning', method, payload, { actor: 'ui', requestId }),
    async callOk(method, payload) {
      const result = await harness.call(method, payload);
      assert.equal(result.ok, true, `learning.${method} should succeed: ${JSON.stringify(result)}`);
      return result.value;
    },
    async writeOk(method, payload, requestId) {
      const result = await harness.write(method, payload, requestId);
      assert.equal(result.ok, true, `learning.${method} should succeed: ${JSON.stringify(result)}`);
      return result.value;
    },
    async tick() {
      const result = await runWindowTick(
        database,
        (ns, method, payload, options) => kernel.call(ns, method, payload, options),
        clock.now,
      );
      await settle();
      return result;
    },
  };
  return harness;
}
