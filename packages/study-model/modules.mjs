import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StudyError, isPlainObject } from '../study-contracts/index.mjs';
const MODULE_ID = /^[a-z][a-z0-9_]{0,63}$/;
const MODULE_FILE = /^[a-z][a-z0-9_-]*\.mjs$/;

/**
 * Import every module file in one directory and return the dependency order.
 * @param {string} directory - Directory holding `*.mjs` module files.
 * @returns {Promise<Array<object>>} Normalized modules, dependencies first.
 */
export async function loadModuleDefinitions(directory, { available = [] } = {}) {
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
  return sortModuleDefinitions(definitions, { available });
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
  return { id, deps: [...deps], schema: [...schema], schemaVersion, readContracts: namespace.readContracts ?? [], apply: namespace.apply };
}

/**
 * Topologically sort modules so every dependency applies first.
 * @param {Array<{ id: string, deps: string[] }>} definitions - Normalized modules.
 * @returns {Array<object>} Ordered modules.
 */
export function sortModuleDefinitions(definitions, { available = [] } = {}) {
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
      if (target === undefined && available.includes(dep)) continue;
      if (target === undefined) throw new StudyError('invalid', `学习模块 ${definition.id} 依赖了不存在的模块 ${dep}`);
      visit(target, [...chain, definition.id]);
    }
    state.set(definition.id, 'done');
    ordered.push(definition);
  };
  for (const definition of definitions) visit(definition, []);
  return ordered;
}
