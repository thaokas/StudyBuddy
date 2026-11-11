/**
 * The study service contract: fixed namespaces, failure codes, and the
 * namespace registry that host modules register into. Loaded by both the
 * database and kernel layers, so it depends on nothing else in the plugin.
 */

/** Service namespaces that may own methods; frozen so modules cannot invent APIs. */
export const NAMESPACES = Object.freeze([
  'kernel',
  'tasks',
  'materials',
  'plans',
  'planning',
  'tutoring',
  'timer',
  'followup',
  'outcomes',
  'milestones',
  'memory',
  'learning',
  'review',
]);

/** Failure codes exposed to clients and tools. */
export const ERROR_CODES = Object.freeze(['invalid', 'conflict', 'not_found', 'unavailable']);

const NAMESPACE_SET = new Set(NAMESPACES);
const ERROR_CODE_SET = new Set(ERROR_CODES);
const METHOD_NAME = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** A study service failure carrying one of {@link ERROR_CODES}. */
export class StudyError extends Error {
  /**
   * @param {'invalid' | 'conflict' | 'not_found' | 'unavailable'} code - Failure category.
   * @param {string} message - Actionable, user-safe explanation.
   * @param {object} [details] - Machine-readable context; never credentials.
   */
  constructor(code, message, details = {}) {
    if (!ERROR_CODE_SET.has(code)) throw new TypeError(`unknown study error code ${JSON.stringify(code)}`);
    if (typeof message !== 'string' || message.length === 0) {
      throw new TypeError('study error message must be a non-empty string');
    }
    super(message);
    this.name = 'StudyError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Whether a value is a lossless JSON object (not an array, class instance, or null).
 * @param {unknown} value - Candidate value.
 * @returns {boolean} True for `{}` and null-prototype objects.
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reject a name outside the frozen namespace list.
 * @param {unknown} ns - Candidate namespace.
 */
export function assertNamespace(ns) {
  if (typeof ns !== 'string' || !NAMESPACE_SET.has(ns)) {
    throw new StudyError('invalid', `未知服务命名空间 ${JSON.stringify(ns)}；可用值：${NAMESPACES.join('、')}`);
  }
}

/**
 * Validate `{ methods, writes? }` and return a detached, read-only-safe copy.
 * @param {string} ns - Already validated namespace.
 * @param {unknown} impl - Module-provided implementation.
 * @returns {{ ns: string, methods: Record<string, Function>, writes: Set<string> }} Normalized entry.
 */
export function normalizeImplementation(ns, impl) {
  if (!isPlainObject(impl) || !isPlainObject(impl.methods)) {
    throw new StudyError('invalid', `命名空间 "${ns}" 的实现必须是 { methods, writes? } 对象`);
  }
  const names = Object.keys(impl.methods);
  if (names.length === 0) throw new StudyError('invalid', `命名空间 "${ns}" 没有声明任何方法`);
  for (const name of names) {
    if (!METHOD_NAME.test(name)) {
      throw new StudyError('invalid', `方法名 ${JSON.stringify(name)} 不合法：需以小写字母开头，只含字母、数字、下划线，最长 64`);
    }
    if (typeof impl.methods[name] !== 'function') {
      throw new StudyError('invalid', `命名空间 "${ns}" 的方法 "${name}" 必须是函数`);
    }
  }
  const writes = impl.writes ?? [];
  if (!Array.isArray(writes)) throw new StudyError('invalid', `命名空间 "${ns}" 的 writes 必须是方法名数组`);
  const writeSet = new Set();
  for (const name of writes) {
    if (typeof name !== 'string' || !Object.hasOwn(impl.methods, name)) {
      throw new StudyError('invalid', `writes 中的 ${JSON.stringify(name)} 不是命名空间 "${ns}" 的方法`);
    }
    writeSet.add(name);
  }
  return { ns, methods: { ...impl.methods }, writes: writeSet };
}

/**
 * Create the namespace table shared by `ctx.study.register` and `ctx.study.call`.
 * @param {{ onRegister?: (ns: string, entry: ReturnType<typeof normalizeImplementation>) => (() => unknown) | void }} [options]
 *   `onRegister` runs after a namespace becomes reachable and may return a disposer for its contributions.
 * @returns {{ register: Function, resolve: Function, list: Function, has: Function }} Registry handle.
 */
export function createRegistry({ onRegister } = {}) {
  if (onRegister !== undefined && typeof onRegister !== 'function') {
    throw new TypeError('createRegistry onRegister must be a function');
  }
  const entries = new Map();

  /**
   * Register one namespace; the returned disposer unregisters it and removes its contributions.
   * @param {string} ns - Namespace from {@link NAMESPACES}.
   * @param {unknown} impl - `{ methods, writes? }`.
   * @returns {() => unknown} Disposer.
   */
  function register(ns, impl) {
    assertNamespace(ns);
    const entry = normalizeImplementation(ns, impl);
    if (entries.has(ns)) throw new StudyError('invalid', `服务命名空间 "${ns}" 已经注册`);
    entries.set(ns, entry);
    let removeContribution = () => {};
    try {
      removeContribution = onRegister?.(ns, entry) ?? (() => {});
    } catch (error) {
      entries.delete(ns);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return undefined;
      active = false;
      entries.delete(ns);
      return removeContribution();
    };
  }

  /**
   * Find one method, or throw `not_found` when the namespace or method is absent.
   * @param {string} ns - Namespace.
   * @param {string} method - Method name.
   * @returns {{ ns: string, method: string, handler: Function, isWrite: boolean }} Resolved target.
   */
  function resolve(ns, method) {
    assertNamespace(ns);
    const entry = entries.get(ns);
    if (entry === undefined) throw new StudyError('not_found', `服务命名空间 "${ns}" 尚未注册`);
    if (typeof method !== 'string' || !Object.hasOwn(entry.methods, method)) {
      throw new StudyError('not_found', `命名空间 "${ns}" 没有方法 ${JSON.stringify(method)}`);
    }
    return { ns, method, handler: entry.methods[method], isWrite: entry.writes.has(method) };
  }

  /** Describe every reachable namespace for status output. */
  function list() {
    return [...entries.values()].map(entry => ({
      ns: entry.ns,
      methods: Object.keys(entry.methods),
      writes: [...entry.writes],
    }));
  }

  return { register, resolve, list, has: ns => entries.has(ns) };
}
