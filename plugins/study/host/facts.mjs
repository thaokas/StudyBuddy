import { randomUUID } from 'node:crypto';
import { StudyError } from './registry.mjs';

/** One resolver shared by services, tools and the UI's default reads. */
export function resolveActiveGoal(db, goalId) {
  if (goalId !== undefined && goalId !== null) {
    if (goalId === 'unassigned') return goalId;
    if (typeof goalId !== 'string' || !db.get('SELECT id FROM study_goal WHERE id = ?', goalId)) {
      throw new StudyError('not_found', '找不到备考目标', { goalId });
    }
    return goalId;
  }
  if (!db.get("SELECT name FROM sqlite_master WHERE name = 'study_goal'")) return null;
  return db.get('SELECT id FROM study_goal WHERE active = 1 ORDER BY rowid DESC LIMIT 1')?.id ?? null;
}

export function itemLink(db, planId, itemId) {
  return db.get('SELECT * FROM study_plan_task WHERE plan_id = ? AND item_id = ?', planId, itemId);
}

/** Runs inside the caller's SQLite transaction, including change/request logs. */
export function materializePlan(api, planId, data, revision) {
  const now = api.now().toISOString();
  const goalId = data.goalId ?? 'unassigned';
  const projects = new Map((data.projects ?? []).map(project => [project.id, project]));
  const present = new Set(data.items.map(item => item.id));
  for (const link of api.db.all('SELECT * FROM study_plan_task WHERE plan_id = ?', planId)) {
    if (present.has(link.item_id)) continue;
    api.db.run('UPDATE study_task SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, link.task_id);
    for (const block of api.db.all('SELECT * FROM study_time_block WHERE task_id = ?', link.task_id)) {
      api.db.run('DELETE FROM study_time_block WHERE id = ?', block.id);
      api.change({ entity: 'time_block', entityId: block.id, action: 'delete', before: block });
    }
  }
  for (const item of data.items) {
    let link = itemLink(api.db, planId, item.id);
    if (!link) {
      const taskId = `task_${randomUUID()}`;
      api.db.run(`INSERT INTO study_plan_task (plan_id, item_id, task_id, source_revision, migrated_at)
        VALUES (?, ?, ?, ?, ?)`, planId, item.id, taskId, revision, now);
      api.db.run(`INSERT INTO study_task (id, title, created_at, updated_at, goal_id)
        VALUES (?, ?, ?, ?, ?)`, taskId, item.title, now, now, goalId);
      link = itemLink(api.db, planId, item.id);
    }
    item.taskId = link.task_id;
  }
  for (const item of data.items) {
    const before = api.db.get('SELECT * FROM study_task WHERE id = ?', item.taskId);
    const project = projects.get(item.projectId) ?? null;
    api.db.run(`UPDATE study_task SET title = ?, subject = ?, material_ref = ?, material_id = ?,
      completion_criteria = ?, estimated_minutes = ?, prerequisites_json = ?, goal_id = ?,
      scheduled_date = ?, project_id = ?, project_title = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`,
    item.title, item.subject ?? null, item.materialId ?? null, item.materialId ?? null,
    item.completion ?? null, item.estimateMinutes,
    JSON.stringify(item.dependencies.map(id => data.items.find(entry => entry.id === id)?.taskId).filter(Boolean)),
    goalId, item.date ?? null, project === null ? null : project.id, project === null ? null : project.title,
    now, item.taskId);
    api.change({ entity: 'task', entityId: item.taskId, action: 'plan_sync', before,
      after: api.db.get('SELECT * FROM study_task WHERE id = ?', item.taskId) });
    const blocks = api.db.all('SELECT * FROM study_time_block WHERE task_id = ? ORDER BY rowid', item.taskId);
    const desired = item.blocks ?? (item.date && item.start && item.end
      ? [{ date: item.date, start: item.start, end: item.end }] : []);
    // A revision can keep a task unscheduled or date-only; never invent a free slot.
    if (desired.length === 0) {
      for (const block of blocks) {
        api.db.run('DELETE FROM study_time_block WHERE id = ?', block.id);
        api.change({ entity: 'time_block', entityId: block.id, action: 'delete', before: block });
      }
      item.blockIds = [];
      continue;
    }
    const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const kept = new Set();
    item.blocks = desired.map((slot, index) => {
    const blockId = slot.id ?? blocks[index]?.id ?? `block_${randomUUID()}`;
    const owner = api.db.get('SELECT task_id FROM study_time_block WHERE id = ?', blockId);
    if (owner && owner.task_id !== item.taskId) throw new StudyError('conflict', '时间块属于另一个任务', { blockId });
    if (kept.has(blockId)) throw new StudyError('invalid', '时间块 ID 重复', { blockId });
    kept.add(blockId);
    api.db.run(`INSERT INTO study_time_block
      (id, date, start_minute, end_minute, fixed, task_id, title, note, created_at, updated_at, goal_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET date = excluded.date, start_minute = excluded.start_minute,
      end_minute = excluded.end_minute, fixed = excluded.fixed, title = excluded.title,
      note = excluded.note, updated_at = excluded.updated_at`,
    blockId, slot.date, minutes(slot.start), minutes(slot.end), item.flexible === false ? 1 : 0,
    item.taskId, item.title, JSON.stringify({ tentative: slot.tentative === true,
      assumption: slot.assumption ?? null, sourceProgressRevision: slot.sourceProgressRevision ?? null }), now, now, goalId);
    api.change({ entity: 'time_block', entityId: blockId, action: owner ? 'update' : 'create',
      before: blocks.find(block => block.id === blockId) ?? null, after: api.db.get('SELECT * FROM study_time_block WHERE id = ?', blockId) });
    return { ...slot, id: blockId, taskId: item.taskId };
    });
    for (const block of blocks) if (!kept.has(block.id)) {
      api.db.run('DELETE FROM study_time_block WHERE id = ?', block.id);
      api.change({ entity: 'time_block', entityId: block.id, action: 'delete', before: block });
    }
    item.blockIds = [...kept];
  }
  return data;
}

/** A projection, never another writable copy of the execution facts. */
export function livePlanData(db, planId, data) {
  return { ...data, items: data.items.map(item => {
    const link = itemLink(db, planId, item.id);
    if (!link) return { ...item, taskId: null, blockIds: [], materialization: 'unmigrated' };
    const task = db.get('SELECT * FROM study_task WHERE id = ?', link.task_id);
    const blocks = db.all('SELECT * FROM study_time_block WHERE task_id = ? ORDER BY date, start_minute', link.task_id);
    const time = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    return { ...item, taskId: link.task_id, blockIds: blocks.map(block => block.id),
      materialization: 'materialized', goalId: task.goal_id, deleted: task.deleted_at !== null,
      title: task.title, subject: task.subject, materialId: task.material_id,
      projectId: task.project_id ?? item.projectId ?? null, projectTitle: task.project_title ?? null,
      scheduledDate: task.scheduled_date ?? null,
      completion: task.completion_criteria, estimateMinutes: task.estimated_minutes,
      date: task.deleted_at ? null : (blocks[0]?.date ?? task.scheduled_date),
      start: blocks[0] ? time(blocks[0].start_minute) : null,
      end: blocks[0] ? time(blocks[0].end_minute) : null,
      blocks: blocks.map(block => {
        let meta = {}; try { meta = JSON.parse(block.note) ?? {}; } catch { /* Legacy free-text note. */ }
        return { ...meta, id: block.id, date: block.date, start: time(block.start_minute), end: time(block.end_minute) };
      }) };
  }) };
}

/** Additive, backup-first migration. Historical plan/progress tables remain intact. */
export async function migrateFoundation(db) {
  if (!db.get("SELECT name FROM sqlite_master WHERE name = 'study_task'")) return;
  if (!db.get("SELECT name FROM sqlite_master WHERE name = 'study_task_progress'")) return;
  if (db.readMeta('data_foundation_version') === '1') return;
  const backup = `${db.file}.foundation-${Date.now()}.bak`;
  db.run('VACUUM INTO ?', backup);
  try {
    await db.transaction(() => {
      const add = (table, column, definition) => {
        if (!db.all(`PRAGMA table_info(${table})`).length) return;
        if (!db.all(`PRAGMA table_info(${table})`).some(entry => entry.name === column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      };
      for (const table of ['study_task', 'study_time_block', 'study_task_progress', 'study_followup_review', 'study_followup_reminder']) {
        add(table, 'goal_id', "TEXT NOT NULL DEFAULT 'unassigned'");
        if (db.all(`PRAGMA table_info(${table})`).length) db.exec(`CREATE INDEX IF NOT EXISTS ${table}_goal ON ${table}(goal_id)`);
      }
      add('study_task', 'material_id', 'TEXT');
      add('study_task', 'scheduled_date', 'TEXT');
      add('study_task', 'project_id', 'TEXT');
      add('study_task', 'project_title', 'TEXT');
      add('study_plan_task', 'source_revision', 'INTEGER NOT NULL DEFAULT 0');
      add('study_plan_task', 'migrated_at', "TEXT NOT NULL DEFAULT ''");
      add('study_plan_draft', 'revision', 'INTEGER NOT NULL DEFAULT 1');
      add('study_plan', 'draft_revision', 'INTEGER NOT NULL DEFAULT 0');
      add('study_task_progress', 'legacy_progress_id', 'INTEGER');
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS study_task_progress_legacy ON study_task_progress(legacy_progress_id);
        CREATE TABLE IF NOT EXISTS study_plan_task (
          plan_id TEXT NOT NULL, item_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE,
          source_revision INTEGER NOT NULL, migrated_at TEXT NOT NULL, PRIMARY KEY(plan_id, item_id)) STRICT;
        CREATE TABLE IF NOT EXISTS study_foundation_unmigrated (
          source TEXT NOT NULL, source_id TEXT NOT NULL, reason TEXT NOT NULL, snapshot_json TEXT NOT NULL,
          PRIMARY KEY(source, source_id)) STRICT;`);
      const active = resolveActiveGoal(db) ?? 'unassigned';
      const triggers = db.all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('study_task_progress_no_update', 'study_followup_review_no_update')");
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
      for (const table of ['study_task', 'study_time_block', 'study_task_progress', 'study_followup_review', 'study_followup_reminder']) {
        if (db.all(`PRAGMA table_info(${table})`).length) db.run(`UPDATE ${table} SET goal_id = ? WHERE goal_id = 'unassigned'`, active);
      }
      const hasPlans = Boolean(db.get("SELECT name FROM sqlite_master WHERE name = 'study_plan'"));
      if (hasPlans) {
        db.run('UPDATE study_plan SET goal_id = ? WHERE goal_id IS NULL', active);
        db.run('UPDATE study_plan SET draft_revision = COALESCE((SELECT revision FROM study_plan_draft WHERE plan_id = study_plan.id), 0)');
      }
      for (const trigger of triggers) db.exec(trigger.sql);
      const api = { db, now: () => new Date(), change: entry => db.run(
        `INSERT INTO change_log (at, actor, entity, entity_id, action, before_json, after_json, reason)
        VALUES (?, 'system', ?, ?, ?, ?, ?, '数据基础迁移')`, new Date().toISOString(), entry.entity,
        entry.entityId, entry.action, JSON.stringify(entry.before ?? null), JSON.stringify(entry.after ?? null)) };
      // Walk every historical ID; the final applied head determines today's active tasks.
      for (const plan of hasPlans ? db.all('SELECT * FROM study_plan') : []) {
        const revisions = db.all('SELECT * FROM study_plan_revision WHERE plan_id = ? ORDER BY number', plan.id);
        for (const row of revisions) {
          const data = JSON.parse(row.snapshot_json);
          if (!Array.isArray(data?.items)) throw new Error(`计划修订 ${row.id} 缺少 items`);
          const valid = data.items.filter(item => typeof item.id === 'string' && item.id.length > 0);
          for (const [index, item] of data.items.entries()) if (!valid.includes(item)) db.run(
            'INSERT OR IGNORE INTO study_foundation_unmigrated VALUES (?, ?, ?, ?)',
            'plan_item', `${row.id}:${index}`, '缺少稳定条目 ID', JSON.stringify(item));
          materializePlan(api, plan.id, { ...data, goalId: plan.goal_id, items: valid }, row.number);
        }
      }
      for (const row of hasPlans ? db.all('SELECT * FROM study_plan_progress ORDER BY id') : []) {
        const link = itemLink(db, row.plan_id, row.item_id);
        if (!link) {
          db.run('INSERT OR IGNORE INTO study_foundation_unmigrated VALUES (?, ?, ?, ?)',
            'plan_progress', String(row.id), '找不到稳定条目映射；保留历史记录', JSON.stringify(row));
          continue;
        }
        const goal = db.get('SELECT goal_id FROM study_task WHERE id = ?', link.task_id).goal_id;
        db.run(`INSERT INTO study_task_progress (task_id, date, status, quantity_done, quantity_total, note,
          confirmed, actor, at, goal_id, legacy_progress_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        link.task_id, row.date, row.status, row.quantity_done, row.quantity_total, row.note,
        row.confirmed, row.actor, row.at, goal, row.id);
      }
      db.writeMeta('data_foundation_backup', backup);
      db.writeMeta('data_foundation_version', '1');
    });
  } catch (error) {
    throw new StudyError('unavailable', `数据基础迁移失败，已回滚：${error.message}`, {
      backup, recovery: '保留原数据库与备份；修复提示的损坏记录后重新启动。', reason: error.message });
  }
}
