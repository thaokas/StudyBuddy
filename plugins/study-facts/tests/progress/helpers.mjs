/**
 * Shared fixture for the T06 progress tests: the real study plugin booted
 * through `host/index.mjs` against a temporary data directory, plus a read-only
 * view of the database for the append-only history assertions.
 *
 * The helper reuses the T05 task fixture so the tests keep exercising module
 * discovery, schema creation, the HTTP route table, and the frozen service
 * contract instead of the task module alone.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { boot, localDate } from '../tasks/helpers.mjs';

export { boot, localDate };

/**
 * Create one task and return its view.
 * @param {{ ok: Function }} harness - Booted service fixture.
 * @param {object} payload - Task fields.
 * @returns {Promise<object>} Created task view.
 */
export async function createTask(harness, payload) {
  const envelope = await harness.ok('createTask', payload);
  return envelope.value.task;
}

/**
 * Create one time block and return its view.
 * @param {{ ok: Function }} harness - Booted service fixture.
 * @param {object} payload - Block fields.
 * @returns {Promise<object>} Created block view.
 */
export async function createBlock(harness, payload) {
  const envelope = await harness.ok('createBlock', payload);
  return envelope.value.block;
}

/**
 * Read rows from the same SQLite file the service holds open. The connection is
 * read-only and only used for evidence the service does not expose (the
 * append-only change log and triggers).
 * @param {{ directory: string }} harness - Booted fixture with its data directory.
 * @param {string} sql - Query text.
 * @param {...unknown} params - Bound parameters.
 * @returns {Array<Record<string, unknown>>} Rows.
 */
export function readRows(harness, sql, ...params) {
  const db = new DatabaseSync(join(harness.directory, 'study.db'), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/**
 * Change-log rows for one entity id, oldest first.
 * @param {{ directory: string }} harness - Booted fixture.
 * @param {string} entity - `task`, `time_block`, or `task_progress`.
 * @param {string} entityId - Entity id.
 * @returns {Array<Record<string, unknown>>} Rows.
 */
export function historyOf(harness, entity, entityId) {
  return readRows(
    harness,
    'SELECT * FROM change_log WHERE entity = ? AND entity_id = ? ORDER BY id ASC',
    entity,
    entityId,
  );
}
