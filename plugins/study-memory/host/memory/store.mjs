/**
 * SQLite store for the seven-kinds memory layer.
 *
 * One row per memory version in `study_memory_item`; trait evidence and delete
 * tombstones live beside it in `study_memory_evidence` and
 * `study_memory_tombstone`. A superseded trait version keeps `status='active'`
 * and points at its successor through `superseded_by`; "the current version" is
 * therefore `status = 'active' AND superseded_by IS NULL`.
 *
 * This file owns columns and statements only; validation, gating, and rendering
 * stay in `../modules/memory.mjs` and `./traits.mjs`.
 */
import { StudyError } from '../../../../packages/study-contracts/index.mjs';

/** Seven memory kinds kept in one table. */
export const ITEM_KINDS = Object.freeze([
  'preference',
  'state',
  'observation',
  'trait',
  'topic_state',
  'strategy',
  'episode',
]);

/** Kinds the v1 file format and the `memory_*` tools understand. */
export const V1_KINDS = Object.freeze(['preference', 'state', 'observation']);

/** Chinese labels used by tools, snapshots, and the page fallback text. */
export const KIND_LABELS = Object.freeze({
  preference: '偏好',
  state: '短期状态',
  observation: '待确认观察',
  trait: '讲解参数',
  topic_state: '主题状态',
  strategy: '学习习惯',
  episode: '关键问答',
});

/** Lifecycle of one memory item. Superseded rows stay `active` for the audit trail. */
export const ITEM_STATUSES = Object.freeze(['proposed', 'active', 'rejected', 'retired']);

/** Where an item came from. */
export const SOURCE_KINDS = Object.freeze(['explicit', 'inferred', 'user_edit']);

/** DDL applied once and recorded in `module_schema` as `memory = 1`. */
export const SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS study_memory_item (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT,
    text TEXT NOT NULL,
    value_json TEXT,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    superseded_by TEXT,
    source_kind TEXT NOT NULL,
    source_actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_confirmed_at TEXT
  ) STRICT`,
  'CREATE INDEX IF NOT EXISTS study_memory_kind ON study_memory_item (goal_id, kind, status)',

  `CREATE TABLE IF NOT EXISTS study_memory_evidence (
    item_id TEXT NOT NULL,
    ref_kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    weight REAL NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (item_id, ref_kind, ref_id)
  ) STRICT`,

  `CREATE TABLE IF NOT EXISTS study_memory_tombstone (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    source_json TEXT NOT NULL
  ) STRICT`,
]);

const ITEM_COLUMNS = 'id, goal_id, kind, key, text, value_json, confidence, status, valid_from, valid_until, superseded_by, source_kind, source_actor, created_at, updated_at, last_confirmed_at';

/**
 * Whether the three memory tables hold no rows yet.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @returns {boolean} True when no item, evidence, or tombstone exists.
 */
export function isEmpty(db) {
  const items = Number(db.get('SELECT COUNT(*) AS count FROM study_memory_item').count);
  const tombstones = Number(db.get('SELECT COUNT(*) AS count FROM study_memory_tombstone').count);
  return items === 0 && tombstones === 0;
}

/** Count every item row, including superseded versions. */
export function countItems(db) {
  return Number(db.get('SELECT COUNT(*) AS count FROM study_memory_item').count);
}

/** Count every tombstone row. */
export function countTombstones(db) {
  return Number(db.get('SELECT COUNT(*) AS count FROM study_memory_tombstone').count);
}

/**
 * Read one item by id.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {string} id - Item id.
 * @returns {object | undefined} Mapped item.
 */
export function itemById(db, id) {
  return mapItem(db.get(`SELECT ${ITEM_COLUMNS} FROM study_memory_item WHERE id = ?`, id));
}

/**
 * Current (non-superseded) items of one goal.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, kinds?: readonly string[], limit?: number }} options - Filter.
 * @returns {object[]} Mapped items, newest update first.
 */
export function currentItems(db, { goalId, kinds, limit }) {
  const params = [goalId];
  let filter = "goal_id = ? AND status = 'active' AND superseded_by IS NULL";
  if (kinds !== undefined && kinds.length > 0) {
    filter += ` AND kind IN (${kinds.map(() => '?').join(', ')})`;
    params.push(...kinds);
  }
  const capped = limit === undefined ? '' : ' LIMIT ?';
  if (limit !== undefined) params.push(limit);
  return db.all(
    `SELECT ${ITEM_COLUMNS} FROM study_memory_item WHERE ${filter} ORDER BY updated_at DESC, rowid DESC${capped}`,
    ...params,
  ).map(mapItem);
}

/**
 * Current item of one kind and key.
 * @param {import('../db.mjs').StudyDatabase} db - Open study database.
 * @param {{ goalId: string, kind: string, key: string }} options - Identity.
 * @returns {object | undefined} Mapped item.
 */
export { currentItemByKey } from '../../../../packages/study-model/memory-read.mjs';

/** Insert one full item row. */
export function insertItem(db, item) {
  db.run(
    `INSERT INTO study_memory_item (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    item.id,
    item.goalId,
    item.kind,
    item.key ?? null,
    item.text,
    item.value === undefined || item.value === null ? null : JSON.stringify(item.value),
    item.confidence,
    item.status,
    item.validFrom,
    item.validUntil ?? null,
    item.supersededBy ?? null,
    item.sourceKind,
    item.sourceActor,
    item.createdAt,
    item.updatedAt,
    item.lastConfirmedAt ?? null,
  );
}

/** Rewrite the content columns of one v1 item (correction by id). */
export function updateItemContent(db, item) {
  db.run(
    `UPDATE study_memory_item
        SET kind = ?, text = ?, valid_until = ?, updated_at = ?, source_actor = ?, last_confirmed_at = ?
      WHERE id = ?`,
    item.kind,
    item.text,
    item.validUntil ?? null,
    item.updatedAt,
    item.sourceActor,
    item.lastConfirmedAt ?? null,
    item.id,
  );
}

/** Replace the mutable metadata columns of one current item. */
export function updateItemMetadata(db, item) {
  db.run(
    `UPDATE study_memory_item
        SET text = ?, value_json = ?, confidence = ?, updated_at = ?, last_confirmed_at = ?
      WHERE id = ?`,
    item.text,
    item.value === undefined || item.value === null ? null : JSON.stringify(item.value),
    item.confidence,
    item.updatedAt,
    item.lastConfirmedAt ?? null,
    item.id,
  );
}

/** Mark one item as replaced by a newer row. */
export function supersedeItem(db, { id, supersededBy, at }) {
  db.run(
    'UPDATE study_memory_item SET superseded_by = ?, valid_until = ?, updated_at = ? WHERE id = ?',
    supersededBy,
    at,
    at,
    id,
  );
}

/** Delete one item row (v1 `forget` semantics keep only its tombstone). */
export function deleteItem(db, id) {
  db.run('DELETE FROM study_memory_item WHERE id = ?', id);
}

/** Replace every evidence row of one item with the current derivation. */
export function replaceEvidence(db, itemId, entries) {
  db.run('DELETE FROM study_memory_evidence WHERE item_id = ?', itemId);
  for (const entry of entries) {
    db.run(
      'INSERT INTO study_memory_evidence (item_id, ref_kind, ref_id, weight, at) VALUES (?, ?, ?, ?, ?)',
      itemId,
      entry.refKind,
      entry.refId,
      entry.weight,
      entry.at,
    );
  }
}

/**
 * Find a tombstone by normalized content hash inside one goal.
 * @returns {object | undefined} Tombstone view.
 */
export function findTombstone(db, { goalId, contentHash }) {
  const row = db.get(
    'SELECT id, content_hash, goal_id, deleted_at, source_json FROM study_memory_tombstone WHERE goal_id = ? AND content_hash = ? ORDER BY deleted_at DESC LIMIT 1',
    goalId,
    contentHash,
  );
  if (row === undefined) return undefined;
  return {
    id: String(row.id),
    contentHash: String(row.content_hash),
    goalId: String(row.goal_id),
    deletedAt: String(row.deleted_at),
    source: parseJson(row.source_json) ?? {},
  };
}

/** Insert one tombstone. */
export function insertTombstone(db, tombstone) {
  db.run(
    'INSERT INTO study_memory_tombstone (id, content_hash, goal_id, deleted_at, source_json) VALUES (?, ?, ?, ?, ?)',
    tombstone.id,
    tombstone.contentHash,
    tombstone.goalId,
    tombstone.deletedAt,
    JSON.stringify(tombstone.source ?? {}),
  );
}

/** Delete one tombstone after the student revokes it. */
export function deleteTombstone(db, id) {
  db.run('DELETE FROM study_memory_tombstone WHERE id = ?', id);
}

/** Keep at most `limit` newest tombstones across the database. */
export function pruneTombstones(db, limit) {
  const total = countTombstones(db);
  if (total <= limit) return total;
  const overflow = total - limit;
  db.run(
    'DELETE FROM study_memory_tombstone WHERE rowid IN (SELECT rowid FROM study_memory_tombstone ORDER BY deleted_at ASC, rowid ASC LIMIT ?)',
    overflow,
  );
  return limit;
}

/**
 * Map one SQLite row to the internal item object.
 * @param {Record<string, unknown> | undefined} row - Row from `study_memory_item`.
 * @returns {object | undefined} Mapped item.
 */
function mapItem(row) {
  if (row === undefined) return undefined;
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    kind: String(row.kind),
    key: row.key === null ? null : String(row.key),
    text: String(row.text),
    value: parseJson(row.value_json),
    confidence: Number(row.confidence),
    status: String(row.status),
    validFrom: String(row.valid_from),
    validUntil: row.valid_until === null ? null : String(row.valid_until),
    supersededBy: row.superseded_by === null ? null : String(row.superseded_by),
    sourceKind: String(row.source_kind),
    sourceActor: String(row.source_actor),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastConfirmedAt: row.last_confirmed_at === null ? null : String(row.last_confirmed_at),
  };
}

function parseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(String(text));
  } catch (error) {
    throw new StudyError('unavailable', '记忆参数不是合法 JSON，已停止读取以免覆盖', { reason: error.message });
  }
}
