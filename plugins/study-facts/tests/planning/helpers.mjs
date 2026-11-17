/**
 * Shared fixture for the plan-creation tests: boot the shipped plugin against
 * fake host services in a temporary data directory, call services with an
 * explicit request identity, run one registered Agent tool, and dispatch the
 * `agent/pre-step` waterfall the way the agent loop does.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
 * Boot the study plugin in a temporary data directory.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string, cleanup?: boolean }} [options] - Existing directory to reopen.
 * @returns {Promise<object>} Harness with `call`, `ok`, `fail`, `tool`, and `preStep`.
 */
export async function boot(t, { directory: existingDirectory, cleanup = true } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'study-planning-'));
  const ctx = new Context();
  const { tools, routes } = mountServices(ctx);
  const fiber = ctx.plugin(study, { dataDir: directory });
  await fiber;
  t.after(async () => {
    try { await fiber.dispose(); } catch { /* Already disposed by the test. */ }
    if (cleanup) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  let counter = 0;
  const identity = (label, options = {}) => ({
    actor: options.actor ?? 'ui',
    requestId: options.requestId ?? `${label}-${++counter}`,
  });
  const call = (namespace, method, payload, options) => ctx.study.call(namespace, method, payload, identity(`${namespace}.${method}`, options));
  const ok = async (namespace, method, payload, options) => {
    const envelope = await call(namespace, method, payload, options);
    assert.equal(envelope.ok, true, `expected ${namespace}.${method} to succeed: ${JSON.stringify(envelope)}`);
    return envelope.value;
  };
  const fail = async (namespace, method, payload, options) => {
    const envelope = await call(namespace, method, payload, options);
    assert.equal(envelope.ok, false, `expected ${namespace}.${method} to fail: ${JSON.stringify(envelope)}`);
    return envelope;
  };
  const tool = async (name, args) => {
    const definition = tools.find(item => item.name === name);
    assert.ok(definition, `${name} tool should be registered`);
    return definition.execute(args, { callId: randomUUID(), signal: new AbortController().signal });
  };
  const preStep = (event) => ctx.waterfall(
    'agent/pre-step',
    { messages: [], signal: new AbortController().signal, ...event },
    () => ({ kind: 'enter', messages: [] }),
  );
  const namespaced = namespace => method => (payload, options) => ok(namespace, method, payload, options);

  return {
    ctx,
    fiber,
    tools,
    routes,
    directory,
    call,
    ok,
    fail,
    tool,
    preStep,
    materials: namespaced('materials'),
    planning: namespaced('planning'),
  };
}
