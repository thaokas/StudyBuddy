/**
 * StudyBuddy host entry: discovers host modules, opens the study database,
 * provides `ctx.study` (register/call), and serves one authenticated
 * `POST /api/study/<ns>/<method>` route per registered method.
 *
 * A module is any `host/modules/*.mjs` file that exports
 * `{ id, deps = [], schemaVersion = 1, schema = [], apply(ctx, kernel) }`.
 * `schema` holds idempotent DDL for the module's tables; its version is
 * recorded in `module_schema`, and a mismatch refuses writes with backup
 * guidance instead of touching data this build does not understand.
 */
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStudyDatabase } from './db.mjs';
import { createKernel } from './kernel.mjs';
import { StudyError, createRegistry, isPlainObject } from './registry.mjs';

const hostDirectory = dirname(fileURLToPath(import.meta.url));
const modulesDirectory = join(hostDirectory, 'modules');
const sourceDirectory = fileURLToPath(new URL('../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const Schema = requireFromSource('@deepseek-ai/schemastery');

/** Plugin name reported by the DSH loader. */
export const name = 'study';

/** Host services the plugin needs to load. Routes additionally wait for an optional `connection`. */
export const inject = ['tools'];

/** Loader-validated configuration. */
export const Config = Schema.object({
  dataDir: Schema.string().required(),
});

const HTTP_STATUS = Object.freeze({ invalid: 400, conflict: 409, not_found: 404, unavailable: 503 });
const MODULE_ID = /^[a-z][a-z0-9_]{0,63}$/;
const MODULE_FILE = /^[a-z][a-z0-9_-]*\.mjs$/;

/**
 * Load the plugin: open storage, verify schemas, apply modules, and serve
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
    const verification = database.verifyModules(definitions);
    if (verification.blocked !== null) {
      const detail = verification.blocked.modules
        .map(item => `${item.id}（数据库 ${item.databaseVersion} / 程序 ${item.supportedVersion}）`)
        .join('、');
      throw new StudyError('unavailable', `学习数据 schema 与当前程序不一致，插件已停止加载：${detail}`, { ...verification.blocked });
    }
    await database.applyModuleSchemas(definitions);

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
    kernel = createKernel({ database, registry, modules: definitions });
    const callKernel = (ns, method, payload, options) => kernel.call(ns, method, payload, options);
    const service = Object.freeze({
      register: (ns, impl) => registry.register(ns, impl),
      call: callKernel,
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

    for (const definition of definitions) await definition.apply(ctx, kernel);
    await kernel.ensureDaySnapshot();
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
 * Import every module file in one directory and return the dependency order.
 * @param {string} directory - Directory holding `*.mjs` module files.
 * @returns {Promise<Array<object>>} Normalized modules, dependencies first.
 */
export async function loadModuleDefinitions(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new StudyError('invalid', `无法读取学习模块目录 ${directory}`, { file: directory, reason: error.message });
  }
  const files = entries
    .filter(entry => entry.isFile() && MODULE_FILE.test(entry.name) && !entry.name.startsWith('_'))
    .map(entry => entry.name)
    .sort();
  const definitions = [];
  for (const file of files) {
    let namespace;
    try {
      namespace = await import(pathToFileURL(join(directory, file)).href);
    } catch (error) {
      throw new StudyError('invalid', `无法加载学习模块 ${file}：${error.message}`, { file: join(directory, file) });
    }
    definitions.push(normalizeModuleDefinition(namespace, file));
  }
  return sortModuleDefinitions(definitions);
}

/**
 * Validate one module's named exports.
 * @param {object} namespace - ES module namespace object.
 * @param {string} [label] - File name used in error messages.
 * @returns {{ id: string, deps: string[], schema: string[], schemaVersion: number, apply: Function }} Normalized module.
 */
export function normalizeModuleDefinition(namespace, label = 'module') {
  if (!isPlainObject(namespace) || typeof namespace.apply !== 'function') {
    throw new StudyError('invalid', `学习模块 ${label} 必须导出 apply(ctx, kernel)`);
  }
  const id = namespace.id;
  if (typeof id !== 'string' || !MODULE_ID.test(id)) {
    throw new StudyError('invalid', `学习模块 ${label} 的 id 不合法：需小写字母开头，只含小写字母、数字、下划线`);
  }
  const deps = namespace.deps ?? [];
  if (!Array.isArray(deps) || deps.some(dep => typeof dep !== 'string')) {
    throw new StudyError('invalid', `学习模块 ${id} 的 deps 必须是字符串数组`);
  }
  const schema = namespace.schema ?? [];
  if (!Array.isArray(schema) || schema.some(statement => typeof statement !== 'string' || statement.trim().length === 0)) {
    throw new StudyError('invalid', `学习模块 ${id} 的 schema 必须是非空 SQL 字符串数组`);
  }
  const schemaVersion = namespace.schemaVersion ?? 1;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new StudyError('invalid', `学习模块 ${id} 的 schemaVersion 必须是正整数`);
  }
  return { id, deps: [...deps], schema: [...schema], schemaVersion, apply: namespace.apply };
}

/**
 * Topologically sort modules so every dependency applies first.
 * @param {Array<{ id: string, deps: string[] }>} definitions - Normalized modules.
 * @returns {Array<object>} Ordered modules.
 */
export function sortModuleDefinitions(definitions) {
  const byId = new Map();
  for (const definition of definitions) {
    if (byId.has(definition.id)) throw new StudyError('invalid', `学习模块 id 重复：${definition.id}`);
    byId.set(definition.id, definition);
  }
  const ordered = [];
  const state = new Map();
  const visit = (definition, chain) => {
    const status = state.get(definition.id);
    if (status === 'done') return;
    if (status === 'visiting') {
      throw new StudyError('invalid', `学习模块依赖成环：${[...chain, definition.id].join(' -> ')}`);
    }
    state.set(definition.id, 'visiting');
    for (const dep of definition.deps) {
      const target = byId.get(dep);
      if (target === undefined) throw new StudyError('invalid', `学习模块 ${definition.id} 依赖了不存在的模块 ${dep}`);
      visit(target, [...chain, definition.id]);
    }
    state.set(definition.id, 'done');
    ordered.push(definition);
  };
  for (const definition of definitions) visit(definition, []);
  return ordered;
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
