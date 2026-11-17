import { randomUUID } from 'node:crypto';
import { StudyError } from '../../../packages/study-contracts/index.mjs';
import { resolveActiveGoal } from '../../../packages/study-model/facts.mjs';

export const personalSchema = [`CREATE TABLE IF NOT EXISTS study_personal_milestone (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, title TEXT NOT NULL,
  task_ids_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT`];

const invalid = message => new StudyError('invalid', message);
const scope = (api, payload) => resolveActiveGoal(api.db, payload.goalId) ?? 'unassigned';

/** Store only the student's definition; completion always reads the original task records. */
export function savePersonal(payload, api) {
  if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.trim().length > 200) throw invalid('里程碑名称须为 1–200 字');
  if (!Array.isArray(payload.taskIds) || payload.taskIds.length < 1 || payload.taskIds.length > 100
    || payload.taskIds.some(id => typeof id !== 'string' || !id)) throw invalid('请关联 1–100 个任务');
  const goalId = scope(api, payload);
  const taskIds = [...new Set(payload.taskIds)];
  for (const id of taskIds) {
    const task = api.db.get('SELECT goal_id FROM study_task WHERE id = ?', id);
    if (!task || task.goal_id !== goalId) throw invalid('关联任务不存在或不属于当前目标');
  }
  const id = randomUUID();
  const at = api.now().toISOString();
  api.db.run('INSERT INTO study_personal_milestone VALUES (?, ?, ?, ?, ?)', id, goalId, payload.title.trim(), JSON.stringify(taskIds), at);
  api.change({ entity: 'personal_milestone', entityId: id, action: 'create', after: { title: payload.title.trim(), taskIds, goalId }, reason: '学生定义阶段成果' });
  return { item: listPersonal(payload, api).items.find(item => item.id === id) };
}

export function listPersonal(payload, api) {
  const goalId = scope(api, payload);
  return { goalId, items: api.db.all('SELECT * FROM study_personal_milestone WHERE goal_id = ? ORDER BY created_at, rowid', goalId).map(row => {
    const taskIds = JSON.parse(row.task_ids_json);
    const evidence = [];
    for (const id of taskIds) {
      const record = api.db.get('SELECT id, status, confirmed, date FROM study_task_progress WHERE task_id = ? AND goal_id = ? ORDER BY id DESC LIMIT 1', id, goalId);
      if (record?.status === 'done' && record.confirmed === 1) evidence.push({ taskId: id, recordId: Number(record.id), date: record.date });
    }
    return { id: row.id, title: row.title, taskIds, createdAt: row.created_at, completed: evidence.length, total: taskIds.length,
      earned: evidence.length === taskIds.length, earnedAt: evidence.length === taskIds.length ? evidence.map(ref => ref.date).sort().at(-1) : null, evidence };
  }) };
}

export function deletePersonal(payload, api) {
  if (typeof payload.id !== 'string') throw invalid('请选择里程碑');
  const row = api.db.get('SELECT * FROM study_personal_milestone WHERE id = ? AND goal_id = ?', payload.id, scope(api, payload));
  if (!row) throw new StudyError('not_found', '找不到当前目标的里程碑');
  api.db.run('DELETE FROM study_personal_milestone WHERE id = ?', row.id);
  api.change({ entity: 'personal_milestone', entityId: row.id, action: 'delete', before: { title: row.title }, after: null, reason: '学生删除阶段成果定义' });
  return { deleted: true };
}
