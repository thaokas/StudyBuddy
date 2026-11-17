/**
 * S4 weekly/monthly review tests: fixed seven-day evidence, exact counts,
 * citations, idempotent regeneration, supersede-on-change, listing, and save.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openS4Harness } from '../learning/s4-helpers.mjs';

function localIso(day, hour = 10) {
  return new Date(2026, 10, day, hour, 0, 0, 0).toISOString();
}

/**
 * Five units in the week of 2026-11-09: one clean different-topic unit and four
 * re-asked, unresolved units sharing one sketch. That gives stats
 * `episodes=5, problems=5, resolved=1, unresolved=4` and one weak topic with
 * four examples plus the same-topic re-ask signal.
 */
function seedWeek(h) {
  h.seedEpisode({ id: 'ep-understood', openedAt: localIso(9, 9), resolution: 'understood' });
  h.seedProblem({
    id: 'p-understood',
    episodeId: 'ep-understood',
    sketch: '概率 分布 期望',
    createdAt: localIso(9, 9),
  });
  const days = [9, 9, 10, 10, 11];
  for (let index = 1; index <= 4; index += 1) {
    const episodeId = `ep-weak-${index}`;
    const at = localIso(days[index], 10 + index);
    h.seedEpisode({ id: episodeId, openedAt: at, resolution: 'unresolved' });
    h.seedProblem({
      id: `p-weak-${index}`,
      episodeId,
      sketch: '函数 可微 多元 连续',
      createdAt: at,
      reaskedFrom: 'p-origin',
      reaskCount: 1,
      status: 'reasked',
    });
  }
}

describe('weekly review', () => {
  it('uses the exact stats, cites problems, and stores one active report', async t => {
    const h = await openS4Harness(t);
    seedWeek(h);
    const report = await h.writeOk('review', 'week', { date: '2026-11-11' }, 'review:week:1');
    assert.equal(report.kind, 'week');
    assert.equal(report.period, '2026-W46');
    assert.equal(report.from, '2026-11-09');
    assert.equal(report.to, '2026-11-15');
    assert.equal(report.saved, true);
    assert.ok(report.id.startsWith('rev_'));
    assert.equal(report.bullets.length, 3);
    assert.match(report.reportMd, /## 我看到的/);
    assert.match(report.reportMd, /## 我的解释/);
    assert.match(report.reportMd, /## 建议你试的/);
    assert.match(report.reportMd, /## 需要你确认的/);
    assert.ok(report.reportMd.includes('p-weak-'), 'the report should cite problem ids');
    assert.ok(report.evidence.citations.length > 0);

    const start = new Date(2026, 10, 9, 4, 0, 0, 0).toISOString();
    const end = new Date(2026, 10, 16, 4, 0, 0, 0).toISOString();
    const stats = await h.callOk('learning', 'stats', {
      from: start,
      to: new Date(Date.parse(end) - 1).toISOString(),
    });
    assert.deepEqual(report.evidence.stats, {
      episodes: stats.episodes,
      problems: stats.problems,
      resolved: stats.resolved,
      unresolved: stats.unresolved,
      reaskRate: stats.reaskRate,
    });
    assert.equal(h.count('SELECT COUNT(*) AS count FROM study_learning_review WHERE superseded_by IS NULL'), 1);
  });

  it('reuses the active row for identical evidence and supersedes it when evidence changes', async t => {
    const h = await openS4Harness(t);
    seedWeek(h);
    const first = await h.writeOk('review', 'week', { date: '2026-11-11' }, 'review:week:first');
    const again = await h.writeOk('review', 'week', { date: '2026-11-11' }, 'review:week:again');
    assert.equal(again.id, first.id);
    assert.equal(again.reused, true);
    assert.equal(h.count('SELECT COUNT(*) AS count FROM study_learning_review'), 1);

    const at = localIso(11, 16);
    h.seedEpisode({ id: 'ep-weak-5', openedAt: at, resolution: 'unresolved' });
    h.seedProblem({
      id: 'p-weak-5',
      episodeId: 'ep-weak-5',
      sketch: '函数 可微 多元 连续',
      createdAt: at,
      reaskedFrom: 'p-origin',
      reaskCount: 1,
      status: 'reasked',
    });
    const changed = await h.writeOk('review', 'week', { date: '2026-11-11' }, 'review:week:changed');
    assert.notEqual(changed.id, first.id);
    const old = h.row('SELECT superseded_by FROM study_learning_review WHERE id = ?', first.id);
    assert.equal(String(old.superseded_by), changed.id);
    assert.equal(h.count('SELECT COUNT(*) AS count FROM study_learning_review WHERE superseded_by IS NULL'), 1);
    const list = await h.callOk('review', 'list', { kind: 'week', date: '2026-11-11' });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, changed.id);
  });

  it('builds without saving and lists no row for that period', async t => {
    const h = await openS4Harness(t);
    seedWeek(h);
    const built = await h.writeOk('review', 'week', { date: '2026-11-18', save: false }, 'review:week:dry');
    assert.equal(built.saved, false);
    assert.equal(built.id, null);
    assert.equal(built.period, '2026-W47');
    assert.match(built.reportMd, /## 我看到的/);
    assert.equal(h.count("SELECT COUNT(*) AS count FROM study_learning_review WHERE period = '2026-W47'"), 0);
  });

  it('stores a caller-provided report with actions and lists it by period', async t => {
    const h = await openS4Harness(t);
    const saved = await h.writeOk('review', 'save', {
      kind: 'week',
      date: '2026-11-18',
      reportMd: '## 我看到的\n- 自定义一条\n',
      actions: [{ text: '做一件事', verify: '做完' }],
    }, 'review:save:1');
    assert.equal(saved.period, '2026-W47');
    assert.equal(saved.reportMd.includes('自定义一条'), true);
    assert.equal(saved.actions[0].text, '做一件事');
    const list = await h.callOk('review', 'list', { kind: 'week', date: '2026-11-18' });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, saved.id);
    assert.equal(list.items[0].bullets[0], '自定义一条');
  });
});

describe('monthly review', () => {
  it('aggregates the month and references the active week report', async t => {
    const h = await openS4Harness(t);
    seedWeek(h);
    const week = await h.writeOk('review', 'week', { date: '2026-11-11' }, 'review:month:week');
    const month = await h.writeOk('review', 'month', { date: '2026-11-11' }, 'review:month:1');
    assert.equal(month.kind, 'month');
    assert.equal(month.period, '2026-11');
    assert.equal(month.from, '2026-11-01');
    assert.equal(month.to, '2026-11-30');
    assert.match(month.reportMd, /## 我看到的/);
    assert.equal(month.bullets.length, 3);
    assert.ok(month.evidence.weeklyReports.some(item => item.id === week.id));
    const list = await h.callOk('review', 'list', { kind: 'month', date: '2026-11-11' });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, month.id);
  });
});
