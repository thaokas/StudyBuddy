/**
 * StudyBuddy host entry: discovers host modules, opens the study database,
 * provides `ctx.study` (register/call), and serves one authenticated
 * `POST /api/study/<ns>/<method>` route per registered method.
 *
 * A module is any `host/modules/*.mjs` file that exports
 * `{ id, deps = [], schemaVersion = 1, schema = [], apply(ctx, kernel) }`.
 * `schema` holds idempotent DDL for the module's tables; its version is
 * recorded in `module_schema`. A mismatch rejects the registering plugin
 * with backup guidance while unrelated contributions remain available.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStudyDatabase } from './db.mjs';
import { createKernel } from './kernel.mjs';
import { createRegistry } from './registry.mjs';
import { StudyError, isPlainObject } from '../../../packages/study-contracts/index.mjs';
import { loadModuleDefinitions } from '../../../packages/study-model/modules.mjs';
export { loadModuleDefinitions, normalizeModuleDefinition, sortModuleDefinitions } from '../../../packages/study-model/modules.mjs';

const hostDirectory = dirname(fileURLToPath(import.meta.url));
const modulesDirectory = join(hostDirectory, 'modules');
const sourceDirectory = fileURLToPath(new URL('../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const Schema = requireFromSource('@deepseek-ai/schemastery');

/** Plugin name reported by the DSH loader. */
export const name = 'study-core';

/** Host services the plugin needs to load. Routes additionally wait for an optional `connection`. */
export const inject = ['tools'];

/** Loader-validated configuration. */
export const Config = Schema.object({
  dataDir: Schema.string().required(),
});

const HTTP_STATUS = Object.freeze({ invalid: 400, conflict: 409, not_found: 404, unavailable: 503 });

/**
 * Load the plugin: open storage, register core schemas and methods, and serve
 * routes when the host has a web connection. Profiles without a connection
 * (headless) still get the tools and `ctx.study`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context with `tools`.
 * @param {{ dataDir?: string }} config - Loader configuration.
 */
export async function apply(ctx, config) {
  const dataDir = resolveDataDir(config);
  const definitions = await loadModuleDefinitions(modulesDirectory);
  let database;
  try {
    database = await openStudyDatabase({ file: join(dataDir, 'study.db') });
    let kernel;
    let attachRoutes;
    const contributions = new Map();
    const detach = new Map();
    const attach = (ns, entry) => {
      if (attachRoutes === undefined || detach.has(ns)) return;
      detach.set(ns, attachRoutes(ns, entry));
    };
    const registry = createRegistry({
      onRegister: (ns, entry) => {
        contributions.set(ns, entry);
        attach(ns, entry);
        return () => {
          contributions.delete(ns);
          const remove = detach.get(ns);
          detach.delete(ns);
          remove?.();
        };
      },
    });
    kernel = createKernel({ database, registry, requireSnapshotProvider: true });
    const callKernel = (ns, method, payload, options) => kernel.call(ns, method, payload, options);
    const service = Object.freeze({
      register: (ns, impl) => registry.register(ns, impl),
      call: callKernel,
      module: definition => kernel.module(definition),
      has: ns => registry.has(ns),
      composition: () => kernel.composition(),
      kernel,
    });
    ctx.provide('study', service);

    /** Attach routes for every current contribution; returns a disposer clearing the attachment. */
    const attachAll = connectionCtx => {
      attachRoutes = (ns, entry) => registerRoutes(connectionCtx, ns, entry, callKernel);
      for (const [ns, entry] of contributions) attach(ns, entry);
      return () => {
        attachRoutes = undefined;
        for (const remove of detach.values()) remove();
        detach.clear();
      };
    };
    const existingConnection = ctx.get('connection');
    if (existingConnection !== undefined) {
      ctx.effect(() => attachAll(ctx), 'study: routes');
    } else {
      ctx.inject(['connection'], connectionCtx => {
        connectionCtx.effect(() => attachAll(connectionCtx), 'study: routes');
      });
    }

    for (const definition of definitions) {
      const dispose = await service.module(definition);
      ctx.effect(() => dispose, `study-core: ${definition.id} module`);
      await definition.apply(ctx, kernel);
    }
    ctx.effect(() => () => kernel.close(), 'study: database lifetime');
  } catch (error) {
    database?.close();
    throw error;
  }
}

/**
 * Read the data directory from config, then the dedicated environment override, then `DSH_HOME`.
 * @param {{ dataDir?: string } | undefined} config - Loader configuration.
 * @returns {string} Absolute data directory.
 * @throws {StudyError} `invalid` when no directory is configured.
 */
export function resolveDataDir(config) {
  const configured = config?.dataDir;
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured);
  const override = process.env.STUDYBUDDY_STUDY_DIR;
  if (typeof override === 'string' && override.trim().length > 0) return resolve(override);
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.trim().length > 0) return resolve(join(home, 'study'));
  throw new StudyError('invalid', 'study 插件缺少 dataDir 配置，也没有可用的 DSH_HOME 作为数据目录');
}

/**
 * Register one POST route per method of a namespace; the effect owns their removal.
 * @returns {() => unknown} Disposer for the routes.
 */
function registerRoutes(ctx, ns, entry, call) {
  return ctx.effect(function* studyRoutes() {
    for (const method of Object.keys(entry.methods)) {
      yield ctx.connection.fetch.register({
        path: `/api/study/${ns}/${method}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => serveRoute(call, ns, method, request),
      });
    }
  }, `study: ${ns} routes`);
}

async function serveRoute(call, ns, method, request) {
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return failureResponse(new StudyError('invalid', '请求体不是合法 JSON', { ns, method, reason: error.message }));
  }
  if (!isPlainObject(body)) {
    return failureResponse(new StudyError('invalid', '请求体必须是 JSON 对象', { ns, method }));
  }
  const { requestId, expectedRevision, ...payload } = body;
  const result = await call(ns, method, payload, { actor: 'ui', requestId, expectedRevision });
  return Response.json(result, { status: statusOf(result) });
}

function statusOf(result) {
  if (result.ok === true) return 200;
  return HTTP_STATUS[result.code] ?? 500;
}

function failureResponse(error) {
  const result = { ok: false, code: error.code, message: error.message, details: error.details ?? {} };
  return Response.json(result, { status: statusOf(result) });
}
