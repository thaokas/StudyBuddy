/**
 * SQLite storage for the study service: opens `<dataDir>/study.db` in WAL mode,
 * owns the core tables (idempotency, history, day snapshots), records each
 * module's schema version, and refuses writes when the file was written by an
 * incompatible build. Nothing above this module opens the database directly.
 */
import { mkdir, open as openFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StudyError } from './registry.mjs';
import { migrateFoundation } from './facts.mjs';

/** Physical layout version of the core tables, stored in `PRAGMA user_version`. */
export const CORE_SCHEMA_VERSION = 1;

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS module_schema (
  module_id      TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  applied_at     TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS request_log (
  request_id    TEXT PRIMARY KEY,
  ns            TEXT NOT NULL,
  method        TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  reason      TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS day_snapshot (
  date       TEXT PRIMARY KEY,
  plan_json  TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS change_log_no_update
BEFORE UPDATE ON change_log BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS change_log_no_delete
BEFORE DELETE ON change_log BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS day_snapshot_no_update
BEFORE UPDATE ON day_snapshot BEGIN
  SELECT RAISE(ABORT, 'day_snapshot is write-once');
END;

CREATE TRIGGER IF NOT EXISTS day_snapshot_no_delete
BEFORE DELETE ON day_snapshot BEGIN
  SELECT RAISE(ABORT, 'day_snapshot is write-once');
END;
`;

/**
 * Backup-first recovery text shown when the stored layout is not the one this build understands.
 * @param {string} file - Absolute database path.
 * @returns {string} User-facing guidance.
 */
export function recoveryGuidance(file) {
  return `先复制备份 ${file}（连同同目录下的 -wal、-shm 文件），不要覆盖原文件；然后用创建这份数据的 StudyBuddy 版本重新打开。`
    + '如果确认可以丢弃这些数据，请先备份，再把数据库文件移出数据目录后重新启动。';
}

/** Create a missing database file owner-only; existing files keep their mode. */
async function createDatabaseFile(file) {
  try {
    const handle = await openFile(file, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw new StudyError('unavailable', `无法创建学习数据库 ${file}`, {
      file,
      reason: error.message,
      recovery: '检查数据目录的写入权限与磁盘空间后重试。',
    });
  }
}

/**
 * Open (creating when absent) the study database and ensure its core layout.
 * @param {{ file: string, now?: () => Date }} options - Database path and injectable clock.
 * @returns {Promise<StudyDatabase>} The initialized database.
 * @throws {StudyError} `unavailable` when the file or its layout cannot be used.
 */
export async function openStudyDatabase({ file, now = () => new Date() } = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new StudyError('invalid', '学习数据库需要文件路径');
  }
  const filename = resolve(file);
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await createDatabaseFile(filename);
  let handle;
  try {
    handle = new DatabaseSync(filename);
    const database = new StudyDatabase(handle, filename, now);
    database.initialize();
    return database;
  } catch (error) {
    try { handle?.close(); } catch { /* The initialization failure is the reportable one. */ }
    if (error instanceof StudyError) {
      if (typeof error.details?.recovery === 'string') throw error;
      throw new StudyError(error.code, error.message, {
        ...error.details,
        file: filename,
        recovery: recoveryGuidance(filename),
      });
    }
    throw new StudyError('unavailable', `无法打开学习数据库 ${filename}：${error.message}`, {
      file: filename,
      reason: error.message,
      recovery: recoveryGuidance(filename),
    });
  }
}

/** One open SQLite handle plus the schema/version/transaction rules above it. */
export class StudyDatabase {
  #handle;
  #statements = new Map();
  #closed = false;
  #savepoints = 0;
  #blocked;
  #unknownModules = [];
  #now;

  /**
   * @param {import('node:sqlite').DatabaseSync} handle - Open handle (created by {@link openStudyDatabase}).
   * @param {string} file - Absolute file path.
   * @param {() => Date} now - Injectable clock for timestamps.
   */
  constructor(handle, file, now) {
    this.#handle = handle;
    this.file = file;
    this.#now = now;
  }

  /** Incompatibility report when writes are refused, else null. */
  get blocked() { return this.#blocked ?? null; }

  /** Module ids recorded in the database that the current build no longer ships. */
  get unknownModules() { return [...this.#unknownModules]; }

  /** Whether the handle still accepts work. */
  get isOpen() { return !this.#closed; }

  /** Apply pragmas, verify the core layout, and create the core tables. */
  initialize() {
    this.exec('PRAGMA foreign_keys = ON');
    this.exec('PRAGMA journal_mode = WAL');
    this.exec('PRAGMA busy_timeout = 5000');
    this.exec('PRAGMA synchronous = NORMAL');

    const { user_version: onDisk } = this.get('PRAGMA user_version');
    if (onDisk !== 0 && onDisk !== CORE_SCHEMA_VERSION) {
      throw new StudyError('unavailable', `学习数据库 ${this.file} 的存储版本是 ${onDisk}，当前程序只支持 ${CORE_SCHEMA_VERSION}`, {
        file: this.file,
        databaseVersion: onDisk,
        supportedVersion: CORE_SCHEMA_VERSION,
        recovery: recoveryGuidance(this.file),
      });
    }

    this.exec(CORE_SCHEMA);
    this.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', 'revision', '0');
    if (onDisk === 0) this.exec(`PRAGMA user_version = ${CORE_SCHEMA_VERSION}`);
  }

  /**
   * Read one row.
   * @param {string} sql - Statement with positional `?` parameters.
   * @param {...unknown} params - Bound values.
   * @returns {Record<string, unknown> | undefined} Plain row object, or undefined.
   */
  get(sql, ...params) {
    this.#assertOpen();
    try {
      return rowOf(this.#prepare(sql).get(...params));
    } catch (error) {
      throw queryFailure('查询', this.file, sql, error);
    }
  }

  /**
   * Read every row.
   * @param {string} sql - Statement with positional `?` parameters.
   * @param {...unknown} params - Bound values.
   * @returns {Record<string, unknown>[]} Plain row objects.
   */
  all(sql, ...params) {
    this.#assertOpen();
    try {
      return this.#prepare(sql).all(...params).map(rowOf);
    } catch (error) {
      throw queryFailure('查询', this.file, sql, error);
    }
  }

  /**
   * Execute one write statement.
   * @param {string} sql - Statement with positional `?` parameters.
   * @param {...unknown} params - Bound values.
   * @returns {{ changes: number, lastInsertRowid: number }} Affected rows.
   */
  run(sql, ...params) {
    this.#assertOpen();
    try {
      const result = this.#prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    } catch (error) {
      throw queryFailure('写入', this.file, sql, error);
    }
  }

  /**
   * Execute script-level SQL (DDL and work declared by modules). Never pass user text here.
   * @param {string} sql - One or more complete statements.
   */
  exec(sql) {
    this.#assertOpen();
    try {
      this.#handle.exec(sql);
    } catch (error) {
      throw queryFailure('执行', this.file, sql, error);
    }
  }

  /**
   * Read one metadata value.
   * @param {string} key - Metadata key.
   * @returns {string | undefined} Stored value.
   */
  readMeta(key) {
    const row = this.get('SELECT value FROM meta WHERE key = ?', key);
    return row === undefined ? undefined : String(row.value);
  }

  /**
   * Write one metadata value.
   * @param {string} key - Metadata key.
   * @param {string} value - Stored value.
   */
  writeMeta(key, value) {
    this.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  /** Total row changes performed by this connection, used to catch undeclared writes. */
  totalChanges() {
    return Number(this.get('SELECT total_changes() AS total').total);
  }

  /** Current main-file size in bytes, or null when it cannot be read. */
  fileSize() {
    try { return statSync(this.file).size; } catch { return null; }
  }

  /**
   * Run `work` inside one transaction; nested calls use savepoints.
   * @param {() => unknown} work - Synchronous or asynchronous work.
   * @returns {Promise<unknown>} The work result after commit.
   */
  async transaction(work) {
    this.#assertOpen();
    if (typeof work !== 'function') throw new TypeError('transaction needs a function');
    if (this.#handle.isTransaction) {
      const name = `study_tx_${++this.#savepoints}`;
      this.exec(`SAVEPOINT ${name}`);
      try {
        const value = await work();
        this.exec(`RELEASE ${name}`);
        return value;
      } catch (error) {
        try {
          this.exec(`ROLLBACK TO ${name}`);
          this.exec(`RELEASE ${name}`);
        } catch { /* The original failure is the reportable one; the caller closes an unusable connection. */ }
        throw error;
      }
    }
    this.exec('BEGIN IMMEDIATE');
    try {
      const value = await work();
      this.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.exec('ROLLBACK'); } catch { /* See the savepoint path: keep the original failure. */ }
      throw error;
    }
  }

  /**
   * Compare recorded module schema versions with the modules this build ships.
   * A mismatch blocks writes until the data is backed up and a matching build is used.
   * @param {Array<{ id: string, schemaVersion: number, schema: string[] }>} modules - Discovered modules.
   * @returns {{ blocked: object | null, unknownModules: string[] }} Verification result.
   */
  verifyModules(modules) {
    this.#assertOpen();
    const rows = this.all('SELECT module_id, schema_version FROM module_schema ORDER BY module_id');
    const recorded = new Map(rows.map(row => [String(row.module_id), Number(row.schema_version)]));
    const declared = new Set(modules.map(module => module.id));
    this.#unknownModules = rows.map(row => String(row.module_id)).filter(id => !declared.has(id));

    const mismatched = [];
    for (const module of modules) {
      if (module.schema.length === 0) continue;
      const found = recorded.get(module.id);
      if (found !== undefined && found !== module.schemaVersion) {
        mismatched.push({ id: module.id, databaseVersion: found, supportedVersion: module.schemaVersion });
      }
    }
    this.#blocked = mismatched.length === 0 ? undefined : {
      reason: 'module-schema-mismatch',
      file: this.file,
      modules: mismatched,
      recovery: recoveryGuidance(this.file),
    };
    return { blocked: this.blocked, unknownModules: this.unknownModules };
  }

  /**
   * Create and stamp the schema of every module that the database has not recorded yet.
   * @param {Array<{ id: string, schemaVersion: number, schema: string[] }>} modules - Verified modules.
   */
  async applyModuleSchemas(modules) {
    this.#assertOpen();
    this.assertWritable();
    for (const module of modules) {
      if (module.schema.length === 0) continue;
      if (this.get('SELECT schema_version FROM module_schema WHERE module_id = ?', module.id) !== undefined) continue;
      await this.transaction(() => {
        for (const statement of module.schema) this.exec(statement);
        this.run(
          'INSERT INTO module_schema (module_id, schema_version, applied_at) VALUES (?, ?, ?)',
          module.id,
          module.schemaVersion,
          this.#now().toISOString(),
        );
      });
    }
    const tasks = modules.find(module => module.id === 'tasks');
    if (tasks && !this.get("SELECT name FROM sqlite_master WHERE name = 'study_task_progress'")) {
      for (const statement of tasks.schema) this.exec(statement);
    }
    await migrateFoundation(this);
  }

  /** Reject writes on an incompatible database or a closed handle. */
  assertWritable() {
    this.#assertOpen();
    if (this.#blocked !== undefined) {
      throw new StudyError('unavailable', '学习数据库的 schema 与当前程序不一致，已拒绝写入以保护数据', { ...this.#blocked });
    }
  }

  /** Close the handle; safe to call twice. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    try {
      if (this.#handle.isTransaction) this.#handle.exec('ROLLBACK');
    } catch { /* Closing a connection with a broken transaction is best effort. */ }
    this.#handle.close();
  }

  #assertOpen() {
    if (this.#closed) throw new StudyError('unavailable', '学习数据库已关闭，本次操作未生效');
  }

  #prepare(sql) {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#handle.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}

/** node:sqlite returns null-prototype rows; normalize them for deep comparisons and JSON output. */
function rowOf(row) {
  return row === undefined ? undefined : { ...row };
}

/** Wrap a SQLite failure in the service error shape while keeping the reason searchable. */
function queryFailure(action, file, sql, error) {
  if (error instanceof StudyError) return error;
  const statement = String(sql).trim().split('\n', 1)[0].slice(0, 160);
  return new StudyError('unavailable', `学习数据库${action}失败：${error.message}`, {
    file,
    statement,
    reason: error.message,
  });
}
