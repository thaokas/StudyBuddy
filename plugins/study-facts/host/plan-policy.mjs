import { createHash } from 'node:crypto';

const FIELDS = ['chapter', 'page', 'exercise'];
const fingerprint = row => createHash('sha256').update(JSON.stringify([row.id, row.edition, row.source_date, row.toc_json])).digest('hex');
const compact = text => String(text).replace(/\s+/g, '').toLowerCase();

/** Deterministic evidence, shared by material reads and plan normalization. */
export function verifyLocatorEvidence(db, materialId, locator, { actor = null, reading = false } = {}) {
  if (!locator) return null;
  const material = materialId ? db.get('SELECT * FROM study_material WHERE id = ?', materialId) : null;
  const active = material && material.deleted_at === null;
  const version = active ? fingerprint(material) : null;
  const chunks = active ? db.all('SELECT * FROM study_material_chunk WHERE material_id = ? ORDER BY ordinal', materialId) : [];
  let toc = [];
  if (active) { try { toc = JSON.parse(material.toc_json); } catch { /* Corrupt metadata proves no location. */ } }
  if (!Array.isArray(toc)) toc = [];
  const verification = {};
  const unverified = new Set(locator.unverified ?? []);
  for (const field of FIELDS) {
    if (locator[field] === null || locator[field] === undefined) continue;
    const previous = locator.verification?.[field];
    const evidence = previous?.evidence ?? locator.evidence?.[field];
    const stale = evidence?.kind === 'material' && (evidence.materialId !== materialId || evidence.version !== version);
    let match;
    if (active && !stale) match = chunks.find(chunk => {
      if (evidence?.kind === 'material' && evidence.chunkId && chunk.id !== evidence.chunkId) return false;
      if (field === 'page') return Number(chunk.page) === locator.page && chunk.page !== null;
      if (field === 'chapter') return chunk.chapter && (compact(chunk.chapter) === compact(locator.chapter)
        || compact(chunk.chapter).startsWith(`${compact(locator.chapter)}`) && /^第.+章$/.test(compact(locator.chapter)));
      const escaped = String(locator.exercise).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:例题|习题|练习|题|exercise|question)\\s*${escaped}(?![0-9])`, 'iu').test(chunk.text);
    });
    const student = evidence?.kind === 'student' && typeof evidence.source === 'string' && evidence.source.trim()
      && (actor === 'ui' || reading && evidence.recordedBy === 'ui') && (!materialId || active && (actor === 'ui' || evidence.version === version));
    const tocEntry = active && !stale && field !== 'exercise' ? toc.find(entry =>
      field === 'page' ? entry.page !== null && Number(entry.page) === locator.page
        : compact(entry.title) === compact(locator.chapter)) : null;
    if (match) {
      verification[field] = { status: 'verified', evidence: { kind: 'material', materialId, chunkId: match.id, version,
        page: match.page, chapter: match.chapter, excerpt: String(match.text).slice(0, 160) }, assumption: null };
      unverified.delete(field);
    } else if (tocEntry) {
      verification[field] = { status: 'verified', evidence: { kind: 'material', materialId, version,
        tocIndex: tocEntry.index, page: tocEntry.page, chapter: tocEntry.title, source: tocEntry.source ?? 'toc' }, assumption: null };
      unverified.delete(field);
    } else if (student) {
      verification[field] = { status: 'verified', evidence: { kind: 'student', source: evidence.source.trim().slice(0, 500), recordedBy: 'ui', materialId, version }, assumption: null };
      unverified.delete(field);
    } else {
      verification[field] = { status: 'unverified', evidence: evidence?.kind === 'material' ? evidence : null,
        assumption: stale || materialId && !active ? '资料已变更或删除，原定位证据失效，请重新核实。'
          : String(previous?.assumption ?? locator.assumption ?? '缺少原文或学生声明，定位待核实。').slice(0, 500) };
      unverified.add(field);
    }
  }
  return { ...locator, verification, unverified: [...unverified] };
}

export function refreshLocatorEvidence(db, data) {
  if (!data) return data;
  return { ...data, items: data.items.map(item => ({ ...item,
    locator: verifyLocatorEvidence(db, item.materialId, item.locator, { reading: true }) })) };
}

function shift(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const value = new Date(y, m - 1, d + days, 12);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

/** Distant work is deliberately a summary, never a fabricated executable list. */
export function rollingView(data, today) {
  const horizonDays = data.horizonDays ?? 7;
  const end = shift(today, horizonDays - 1);
  return { start: today, end, horizonDays, stageGoals: data.stageGoals, weekGoals: data.weekGoals,
    detailedItems: data.items.filter(item => item.date && item.date >= today && item.date <= end),
    distantWork: data.items.filter(item => item.date && item.date > end).map(item => ({
      id: item.id, projectId: item.projectId, targetDate: item.date, title: item.title,
      estimateMinutes: item.estimateMinutes, workload: item.workload,
    })),
    refinement: { date: today, needed: !(data.refinedDates ?? []).includes(today), action: 'refine' } };
}

/** Historical completed sessions suggest a future estimate; never mutate facts. */
export function estimateSuggestions(db, planId, data) {
  if (!db.get("SELECT name FROM sqlite_master WHERE name = 'study_timer_session'")) return [];
  return data.items.flatMap(item => {
    const link = db.get('SELECT task_id FROM study_plan_task WHERE plan_id = ? AND item_id = ?', planId, item.id);
    if (!link) return [];
    const progress = db.get('SELECT status, confirmed FROM study_task_progress WHERE task_id = ? ORDER BY id DESC LIMIT 1', link.task_id);
    if (progress?.status !== 'done' || Number(progress.confirmed) !== 1) return [];
    const sessions = db.all("SELECT id, accumulated_ms FROM study_timer_session WHERE task_id = ? AND kind = 'study' AND phase = 'finished' AND outcome IN ('completed', 'ended')", link.task_id);
    const actualMinutes = Math.ceil(sessions.reduce((sum, session) => sum + Number(session.accumulated_ms), 0) / 60000);
    if (!actualMinutes) return [];
    return [{ itemId: item.id, taskId: link.task_id, originalEstimateMinutes: item.estimateMinutes,
      actualMinutes, suggestedEstimateMinutes: actualMinutes, deviationMinutes: actualMinutes - item.estimateMinutes,
      sessionIds: sessions.map(session => session.id), basis: 'confirmed_done_and_timer', applied: false }];
  });
}
