import { fixtureCaller } from '../../../../tests/support/write-fixture.mjs';
import { randomUUID } from 'node:crypto';
/**
 * Shared fixture for the task/schedule tests: boot the shipped plugin against
 * fake host services in a temporary data directory, or reopen an existing one
 * to prove a restart reads the same rows.
 *
 * The plugin is booted through `host/index.mjs`, so these tests also exercise
 * module discovery, schema creation, HTTP route registration, and the real
 * service contract rather than the task module alone.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as study from '../../../../tests/support/composed-host.mjs';

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { Context } = requireFromSource('@deepseek-ai/cordis');

function mountServices(ctx) {
  const tools = [];
  const routes = [];
  ctx.provide('tools', {
    register(definition) {
      tools.push(definition);
      return () => {
        const index = tools.indexOf(definition);
        if (index >= 0) tools.splice(index, 1);
      };
    },
  });
  ctx.provide('connection', {
    fetch: {
      register(route) {
        routes.push(route);
        return async () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
  });
  return { tools, routes };
}

/**
 * Boot the study plugin in a temporary (or provided) data directory.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string }} [options] - Existing data directory to reopen.
 * @returns {Promise<{ ctx: object, fiber: object, tools: Array<object>, routes: Array<object>, directory: string, call: Function, ok: Function, fail: Function }>}
 *   Harness handle: `call` returns the raw envelope, `ok`/`fail` assert one,
 *   and `ok`/`fail` resolve to the envelope so revision assertions stay possible.
 */
export async function boot(t, { directory: existingDirectory } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'study-tasks-'));
  const ctx = new Context();
  const { tools, routes } = mountServices(ctx);
  const fiber = ctx.plugin(study, { dataDir: directory });
  await fiber;
  t.after(async () => {
    try { await fiber.dispose(); } catch { /* Already disposed by the test. */ }
    if (existingDirectory === undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  const call = (method, payload, options) => ctx.study.call('tasks', method, payload, {requestId:randomUUID(),...options});
  const ok = async (method, payload, options) => {
    const envelope = await call(method, payload, options);
    assert.equal(envelope.ok, true, `expected tasks.${method} to succeed: ${JSON.stringify(envelope)}`);
    return envelope;
  };
  const fail = async (method, payload, options) => {
    const envelope = await call(method, payload, options);
    assert.equal(envelope.ok, false, `expected tasks.${method} to fail: ${JSON.stringify(envelope)}`);
    return envelope;
  };
  return { ctx, fiber, tools, routes, directory, call, ok, fail };
}

/**
 * The local calendar date the host treats as "today".
 * @param {Date} [date] - Instant to format.
 * @returns {string} `YYYY-MM-DD`.
 */
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
