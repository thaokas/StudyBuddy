/**
 * One-time migration of the v1 JSON memory into the three SQLite tables.
 *
 * The authoritative source is the `study_memory_state` row when it exists
 * (v1 kept writing there after the first import); otherwise `memory.json` is
 * read. The file is copied to `memory.v1.backup.json` before anything is
 * inserted. Import and verification run in one transaction, so a failure
 * leaves the tables empty and lets the caller fall back to read-only v1
 * rendering without touching the file.
 */
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { StudyError, isPlainObject } from '../registry.mjs';
import { countItems, countTombstones, insertItem, insertTombstone, isEmpty, itemById } from './store.mjs';

const FILE_VERSION = 1;
const V1_KINDS = Object.freeze(['preference', 'state', 'observation']);
const ID_PATTERN = /^mem_[a-f0-9]{12}$/;
const MAX_TEXT = 500;

/**
 * Read and validate the v1 source without writing anything.
 * @param {{ db: import('../db.mjs').StudyDatabase, file: string }} options - Database and JSON path.
 * @returns {Promise<{ state: { version: number, items: object[], tombstones: object[] }, fromFile: boolean, text: string } | null>}
 *   Parsed source, or null when neither the state row nor the file exists.
 */
export async function readLegacySource({ db, file }) {
  if (tableExists(db, 'study_memory_state')) {
    const row = db.get('SELECT json FROM study_memory_state WHERE id = 1');
    if (row !== undefined) {
      const text = String(row.json);
      return { state: parseLegacyState(text, file), fromFile: false, text };
    }
  }
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StudyError('unavailable', `无法读取记忆文件 ${file}`, { file, reason: error.message });
  }
  return { state: parseLegacyState(text, file), fromFile: true, text };
}

/**
 * Parse and validate the v1 file format.
 * @param {string} text - JSON text.
 * @param {string} file - Path used in error messages.
 * @returns {{ version: number, items: object[], tombstones: object[] }} Validated state.
 */
export function parseLegacyState(text, file) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StudyError('unavailable', `记忆文件 ${file} 不是合法 JSON，已停止读写以免覆盖`, { file, reason: error.message });
  }
  if (!isPlainObject(parsed) || parsed.version !== FILE_VERSION
    || !Array.isArray(parsed.items) || !Array.isArray(parsed.tombstones)) {
    throw new StudyError('unavailable', `记忆文件 ${file} 的格式或版本不受支持，已停止读写以免覆盖`, { file });
  }
  for (const item of parsed.items) {
    if (!isPlainObject(item)
      || typeof item.id !== 'string' || !ID_PATTERN.test(item.id)
      || !V1_KINDS.includes(item.kind)
      || typeof item.text !== 'string' || item.text.length === 0 || item.text.length > MAX_TEXT
      || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string'
      || (item.expiresAt !== null && item.expiresAt !== undefined
        && (typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt))))
      || !isPlainObject(item.source)) {
      throw new StudyError('unavailable', `记忆文件 ${file} 里有无法识别的记忆条目，已停止读写以免覆盖`, { file });
    }
  }
  for (const tombstone of parsed.tombstones) {
    if (!isPlainObject(tombstone)
      || typeof tombstone.id !== 'string' || !ID_PATTERN.test(tombstone.id)
      || typeof tombstone.contentHash !== 'string' || typeof tombstone.deletedAt !== 'string') {
      throw new StudyError('unavailable', `记忆文件 ${file} 里有无法识别的删除标记，已停止读写以免覆盖`, { file });
    }
  }
  return { version: FILE_VERSION, items: parsed.items, tombstones: parsed.tombstones };
}

/**
 * Import the v1 source into the empty tables, copying the file first.
 * @param {{
 *   db: import('../db.mjs').StudyDatabase,
 *   file: string,
 *   backupFile: string,
 *   goalId: string,
 *   now: () => Date,
 * }} options - Migration inputs.
 * @returns {Promise<{ status: 'migrated' | 'skipped' | 'empty', items: number, tombstones: number, backup: string | null, fromFile?: boolean }>}
 *   Migration result; `skipped` means the tables already hold data.
 */
export async function migrateV1({ db, file, backupFile, goalId, now }) {
  if (!isEmpty(db)) return { status: 'skipped', items: countItems(db), tombstones: countTombstones(db), backup: null };
  const source = await readLegacySource({ db, file });
  if (source === null) return { status: 'empty', items: 0, tombstones: 0, backup: null };

  let backup = null;
  if (!existsSync(backupFile)) {
    if (existsSync(file)) {
      // The backup is the untouched v1 file even when the state row is the
      // authoritative import source.
      await copyFile(file, backupFile);
    } else {
      await writeFile(backupFile, `${JSON.stringify(source.state, null, 2)}\n`, { mode: 0o600 });
    }
    backup = backupFile;
  }

  const at = now().toISOString();
  const items = source.state.items.map(item => ({
    id: item.id,
    goalId: item.goalId ?? goalId,
    kind: item.kind,
    key: null,
    text: item.text,
    value: null,
    confidence: 1,
    status: 'active',
    validFrom: item.createdAt,
    validUntil: item.expiresAt ?? null,
    supersededBy: null,
    sourceKind: 'explicit',
    sourceActor: typeof item.source.actor === 'string' && item.source.actor.length > 0 ? item.source.actor : 'internal',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastConfirmedAt: null,
  }));
  const tombstones = source.state.tombstones.map(tombstone => ({
    id: tombstone.id,
    contentHash: tombstone.contentHash,
    goalId: tombstone.goalId ?? goalId,
    deletedAt: tombstone.deletedAt,
    source: isPlainObject(tombstone.source) ? tombstone.source : { actor: 'internal', at: tombstone.deletedAt },
  }));

  await db.transaction(async () => {
    for (const item of items) insertItem(db, item);
    for (const tombstone of tombstones) insertTombstone(db, tombstone);
    verifyImport(db, { items, tombstones }, file);
  });

  return {
    status: 'migrated',
    items: items.length,
    tombstones: tombstones.length,
    backup,
    fromFile: source.fromFile,
    at,
  };
}

/**
 * Prove the imported rows match the source before the transaction commits.
 * @param {import('../db.mjs').StudyDatabase} db - Database inside the migration transaction.
 * @param {{ items: object[], tombstones: object[] }} source - Expected rows.
 * @param {string} file - Source label for the error.
 */
function verifyImport(db, { items, tombstones }, file) {
  if (countItems(db) !== items.length) {
    throw new StudyError('unavailable', `记忆迁移校验失败：条目数不一致（${file}）`, { file, expected: items.length });
  }
  if (countTombstones(db) !== tombstones.length) {
    throw new StudyError('unavailable', `记忆迁移校验失败：删除标记数不一致（${file}）`, { file, expected: tombstones.length });
  }
  for (const item of items) {
    const stored = itemById(db, item.id);
    if (stored === undefined || stored.text !== item.text || stored.kind !== item.kind) {
      throw new StudyError('unavailable', `记忆迁移校验失败：正文与来源文件不一致（${item.id}）`, { file, id: item.id });
    }
  }
  for (const tombstone of tombstones) {
    const stored = db.get('SELECT content_hash FROM study_memory_tombstone WHERE id = ?', tombstone.id);
    if (stored === undefined || String(stored.content_hash) !== tombstone.contentHash) {
      throw new StudyError('unavailable', `记忆迁移校验失败：删除标记与来源文件不一致（${tombstone.id}）`, { file, id: tombstone.id });
    }
  }
}

function tableExists(db, name) {
  return db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name) !== undefined;
}

