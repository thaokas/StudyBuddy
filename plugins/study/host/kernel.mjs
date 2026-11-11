/**
 * Study service kernel: serializes service calls, enforces `requestId`
 * idempotency and optimistic revisions, runs declared writes in one
 * transaction with the change log and request log, and maintains the
 * once-per-day snapshot. Modules reach it through `ctx.study` or the
 * `kernel` argument of their `apply`.
 */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CORE_SCHEMA_VERSION } from './db.mjs';
import { StudyError, isPlainObject } from './registry.mjs';

const REQUEST_ID_MAX = 200;
const ACTORS = new Set(['ui', 'agent', 'system', 'internal']);

/**
 * Local calendar date (`YYYY-MM-DD`) for "today" in the student's timezone.
 * @param {Date} [date] - Instant to format; defaults to now.
 * @returns {string} Local date.
 */
export function localDate(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Create the kernel over one open database and namespace registry.
 * @param {{
 *   database: import('./db.mjs').StudyDatabase,
 *   registry: ReturnType<import('./registry.mjs').createRegistry>,
 *   modules?: Array<{ id: string, deps?: string[], schemaVersion?: number, schema?: string[] }>,
 *   now?: () => Date,
 *   logger?: { warn: Function, error: Function },
 * }} options - Kernel dependencies.
 * @returns {object} Kernel handle used by the plugin entry and host modules.
 */
export function createKernel({ database, registry, modules = [], now = () => new Date(), logger = console } = {}) {
  if (database === undefined || registry === undefined) throw new TypeError('createKernel needs a database and a registry');
  if (typeof registry.register !== 'function' || typeof registry.resolve !== 'function') {
    throw new TypeError('createKernel needs a namespace registry');
  }

  const scopes = new AsyncLocalStorage();
  let tail = Promise.resolve();
  let closed = false;
  let snapshotDate;
  let snapshotProvider;

  const isoNow = () => now().toISOString();
  const today = () => localDate(now());

  /**
   * Read the current global revision.
   * @returns {number} Monotonic revision.
   */
  function revision() {
    const stored = Number(database.readMeta('revision'));
    if (!Number.isSafeInteger(stored) || stored < 0) {
      throw new StudyError('unavailable', '学习数据库的修订号损坏，已停止写入', { file: database.file });
    }
    return stored;
  }

  function success(value, revisionNumber) {
    return { ok: true, value: toJsonValue(value), revision: revisionNumber };
  }

  function failure(error) {
    if (error instanceof StudyError) return { ok: false, code: error.code, message: error.message, details: error.details ?? {} };
    logger.error('[study] 学习服务内部错误：', error);
    return {
      ok: false,
      code: 'unavailable',
      message: '学习服务内部错误，本次操作未生效',
      details: { reason: error instanceof Error ? error.message : String(error) },
    };
  }

  function toJsonValue(value) {
    if (value === undefined) return null;
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      throw new StudyError('unavailable', '方法返回了无法序列化为 JSON 的数据', { reason: error.message });
    }
    if (serialized === undefined) return null;
    return JSON.parse(serialized);
  }

  function normalizePayload(payload) {
    if (payload === undefined) return {};
    if (!isPlainObject(payload)) throw new StudyError('invalid', '请求载荷必须是 JSON 对象');
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch (error) {
      throw new StudyError('invalid', '请求载荷必须可以序列化为 JSON', { reason: error.message });
    }
  }

  function normalizeActor(actor) {
    if (actor === undefined) return 'internal';
    if (typeof actor !== 'string' || !ACTORS.has(actor)) {
      throw new StudyError('invalid', `未知操作者 ${JSON.stringify(actor)}；可用值：${[...ACTORS].join('、')}`);
    }
    return actor;
  }

  function validateRequest(requestId, expectedRevision) {
    if (requestId !== undefined
      && (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > REQUEST_ID_MAX)) {
      throw new StudyError('invalid', `requestId 必须是 1-${REQUEST_ID_MAX} 个字符的字符串`);
    }
    if (expectedRevision !== undefined && !(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0)) {
      throw new StudyError('invalid', 'expectedRevision 必须是非负整数');
    }
  }

  function enqueue(work) {
    const result = tail.then(work, work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Call one service method. Always resolves to the service envelope; business
   * failures never throw.
   * @param {string} ns - Namespace.
   * @param {string} method - Method name.
   * @param {object} [payload] - Method payload.
   * @param {{ actor?: 'ui'|'agent'|'system'|'internal', requestId?: string, expectedRevision?: number }} [options]
   *   Call context. `requestId` makes a write idempotent; `expectedRevision` rejects stale callers.
   * @returns {Promise<object>} `{ ok: true, value, revision }` or `{ ok: false, code, message, details }`.
   */
  async function call(ns, method, payload, options = {}) {
    if (closed) return failure(new StudyError('unavailable', '学习服务正在关闭，本次操作未生效'));
    if (!isPlainObject(options)) return failure(new StudyError('invalid', '调用选项必须是对象'));
    const scope = scopes.getStore();
    if (scope?.active === true) return runCall(ns, method, payload, options);
    return enqueue(() => {
      const next = { active: true };
      return scopes.run(next, async () => {
        try {
          return await runCall(ns, method, payload, options);
        } finally {
          next.active = false;
        }
      });
    });
  }

  async function runCall(ns, method, payload, options) {
    try {
      const actor = normalizeActor(options.actor);
      validateRequest(options.requestId, options.expectedRevision);
      const body = normalizePayload(payload);
      const target = registry.resolve(ns, method);
      if (target.isWrite && options.requestId === undefined) {
        throw new StudyError('invalid', '写操作缺少 requestId；重试时请复用同一个 requestId', { ns, method, field: 'requestId' });
      }
      if (target.isWrite) database.assertWritable();

      let fingerprint;
      if (options.requestId !== undefined) {
        fingerprint = fingerprintOf(ns, method, options.expectedRevision, body);
        const prior = database.get('SELECT fingerprint, response_json FROM request_log WHERE request_id = ?', options.requestId);
        if (prior !== undefined) {
          if (prior.fingerprint !== fingerprint) {
            throw new StudyError('conflict', '同一个 requestId 已用于不同内容，请换用新的 requestId', {
              requestId: options.requestId,
              ns,
              method,
            });
          }
          try {
            return JSON.parse(prior.response_json);
          } catch (error) {
            throw new StudyError('unavailable', '历史请求结果损坏，无法重放', { requestId: options.requestId, reason: error.message });
          }
        }
      }

      await ensureDaySnapshot();
      const current = revision();
      if (options.expectedRevision !== undefined && options.expectedRevision !== current) {
        throw new StudyError('conflict', `学习数据已更新到修订 ${current}，本次提交基于旧版本，请重新读取`, {
          expectedRevision: options.expectedRevision,
          revision: current,
        });
      }

      const api = Object.freeze({
        db: database,
        kernel: kernelHandle,
        actor,
        requestId: options.requestId,
        now: () => now(),
        today: () => today(),
        revision: () => revision(),
        tx: work => database.transaction(work),
        change: entry => recordChange(actor, entry),
        assertWritable: () => database.assertWritable(),
      });

      if (!target.isWrite) {
        const changesBefore = database.totalChanges();
        const value = await target.handler(body, api);
        if (database.totalChanges() !== changesBefore) {
          logger.warn(`[study] ${ns}.${method} 未声明为写方法却修改了数据库；请把它加入该命名空间的 writes`);
        }
        return success(value, current);
      }

      return await database.transaction(async () => {
        const value = await target.handler(body, api);
        const next = revision() + 1;
        database.writeMeta('revision', String(next));
        const envelope = success(value, next);
        if (options.requestId !== undefined) {
          database.run(
            'INSERT INTO request_log (request_id, ns, method, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            options.requestId,
            ns,
            method,
            fingerprint,
            JSON.stringify(envelope),
            isoNow(),
          );
        }
        return envelope;
      });
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Append one change-log entry; the actor comes from the current call.
   * @param {string} actor - 'ui' | 'agent' | 'system' | 'internal'.
   * @param {{ entity: string, entityId?: string|number|null, action: string, before?: unknown, after?: unknown, reason?: string|null }} entry
   *   What changed and why.
   * @returns {number} Appended row id.
   */
  function recordChange(actor, entry) {
    if (!isPlainObject(entry)) throw new StudyError('invalid', '变更记录必须是对象');
    const entity = entry.entity;
    const action = entry.action;
    if (typeof entity !== 'string' || entity.length === 0 || entity.length > 64) {
      throw new StudyError('invalid', '变更记录需要 1-64 个字符的 entity');
    }
    if (typeof action !== 'string' || action.length === 0 || action.length > 64) {
      throw new StudyError('invalid', '变更记录需要 1-64 个字符的 action');
    }
    const entityId = entry.entityId ?? null;
    if (entityId !== null && typeof entityId !== 'string' && typeof entityId !== 'number') {
      throw new StudyError('invalid', '变更记录的 entityId 只能是字符串、数字或 null');
    }
    const reason = entry.reason ?? null;
    if (reason !== null && (typeof reason !== 'string' || reason.length > 500)) {
      throw new StudyError('invalid', '变更记录的 reason 必须是不超过 500 字符的字符串或 null');
    }
    const result = database.run(
      'INSERT INTO change_log (at, actor, entity, entity_id, action, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      isoNow(),
      actor,
      entity,
      entityId === null ? null : String(entityId),
      action,
      jsonColumn('before', entry.before),
      jsonColumn('after', entry.after),
      reason,
    );
    return result.lastInsertRowid;
  }

  /**
   * Ensure the once-per-day snapshot row exists for the current local date.
   * @returns {Promise<object | null>} Stored snapshot, or null when the database is read-only.
   */
  async function ensureDaySnapshot() {
    if (database.blocked !== null) return null;
    const date = today();
    if (snapshotDate === date) return daySnapshot(date);
    const current = revision();
    let extra = {};
    if (snapshotProvider !== undefined) {
      const provided = await snapshotProvider({ date, revision: current, at: isoNow() });
      if (!isPlainObject(provided)) throw new StudyError('unavailable', '当天快照生成器返回了非对象数据');
      extra = provided;
    }
    let plan;
    try {
      plan = JSON.stringify({ date, revision: current, generatedAt: isoNow(), items: [], ...extra });
    } catch (error) {
      throw new StudyError('unavailable', '当天快照无法序列化为 JSON', { date, reason: error.message });
    }
    database.run(
      'INSERT OR IGNORE INTO day_snapshot (date, plan_json, created_at) VALUES (?, ?, ?)',
      date,
      plan,
      isoNow(),
    );
    snapshotDate = date;
    return daySnapshot(date);
  }

  /**
   * Read a stored day snapshot.
   * @param {string} [date] - Local date; defaults to today.
   * @returns {{ date: string, plan: object, createdAt: string } | null} Stored snapshot.
   */
  function daySnapshot(date = today()) {
    const row = database.get('SELECT plan_json, created_at FROM day_snapshot WHERE date = ?', date);
    if (row === undefined) return null;
    try {
      return { date, plan: JSON.parse(row.plan_json), createdAt: String(row.created_at) };
    } catch (error) {
      throw new StudyError('unavailable', '当天快照数据损坏', { date, reason: error.message });
    }
  }

  /**
   * Install (or clear) the builder that enriches the once-per-day snapshot.
   * The snapshot itself is written once per date, so a later provider only affects the next day.
   * @param {((context: { date: string, revision: number, at: string }) => object | Promise<object>) | undefined} provider
   *   Builder; omit to restore the default empty item list.
   * @returns {() => void} Disposer restoring the previous provider.
   */
  function setDaySnapshotProvider(provider) {
    if (provider !== undefined && typeof provider !== 'function') {
      throw new StudyError('invalid', '当天快照生成器必须是函数或 undefined');
    }
    const previous = snapshotProvider;
    snapshotProvider = provider;
    return () => { snapshotProvider = previous; };
  }

  /** Report current storage, modules, namespaces, and the day snapshot for status tools. */
  function status() {
    const snapshot = daySnapshot();
    return {
      revision: revision(),
      blocked: database.blocked,
      database: {
        file: database.file,
        journalMode: String(database.get('PRAGMA journal_mode').journal_mode),
        sizeBytes: database.fileSize(),
        coreSchemaVersion: CORE_SCHEMA_VERSION,
        unknownModules: database.unknownModules,
      },
      modules: modules.map(module => ({
        id: module.id,
        deps: module.deps ?? [],
        schemaVersion: module.schemaVersion ?? 1,
        schemaStatements: module.schema?.length ?? 0,
      })),
      namespaces: registry.list(),
      today: {
        date: today(),
        snapshotAt: snapshot === null ? null : snapshot.createdAt,
        snapshotRevision: snapshot === null ? null : (snapshot.plan.revision ?? null),
      },
      serverTime: isoNow(),
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    await tail;
    database.close();
  }

  const kernelHandle = Object.freeze({
    call,
    register: (ns, impl) => registry.register(ns, impl),
    tx: work => database.transaction(work),
    revision,
    recordChange: entry => recordChange('system', entry),
    ensureDaySnapshot,
    daySnapshot,
    setDaySnapshotProvider,
    status,
    close,
    get database() { return database; },
  });
  return kernelHandle;
}

/** Build the idempotency fingerprint over everything that affects the stored result. */
function fingerprintOf(ns, method, expectedRevision, payload) {
  return createHash('sha256')
    .update(canonicalJson({ ns, method, expectedRevision: expectedRevision ?? null, payload }))
    .digest('hex');
}

/** Stable JSON text for hashing: object keys sorted, arrays preserved. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** Serialize one optional change-log payload column. */
function jsonColumn(field, value) {
  if (value === undefined || value === null) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    return serialized;
  } catch (error) {
    throw new StudyError('invalid', `变更记录的 ${field} 无法序列化为 JSON`, { reason: error.message });
  }
}
