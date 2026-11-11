/**
 * Shape rules for the client contribution set: `client/pages/*.js`,
 * `client/messages/*.js` and `client/actions/*.js`.
 *
 * This module stays free of React and of browser globals so the build script
 * and the Node tests apply exactly the rules the browser bundle applies. Page
 * modules import React and therefore stay out of the build script; their
 * definitions are checked when the bundle is evaluated.
 */

/** Locales every dictionary module must provide. */
export const REQUIRED_LOCALES = Object.freeze(['en', 'zh']);

/** A page/action file name: lowercase, digits and hyphens. */
const FILE_NAME = /^[a-z][a-z0-9-]*$/;

/** A message key: dotted segments starting lowercase, e.g. `today.action.refresh`. */
const MESSAGE_KEY = /^[a-z][a-zA-Z0-9-]*(\.[a-z][a-zA-Z0-9-]*)+$/;

/**
 * Validate one module entry and its `file` attribution.
 * @param {{ file?: unknown }} entry - `{ file, ... }` contribution entry.
 * @param {string} kind - Directory name used in diagnostics (`pages`).
 * @returns {string} The file name.
 */
function requireFile(entry, kind) {
  const file = entry?.file;
  if (typeof file !== 'string' || !FILE_NAME.test(file)) {
    throw new Error(`client/${kind} 的模块名必须是小写字母开头、只含小写字母/数字/连字符的名称，收到 ${JSON.stringify(file)}`);
  }
  return file;
}

/**
 * Assert that one message key exists in every required locale.
 * @param {{ en: object, zh: object }} dictionary - Merged dictionary.
 * @param {string} key - Message key.
 * @param {string} subject - Who points at the key, for the error message.
 */
function requireMessageKey(dictionary, key, subject) {
  const missing = REQUIRED_LOCALES.filter(locale => !Object.hasOwn(dictionary[locale], key));
  if (missing.length > 0) {
    throw new Error(`${subject} 指向的文案键 ${JSON.stringify(key)} 在 ${missing.join('、')} 字典里不存在`);
  }
}

/**
 * Merge the per-module `{ en, zh }` dictionaries into one namespaced table.
 * Duplicate keys and unmatched locale key sets fail loud: a missing or
 * ambiguous string is a defect, not a runtime fallback.
 * @param {Array<{ file: string, dictionary: unknown }>} modules - Dictionary modules.
 * @returns {{ en: Record<string, string>, zh: Record<string, string> }} Merged dictionary.
 */
export function mergeMessages(modules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error('client/messages 下没有任何字典模块');
  }
  const merged = { en: {}, zh: {} };
  const owners = new Map();
  for (const module of modules) {
    const file = requireFile(module, 'messages');
    const dictionary = module.dictionary;
    if (dictionary === null || typeof dictionary !== 'object' || Array.isArray(dictionary)) {
      throw new Error(`client/messages/${file}.js 的默认导出必须是 { en, zh } 字典对象`);
    }
    const extra = Object.keys(dictionary).filter(locale => !REQUIRED_LOCALES.includes(locale));
    if (extra.length > 0) {
      throw new Error(`client/messages/${file}.js 提供了未支持的语种 ${extra.join('、')}；当前只支持 ${REQUIRED_LOCALES.join('、')}`);
    }
    for (const locale of REQUIRED_LOCALES) {
      const table = dictionary[locale];
      if (table === null || typeof table !== 'object' || Array.isArray(table)) {
        throw new Error(`client/messages/${file}.js 缺少 ${locale} 字典`);
      }
      for (const [key, value] of Object.entries(table)) {
        if (!MESSAGE_KEY.test(key)) {
          throw new Error(`client/messages/${file}.js 的 ${locale} 键 ${JSON.stringify(key)} 必须是小写点分键，例如 today.title`);
        }
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new Error(`client/messages/${file}.js 的 ${locale} 键 ${key} 必须是非空字符串`);
        }
        const owner = owners.get(`${locale}\u0000${key}`);
        if (owner !== undefined) {
          throw new Error(`client/messages/${owner}.js 与 client/messages/${file}.js 重复定义了 ${locale} 键 ${key}`);
        }
        owners.set(`${locale}\u0000${key}`, file);
        merged[locale][key] = value;
      }
    }
  }
  const unmatched = REQUIRED_LOCALES.flatMap(locale => {
    const other = locale === 'en' ? 'zh' : 'en';
    return Object.keys(merged[locale])
      .filter(key => !Object.hasOwn(merged[other], key))
      .map(key => `${locale}:${key}`);
  });
  if (unmatched.length > 0) {
    throw new Error(`client/messages 的 en/zh 键集合不一致：${unmatched.join('、')}`);
  }
  return merged;
}

/**
 * Validate and order the page definitions the bundle assembled.
 * @param {Array<{ file: string, definition: unknown }>} pages - Page modules.
 * @param {{ dictionary: { en: object, zh: object } }} options - Merged dictionary used to check labels.
 * @returns {Array<{ key: string, order: number, label: string, Page: Function }>} Pages sorted for registration.
 */
export function normalizePages(pages, { dictionary }) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('client/pages 下没有任何页面模块');
  }
  const keys = new Set();
  const normalized = pages.map(entry => {
    const file = requireFile(entry, 'pages');
    const definition = entry.definition;
    if (definition === null || typeof definition !== 'object') {
      throw new Error(`client/pages/${file}.js 必须默认导出 { key, order, label, Page }`);
    }
    const { key, order, label, Page } = definition;
    if (key !== file) {
      throw new Error(`client/pages/${file}.js 的 key 必须等于文件名 ${JSON.stringify(file)}，实际是 ${JSON.stringify(key)}`);
    }
    if (keys.has(key)) throw new Error(`页面 key 重复：${key}`);
    keys.add(key);
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      throw new Error(`client/pages/${file}.js 的 order 必须是有限数字`);
    }
    if (typeof label !== 'string' || !MESSAGE_KEY.test(label)) {
      throw new Error(`client/pages/${file}.js 的 label 必须是文案键（例如 today.panel），实际是 ${JSON.stringify(label)}`);
    }
    requireMessageKey(dictionary, label, `client/pages/${file}.js 的 label`);
    if (typeof Page !== 'function') {
      throw new Error(`client/pages/${file}.js 必须导出渲染组件 Page`);
    }
    return { key, order, label, Page };
  });
  return normalized.sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
}

/**
 * Validate and order the action definitions the bundle assembled.
 * @param {Array<{ file: string, definition: unknown }>} actions - Action modules.
 * @param {{ dictionary: { en: object, zh: object }, pageKeys: string[] | Set<string> }} options
 *   Merged dictionary and the page keys an action may target.
 * @returns {Array<{ id: string, page?: string, label: string, run: Function }>} Actions in file order.
 */
export function normalizeActions(actions, { dictionary, pageKeys }) {
  if (!Array.isArray(actions)) throw new Error('client/actions 的模块列表必须是数组');
  const knownPages = new Set(pageKeys);
  const ids = new Set();
  return actions.map(entry => {
    const file = requireFile(entry, 'actions');
    const definition = entry.definition;
    if (definition === null || typeof definition !== 'object') {
      throw new Error(`client/actions/${file}.js 必须默认导出 { id, page?, label, run }`);
    }
    const { id, page, label, run } = definition;
    if (typeof id !== 'string' || !FILE_NAME.test(id)) {
      throw new Error(`client/actions/${file}.js 的 id 必须是短横线小写标识，实际是 ${JSON.stringify(id)}`);
    }
    if (ids.has(id)) throw new Error(`界面动作 id 重复：${id}`);
    ids.add(id);
    if (page !== undefined && !knownPages.has(page)) {
      throw new Error(`client/actions/${file}.js 指向了不存在的页面 ${JSON.stringify(page)}；已知页面：${[...knownPages].join('、') || '（无）'}`);
    }
    if (typeof label !== 'string' || !MESSAGE_KEY.test(label)) {
      throw new Error(`client/actions/${file}.js 的 label 必须是文案键，实际是 ${JSON.stringify(label)}`);
    }
    requireMessageKey(dictionary, label, `client/actions/${file}.js 的 label`);
    if (typeof run !== 'function') {
      throw new Error(`client/actions/${file}.js 的 run 必须是函数`);
    }
    return page === undefined ? { id, label, run } : { id, page, label, run };
  });
}
