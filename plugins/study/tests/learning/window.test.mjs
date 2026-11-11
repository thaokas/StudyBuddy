/**
 * S2 window tests: the 04:00 study-day boundary, sealing and rule summaries
 * across several days, summary hash reuse and supersession, empty windows, and
 * the 14-day backfill limit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DAY, MINUTE, openLearningHarness } from './helpers.mjs';
import { windowBounds } from '../../host/learning/window.mjs';

describe('study-day windows', () => {
  it('a turn before 04:00 belongs to the previous study day', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 11, 3, 30, 0) });
    harness.link({ sessionId: 'late', taskId: 'task-math', subject: '数学' });
    await harness.emitAndSettle({ sessionId: 'late', text: '怎么解 2x + 3 = 7？' });

    const early = await harness.callOk('windowStatus', {});
    assert.equal(early.today, '2026-11-10');
    assert.equal(early.window.day, '2026-11-10');
    assert.equal(early.window.startAt, new Date(2026, 10, 10, 4, 0, 0).toISOString());
    assert.equal(early.window.endAt, new Date(2026, 10, 11, 4, 0, 0).toISOString());

    harness.clock.advance(60 * MINUTE);
    await harness.emitAndSettle({ sessionId: 'late', text: '那为什么这里要减 3？' });
    const morning = await harness.callOk('windowStatus', {});
    assert.equal(morning.today, '2026-11-11');
    assert.equal(morning.window.day, '2026-11-11');
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_window'), 2);
  });

  it('seals and summarizes three days of questions, and a repeated tick adds nothing', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 9, 9, 0, 0) });
    harness.link({ sessionId: 'three-days', taskId: 'task-math', subject: '数学' });
    await harness.emitAndSettle({ sessionId: 'three-days', text: '怎么解 2x + 3 = 7？' });
    harness.clock.advance(DAY);
    await harness.emitAndSettle({ sessionId: 'three-days', text: '第2题：求 x^2 的导数怎么算？' });
    harness.clock.advance(DAY);
    await harness.emitAndSettle({ sessionId: 'three-days', text: '再问一道：虚拟语气怎么用？' });
    harness.clock.advance(2 * DAY);

    const first = await harness.tick();
    assert.deepEqual(first, { sealed: 3, summarized: 3, failed: 0, errors: 0 });

    const windows = harness.rows('SELECT * FROM study_window ORDER BY start_at ASC');
    assert.equal(windows.length, 3);
    assert.deepEqual(windows.map(window => window.status), ['summarized', 'summarized', 'summarized']);
    assert.equal(windows[0].start_at, new Date(2026, 10, 9, 4, 0, 0).toISOString());
    assert.equal(windows[0].end_at, new Date(2026, 10, 10, 4, 0, 0).toISOString());
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_window_summary'), 3);
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_window_summary WHERE superseded_by IS NOT NULL'), 0);

    const summaries = await harness.callOk('summaries', {});
    assert.equal(summaries.total, 3);
    assert.equal(summaries.items.length, 3);
    assert.equal(summaries.items[0].day, '2026-11-11');
    assert.equal(
      summaries.items[2].text,
      '11 月 9 日 1 次问答、1 道题，0 次闭环、0 次未闭环；重问 0 次。数学 1 次（1 道题）。',
    );
    assert.equal(summaries.items[2].data.counts.episodes, 1);
    assert.deepEqual(summaries.items[2].data.subjects, [{ subject: '数学', episodes: 1, problems: 1 }]);
    const dayOneEpisode = harness.row(
      'SELECT id FROM study_episode WHERE opened_at < ? ORDER BY opened_at ASC LIMIT 1',
      new Date(2026, 10, 10, 4, 0, 0).toISOString(),
    );
    assert.deepEqual(summaries.items[2].evidence, [dayOneEpisode.id]);

    const again = await harness.tick();
    assert.deepEqual(again, { sealed: 0, summarized: 0, failed: 0, errors: 0 });
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_window_summary'), 3);

    const status = await harness.callOk('windowStatus', {});
    assert.equal(status.window, null);
    assert.deepEqual(status.recent.map(window => window.day), ['2026-11-11', '2026-11-10', '2026-11-09']);
    assert.deepEqual(status.pending, { seal: 0, summarize: 0, failed: 0 });

    assert.equal(summaries.threads.length, 1);
    assert.equal(summaries.threads[0].topicId, 'subject:数学');
    assert.equal(summaries.threads[0].data.episodes, 3);
    assert.match(summaries.threads[0].text, /近 30 天 3 次问答、3 道题/);
  });

  it('reuses the summary for the same input hash and supersedes it after a change', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 11, 9, 0, 0) });
    harness.link({ sessionId: 'hash', taskId: 'task-math', subject: '数学' });
    await harness.emitAndSettle({ sessionId: 'hash', text: '怎么求 x^2 的导数？' });
    harness.clock.advance(DAY);
    await harness.tick();

    const windowRow = harness.row('SELECT * FROM study_window');
    assert.equal(windowRow.status, 'summarized');
    const first = harness.row('SELECT * FROM study_window_summary ORDER BY created_at ASC LIMIT 1');
    assert.ok(first);

    const reused = await harness.writeOk('summarizeWindow', { id: windowRow.id }, 'summary:reuse');
    assert.equal(reused.reused, true);
    assert.equal(reused.summaryId, first.id);
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_window_summary'), 1);
    assert.equal(harness.row('SELECT * FROM study_window WHERE id = ?', windowRow.id).summary_id, first.id);

    const episode = harness.row('SELECT * FROM study_episode');
    harness.database.run(
      'UPDATE study_episode SET updated_at = ? WHERE id = ?',
      new Date(2026, 10, 11, 12, 0, 0).toISOString(),
      episode.id,
    );
    const rebuilt = await harness.writeOk('summarizeWindow', { id: windowRow.id }, 'summary:rebuild');
    assert.equal(rebuilt.reused, false);
    assert.notEqual(rebuilt.summaryId, first.id);
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_window_summary'), 2);

    const superseded = harness.row('SELECT * FROM study_window_summary WHERE id = ?', first.id);
    assert.equal(superseded.superseded_by, rebuilt.summaryId);
    const current = harness.row('SELECT * FROM study_window WHERE id = ?', windowRow.id);
    assert.equal(current.status, 'summarized');
    assert.equal(current.summary_id, rebuilt.summaryId);
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_window_summary WHERE superseded_by IS NULL'), 1);

    const listed = await harness.callOk('summaries', {});
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].summaryId, rebuilt.summaryId);
  });

  it('does not create a summary row for an empty window', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 11, 9, 0, 0) });
    const bounds = windowBounds('2026-11-10');
    harness.database.run(
      `INSERT INTO study_window (id, goal_id, kind, start_at, end_at, status, cursor_json, summary_id, closed_at, attempts)
       VALUES ('win-empty', 'goal-1', 'day', ?, ?, 'sealed', NULL, NULL, NULL, 0)`,
      bounds.startAt,
      bounds.endAt,
    );

    const result = await harness.writeOk('summarizeWindow', { id: 'win-empty' }, 'summary:empty');
    assert.equal(result.empty, true);
    assert.equal(result.summaryId, null);
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_window_summary'), 0);
    const windowRow = harness.row("SELECT * FROM study_window WHERE id = 'win-empty'");
    assert.equal(windowRow.status, 'summarized');
    assert.equal(windowRow.summary_id, null);

    const status = await harness.callOk('windowStatus', {});
    assert.equal(status.recent[0].note, 'empty');
    const listed = await harness.callOk('summaries', {});
    assert.equal(listed.total, 0);
  });

  it('marks windows older than the 14-day backfill limit as failed', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 11, 9, 0, 0) });
    const bounds = windowBounds('2026-10-20');
    harness.database.run(
      `INSERT INTO study_window (id, goal_id, kind, start_at, end_at, status, cursor_json, summary_id, closed_at, attempts)
       VALUES ('win-old', 'goal-1', 'day', ?, ?, 'open', NULL, NULL, NULL, 0)`,
      bounds.startAt,
      bounds.endAt,
    );

    const outcome = await harness.tick();
    assert.deepEqual(outcome, { sealed: 0, summarized: 0, failed: 1, errors: 0 });
    const windowRow = harness.row("SELECT * FROM study_window WHERE id = 'win-old'");
    assert.equal(windowRow.status, 'failed');
    assert.equal(windowRow.attempts, 1);

    const status = await harness.callOk('windowStatus', {});
    const old = status.recent.find(window => window.id === 'win-old');
    assert.equal(old.status, 'failed');
    assert.equal(old.note, 'backfill_limit');
    assert.equal(status.pending.failed, 1);
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_window_summary'), 0);
  });

  it('rejects summarizing a window that is still open', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 11, 9, 0, 0) });
    harness.link({ sessionId: 'open', taskId: 'task-math', subject: '数学' });
    await harness.emitAndSettle({ sessionId: 'open', text: '怎么解 2x + 3 = 7？' });
    const windowRow = harness.row('SELECT * FROM study_window');
    const result = await harness.write('summarizeWindow', { id: windowRow.id }, 'summary:open');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'conflict');
  });

  it('rebuilds a day summary when an old open unit continues across 04:00', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 11, 3, 50, 0) });
    harness.link({ sessionId: 'cross', taskId: 'task-math', subject: '数学' });
    await harness.emitAndSettle({ sessionId: 'cross', text: '怎么解 2x + 3 = 7？' });

    harness.clock.advance(15 * MINUTE);
    const first = await harness.tick();
    assert.equal(first.sealed, 1);
    assert.equal(first.summarized, 1);
    const dayWindow = harness.row("SELECT * FROM study_window WHERE start_at = ?", new Date(2026, 10, 10, 4, 0, 0).toISOString());
    assert.equal(dayWindow.status, 'summarized');
    const original = harness.row('SELECT * FROM study_window_summary ORDER BY created_at ASC LIMIT 1');

    harness.clock.advance(5 * MINUTE);
    await harness.emitAndSettle({ sessionId: 'cross', text: '那这一步为什么要减 3？' });
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode'), 1);
    assert.equal(harness.row('SELECT * FROM study_window WHERE id = ?', dayWindow.id).status, 'sealed');

    const second = await harness.tick();
    assert.equal(second.summarized, 1);
    const summaries = harness.rows('SELECT * FROM study_window_summary ORDER BY created_at ASC');
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].superseded_by, summaries[1].id);
    assert.equal(JSON.parse(summaries[1].data_json).counts.episodes, 1);
    const rebuilt = harness.row('SELECT * FROM study_window WHERE id = ?', dayWindow.id);
    assert.equal(rebuilt.status, 'summarized');
    assert.equal(rebuilt.summary_id, summaries[1].id);
    assert.ok(original);
  });
});
