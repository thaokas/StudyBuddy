/** Read-only memory v1 contract; no schema registration or writes. */
import { StudyError } from '../study-contracts/index.mjs';
const ITEM_COLUMNS = 'id, goal_id, kind, key, text, value_json, confidence, status, valid_from, valid_until, superseded_by, source_kind, source_actor, created_at, updated_at, last_confirmed_at';
export function currentItemByKey(db, { goalId, kind, key }) {
  // A profile that has never enabled memory has no memory tables yet.
  if (!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'study_memory_item'")) return undefined;
  return mapItem(db.get(
    `SELECT ${ITEM_COLUMNS} FROM study_memory_item
      WHERE goal_id = ? AND kind = ? AND key = ? AND status = 'active' AND superseded_by IS NULL
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    goalId,
    kind,
    key,
  ));
}

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
