/**
 * S2 merge/split tests: two units of one goal fold into the earliest one with
 * chronological turns and problems, and splitting at the second turn moves the
 * later turns, problems, and signals into a new closed unit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DAY, MINUTE, openLearningHarness } from './helpers.mjs';

const SECOND = 1000;

describe('merge', () => {
  it('folds two units into the earliest one and keeps the audit trail', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 11, 9, 0, 0) });
    harness.link({ sessionId: 'merge-math', taskId: 'task-math', subject: '数学' });
    await harness.emitAndSettle({ sessionId: 'merge-math', text: '怎么解 2x + 3 = 7？' });
    harness.clock.advance(MINUTE);
    harness.link({ sessionId: 'merge-english', taskId: 'task-english', subject: '英语' });
    await harness.emitAndSettle({ sessionId: 'merge-english', text: '虚拟语气怎么用？' });

    const listed = await harness.callOk('list', {});
    assert.equal(listed.total, 2);
    const math = listed.items.find(item => item.subject === '数学');
    const english = listed.items.find(item => item.subject === '英语');
    assert.ok(math);
    assert.ok(english);

    const result = await harness.writeOk('merge', { episodeIds: [english.id, math.id] }, 'merge:one');
    assert.equal(result.targetId, math.id);
    assert.deepEqual(result.mergedIds, [english.id]);
    assert.equal(result.problemCount, 2);
    assert.equal(result.turnCount, 2);

    const target = harness.row('SELECT * FROM study_episode WHERE id = ?', math.id);
    const source = harness.row('SELECT * FROM study_episode WHERE id = ?', english.id);
    assert.equal(target.problem_count, 2);
    assert.equal(source.status, 'merged');
    assert.equal(source.merged_into, math.id);
    assert.equal(source.problem_count, 0);
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode_problem WHERE episode_id = ?', math.id), 2);
    assert.deepEqual(
      harness.rows('SELECT position FROM study_episode_problem WHERE episode_id = ? ORDER BY position', math.id)
        .map(row => row.position),
      [0, 1],
    );
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode_turn WHERE episode_id = ?', math.id), 2);
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_episode_turn WHERE episode_id = ?', english.id), 0);
    assert.equal(harness.count('SELECT COUNT(*) AS count FROM study_turn WHERE episode_id = ?', math.id), 2);
    assert.deepEqual(
      harness.rows('SELECT topic_id FROM study_episode_topic WHERE episode_id = ? ORDER BY topic_id', math.id)
        .map(row => row.topic_id),
      ['subject:数学', 'subject:英语'],
    );

    const changes = harness.rows("SELECT * FROM change_log WHERE entity = 'episode' ORDER BY id");
    assert.ok(changes.some(entry => entry.action === 'merge' && entry.entity_id === english.id));
    assert.ok(changes.some(entry => entry.action === 'merge_target' && entry.entity_id === math.id));

    const mergedAgain = await harness.write('merge', { episodeIds: [math.id, english.id] }, 'merge:again');
    assert.equal(mergedAgain.ok, false);
    assert.equal(mergedAgain.code, 'conflict');
    const tooFew = await harness.write('merge', { episodeIds: [math.id] }, 'merge:few');
    assert.equal(tooFew.ok, false);
    assert.equal(tooFew.code, 'invalid');
  });

  it('invalidates the day summary so the next tick rebuilds it', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 11, 9, 0, 0) });
    harness.link({ sessionId: 'stale-math', taskId: 'task-math', subject: '数学' });
    await harness.emitAndSettle({ sessionId: 'stale-math', text: '怎么解 2x + 3 = 7？' });
    harness.clock.advance(MINUTE);
    harness.link({ sessionId: 'stale-english', taskId: 'task-english', subject: '英语' });
    await harness.emitAndSettle({ sessionId: 'stale-english', text: '虚拟语气怎么用？' });
    harness.clock.advance(DAY);
    await harness.tick();

    const first = harness.row('SELECT * FROM study_window_summary');
    assert.ok(first);
    const listed = await harness.callOk('list', {});
    const ids = listed.items.map(item => item.id).sort();
    const merged = await harness.writeOk('merge', { episodeIds: ids }, 'merge:stale');
    assert.equal(merged.problemCount, 2);

    const stale = harness.row('SELECT * FROM study_window');
    assert.equal(stale.status, 'sealed');
    harness.clock.advance(MINUTE);
    const outcome = await harness.tick();
    assert.equal(outcome.summarized, 1);

    const summaries = harness.rows('SELECT * FROM study_window_summary ORDER BY created_at ASC');
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].superseded_by, summaries[1].id);
    const data = JSON.parse(summaries[1].data_json);
    assert.equal(data.counts.episodes, 1);
    assert.equal(data.counts.problems, 2);
    const windowRow = harness.row('SELECT * FROM study_window');
    assert.equal(windowRow.status, 'summarized');
    assert.equal(windowRow.summary_id, summaries[1].id);
  });
});

describe('split', () => {
  it('splits at the second turn and moves the later problem, turns, and signals', async t => {
    const harness = await openLearningHarness(t, { initial: new Date(2026, 10, 11, 9, 0, 0) });
    harness.link({ sessionId: 'split', taskId: 'task-math', subject: '数学' });
    await harness.emitAndSettle({ sessionId: 'split', text: '第一题：求 x^2 的导数，怎么算？' });
    harness.clock.advance(30 * SECOND);
    await harness.emitAndSettle({ sessionId: 'split', text: '第2题：求 x^3 的导数，怎么算？' });
    harness.clock.advance(30 * SECOND);
    await harness.emitAndSettle({ sessionId: 'split', text: '懂了，谢谢' });

    const listed = await harness.callOk('list', {});
    assert.equal(listed.total, 1);
    const episodeId = listed.items[0].id;
    const detail = await harness.callOk('get', { id: episodeId });
    assert.equal(detail.turns.length, 3);
    assert.equal(detail.problems.length, 2);
    assert.equal(detail.episode.resolution, 'understood');
    const splitTurn = detail.turns[1];

    const result = await harness.writeOk('split', { episodeId, atTurnId: splitTurn.id }, 'split:one');
    assert.equal(result.episodeId, episodeId);
    assert.equal(result.movedTurns, 2);
    assert.equal(result.movedProblems, 1);
    assert.notEqual(result.newEpisodeId, episodeId);

    const old = await harness.callOk('get', { id: episodeId });
    const fresh = await harness.callOk('get', { id: result.newEpisodeId });
    assert.equal(old.turns.length, 1);
    assert.equal(old.problems.length, 1);
    assert.equal(old.episode.status, 'closed');
    assert.equal(old.episode.problemCount, 1);
    assert.equal(fresh.turns.length, 2);
    assert.equal(fresh.problems.length, 1);
    assert.equal(fresh.episode.status, 'closed');
    assert.equal(fresh.episode.problemCount, 1);
    assert.equal(fresh.episode.subject, '数学');
    assert.equal(fresh.episode.openedAt, splitTurn.at);
    assert.equal(fresh.episode.boundarySource, 'user');
    assert.equal(fresh.problems[0].id, detail.problems[1].id);
    assert.equal(fresh.problems[0].position, 0);
    assert.equal(old.problems[0].id, detail.problems[0].id);
    assert.equal(fresh.episode.resolution, 'understood');
    assert.equal(old.episode.resolution, null);
    assert.ok(fresh.signals.some(signal => signal.kind === 'understood'));
    assert.equal(old.signals.length, 0);

    const turns = harness.rows('SELECT id, episode_id FROM study_turn ORDER BY at ASC, rowid ASC');
    assert.equal(turns.length, 3);
    assert.equal(turns[0].episode_id, episodeId);
    assert.equal(turns[1].episode_id, result.newEpisodeId);
    assert.equal(turns[2].episode_id, result.newEpisodeId);
    assert.equal(harness.count("SELECT COUNT(*) AS count FROM change_log WHERE action = 'split'"), 1);

    const firstTurn = await harness.write(
      'split',
      { episodeId: result.newEpisodeId, atTurnId: fresh.turns[0].id },
      'split:first',
    );
    assert.equal(firstTurn.ok, false);
    assert.equal(firstTurn.code, 'invalid');
    const foreign = await harness.write('split', { episodeId, atTurnId: 'turn_missing' }, 'split:foreign');
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, 'not_found');
  });
});
