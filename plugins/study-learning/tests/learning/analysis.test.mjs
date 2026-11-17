/**
 * S4 analysis tests: topic clustering, weak-topic ranking, method-signal
 * thresholds, 90-day retention, and the JSONL export.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openS4Harness, DAY } from './s4-helpers.mjs';

function localIso(year, month, day, hour = 10, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

/**
 * Seed one topic with `count` problems and one unit per problem.
 * @returns {Array<object>} Seeded problems.
 */
function seedTopicProblems(h, {
  topicId = `topic_${Math.random().toString(16).slice(2, 10)}`,
  name = '函数可微',
  count = 3,
  start = new Date(h.clock.now().getTime() - 2 * DAY),
  reask = 0,
  resolution = null,
  sketch = '函数 可微 多元 连续',
} = {}) {
  const createdAt = start.toISOString();
  h.seedTopic({ id: topicId, name, createdAt });
  const problems = [];
  for (let index = 0; index < count; index += 1) {
    const episodeId = `${topicId}-ep-${index}`;
    h.seedEpisode({ id: episodeId, openedAt: createdAt, resolution });
    const problem = h.seedProblem({
      id: `${topicId}-p-${index}`,
      episodeId,
      sketch,
      createdAt,
      reaskedFrom: index < reask ? `${topicId}-p-origin` : null,
      reaskCount: index < reask ? 1 : 0,
      status: index < reask ? 'reasked' : 'open',
    });
    h.seedLink(episodeId, topicId, 0.9);
    problems.push(problem);
  }
  return problems;
}

describe('topic clustering', () => {
  it('groups three similar sketches into one topic and leaves dissimilar singletons alone', async t => {
    const h = await openS4Harness(t);
    const at = localIso(2026, 11, 9);
    const similar = [
      '函数 可微 多元 连续',
      '函数 可微 多元 偏导',
      '函数 可微 连续 偏导',
    ];
    similar.forEach((sketch, index) => {
      const episodeId = `ep-similar-${index}`;
      h.seedEpisode({ id: episodeId, openedAt: at });
      h.seedProblem({ id: `p-similar-${index}`, episodeId, sketch, createdAt: at });
    });
    const unrelated = ['概率 分布 期望', '力学 受力 加速度'];
    unrelated.forEach((sketch, index) => {
      const episodeId = `ep-unrelated-${index}`;
      h.seedEpisode({ id: episodeId, openedAt: at, subject: '物理' });
      h.seedProblem({ id: `p-unrelated-${index}`, episodeId, sketch, createdAt: at });
    });

    const first = await h.writeOk('learning', 'refreshTopics', {});
    const topics = h.rows('SELECT id, name FROM study_topic ORDER BY id');
    assert.equal(topics.length, 1);
    assert.match(String(topics[0].name), /函数|可微|多元|连续|偏导/);
    const links = h.rows("SELECT * FROM study_episode_topic WHERE topic_id LIKE 'topic_%'");
    assert.equal(links.length, 3);
    assert.equal(first.topics.length, 1);
    assert.equal(first.topics[0].size, 3);

    const second = await h.writeOk('learning', 'refreshTopics', {});
    assert.equal(h.count("SELECT COUNT(*) AS count FROM study_topic WHERE id LIKE 'topic_%'"), 1);
    assert.equal(second.topics[0].id, first.topics[0].id);
    assert.equal(h.count("SELECT COUNT(*) AS count FROM study_episode_topic WHERE topic_id LIKE 'topic_%'"), 3);
  });
});

describe('weak topics', () => {
  it('ranks a four-problem weak topic and returns citations and a suggestion', async t => {
    const h = await openS4Harness(t);
    seedTopicProblems(h, { topicId: 'topic_weak', name: '多元函数可微', count: 4, reask: 4, resolution: 'unresolved' });
    seedTopicProblems(h, { topicId: 'topic_small', name: '证据不足的主题', count: 2, start: new Date(h.clock.now().getTime() - 3 * DAY) });

    const result = await h.callOk('learning', 'weakTopics', {});
    assert.equal(result.status, 'ok');
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.topicId, 'topic_weak');
    assert.equal(item.n, 4);
    assert.equal(item.reaskCount, 4);
    assert.equal(item.unresolvedCount, 4);
    assert.equal(item.state, 'weak');
    assert.ok(item.score >= 0.5, `weak score should clear the threshold: ${item.score}`);
    assert.equal(item.evidence.length, 3);
    assert.ok(item.evidence.every(entry => entry.refId.startsWith('topic_weak-p-')));
    assert.ok(item.suggestion.includes('多元函数可微'));
    assert.equal(result.skipped, 1);
  });

  it('returns insufficient when no topic reaches three problems', async t => {
    const h = await openS4Harness(t);
    seedTopicProblems(h, { topicId: 'topic_two', name: '只有两道题', count: 2 });
    const result = await h.callOk('learning', 'weakTopics', {});
    assert.equal(result.status, 'insufficient');
    assert.equal(result.items.length, 0);
    assert.equal(result.skipped, 1);
    assert.ok(result.reason.includes('3'));
  });

  it('marks a once-closed topic that was re-asked within 30 days as forgotten', async t => {
    const h = await openS4Harness(t);
    const now = h.clock.now();
    const old = new Date(now.getTime() - 40 * DAY).toISOString();
    const recent = new Date(now.getTime() - 5 * DAY).toISOString();
    h.seedTopic({ id: 'topic_forgotten', name: '旧主题', createdAt: old });
    for (let index = 0; index < 4; index += 1) {
      const episodeId = `ep-forgotten-${index}`;
      h.seedEpisode({
        id: episodeId,
        openedAt: index === 0 ? old : recent,
        resolution: index === 0 ? 'understood' : null,
      });
      h.seedProblem({
        id: `p-forgotten-${index}`,
        episodeId,
        sketch: '旧主题 复习 复习',
        createdAt: index === 0 ? old : recent,
        reaskedFrom: index === 1 ? 'p-forgotten-0' : null,
        reaskCount: index === 1 ? 1 : 0,
      });
      h.seedLink(episodeId, 'topic_forgotten', 0.9);
    }
    const result = await h.callOk('learning', 'weakTopics', {});
    assert.equal(result.items[0].state, 'forgotten');
    assert.equal(result.items[0].stateLabel, '遗忘');
  });
});

describe('method signals', () => {
  it('reports same-topic re-asks at three and not at two', async t => {
    const h = await openS4Harness(t);
    seedTopicProblems(h, { topicId: 'topic_reask', name: '同类反复', count: 3, reask: 3, resolution: 'unresolved' });
    const three = await h.callOk('learning', 'methodSignals', {});
    const signal = three.signals.find(item => item.kind === 'same_topic_reask');
    assert.ok(signal, 'three re-asks should trigger the signal');
    assert.equal(signal.evidence.length, 3);
    assert.ok(signal.counterEvidence.length > 0);
    assert.ok(signal.confidence >= 0.6);

    const h2 = await openS4Harness(t);
    seedTopicProblems(h2, { topicId: 'topic_reask2', name: '只重问两次', count: 2, reask: 2 });
    const two = await h2.callOk('learning', 'methodSignals', {});
    assert.equal(two.signals.some(item => item.kind === 'same_topic_reask'), false);
  });

  it('reports a night re-ask gap over 20 points when the night sample is large enough', async t => {
    const h = await openS4Harness(t);
    for (let index = 0; index < 3; index += 1) {
      const episodeId = `ep-night-${index}`;
      h.seedEpisode({ id: episodeId, openedAt: localIso(2026, 11, 9, 23, 10 + index) });
      h.seedProblem({
        id: `p-night-${index}`,
        episodeId,
        sketch: '夜间 函数',
        createdAt: localIso(2026, 11, 9, 23, 10 + index),
        reaskedFrom: 'origin-night',
      });
    }
    for (let index = 0; index < 3; index += 1) {
      const episodeId = `ep-day-${index}`;
      h.seedEpisode({ id: episodeId, openedAt: localIso(2026, 11, 10, 10, index) });
      h.seedProblem({
        id: `p-day-${index}`,
        episodeId,
        sketch: '日间 函数',
        createdAt: localIso(2026, 11, 10, 10, index),
      });
    }
    const result = await h.callOk('learning', 'methodSignals', {});
    const signal = result.signals.find(item => item.kind === 'night_inefficiency');
    assert.ok(signal, 'night re-ask rate should stand out');
    assert.ok(signal.counterEvidence.length > 0);
  });

  it('does not report a night gap below 20 points', async t => {
    const h = await openS4Harness(t);
    const seed = (id, at, reasked) => {
      const episodeId = `ep-${id}`;
      h.seedEpisode({ id: episodeId, openedAt: at });
      h.seedProblem({
        id: `p-${id}`,
        episodeId,
        sketch: `主题 ${id}`,
        createdAt: at,
        reaskedFrom: reasked ? 'origin' : null,
      });
    };
    seed('n1', localIso(2026, 11, 9, 23, 0), true);
    seed('n2', localIso(2026, 11, 9, 23, 5), false);
    seed('n3', localIso(2026, 11, 9, 23, 10), false);
    seed('d1', localIso(2026, 11, 10, 10, 0), true);
    seed('d2', localIso(2026, 11, 10, 10, 5), false);
    seed('d3', localIso(2026, 11, 10, 10, 10), false);
    const result = await h.callOk('learning', 'methodSignals', {});
    assert.equal(result.signals.some(item => item.kind === 'night_inefficiency'), false);
  });

  it('reports a five-unit burst only when the next three days are quiet', async t => {
    const h = await openS4Harness(t);
    const burstDay = localIso(2026, 10, 30, 10);
    for (let index = 0; index < 5; index += 1) {
      h.seedEpisode({ id: `ep-burst-${index}`, openedAt: burstDay });
      h.seedProblem({ id: `p-burst-${index}`, episodeId: `ep-burst-${index}`, sketch: `突击 主题 ${index}`, createdAt: burstDay });
    }
    const result = await h.callOk('learning', 'methodSignals', {});
    const signal = result.signals.find(item => item.kind === 'burst');
    assert.ok(signal, 'five units followed by three quiet days should trigger');
    assert.ok(signal.counterEvidence.length > 0);

    const h2 = await openS4Harness(t);
    for (let index = 0; index < 4; index += 1) {
      h2.seedEpisode({ id: `ep-burst2-${index}`, openedAt: burstDay });
    }
    const four = await h2.callOk('learning', 'methodSignals', {});
    assert.equal(four.signals.some(item => item.kind === 'burst'), false);
  });

  it('reports a backlog only at five unresolved problems older than 14 days', async t => {
    const h = await openS4Harness(t);
    const at = new Date(h.clock.now().getTime() - 20 * DAY).toISOString();
    for (let index = 0; index < 5; index += 1) {
      const episodeId = `ep-backlog-${index}`;
      h.seedEpisode({ id: episodeId, openedAt: at, resolution: 'unresolved' });
      h.seedProblem({ id: `p-backlog-${index}`, episodeId, sketch: `积压 主题 ${index}`, createdAt: at });
    }
    const result = await h.callOk('learning', 'methodSignals', {});
    const signal = result.signals.find(item => item.kind === 'backlog');
    assert.ok(signal);
    assert.ok(signal.counterEvidence.length > 0);

    const h2 = await openS4Harness(t);
    for (let index = 0; index < 5; index += 1) {
      const episodeId = `ep-backlog2-${index}`;
      h2.seedEpisode({ id: episodeId, openedAt: at, resolution: 'unresolved' });
      h2.seedProblem({ id: `p-backlog2-${index}`, episodeId, sketch: `积压 主题 ${index}`, createdAt: at });
    }
    h2.clock.advance(20 * DAY);
    // Move the evidence forward instead of keeping it 20 days old.
    const future = new Date(h2.clock.now().getTime() - 10 * DAY).toISOString();
    h2.database.run('UPDATE study_episode_problem SET created_at = ?', future);
    const recent = await h2.callOk('learning', 'methodSignals', {});
    assert.equal(recent.signals.some(item => item.kind === 'backlog'), false);
  });
});

describe('study_insight tool', () => {
  it('routes weak topics, signals, build, save, and profile through the service layer', async t => {
    const h = await openS4Harness(t);
    seedTopicProblems(h, { topicId: 'topic_insight', name: '工具主题', count: 3, reask: 3, resolution: 'unresolved' });
    const exec = { signal: { throwIfAborted() {} } };
    const weak = await h.tools.study_insight.execute({ action: 'weak_topics' }, exec);
    assert.equal(weak.status, 'ok');
    assert.ok(weak.items.length >= 1);
    assert.equal(weak.items[0].n, 3);
    assert.match(h.tools.study_insight.output.render({ action: 'weak_topics' }, weak)[0].text, /薄弱度/);

    const signals = await h.tools.study_insight.execute({ action: 'method_signals' }, exec);
    assert.ok(Array.isArray(signals.signals));
    assert.ok(signals.signals.some(signal => signal.kind === 'same_topic_reask'));

    const build = await h.tools.study_insight.execute({ action: 'review_build', date: '2026-11-11' }, exec);
    assert.equal(build.period, '2026-W46');
    assert.ok(Array.isArray(build.evidence.profile));
    assert.ok(Array.isArray(build.evidence.periods));
    assert.ok(build.evidence.weakTopics.items.length >= 1);

    const saved = await h.tools.study_insight.execute({ action: 'review_save', date: '2026-11-11' }, exec);
    assert.equal(saved.period, '2026-W46');
    assert.match(saved.reportMd, /## 我看到的/);
    assert.equal(h.count('SELECT COUNT(*) AS count FROM study_learning_review WHERE superseded_by IS NULL'), 1);

    const profile = await h.tools.study_insight.execute({ action: 'profile' }, exec);
    assert.equal(profile.traits[0].key, 'explain_detail');
  });
});

describe('90-day retention', () => {
  it('clears old text but keeps hashes, sketches, statistics, and the prune marker', async t => {
    const h = await openS4Harness(t);
    const now = h.clock.now();
    const old = new Date(now.getTime() - 91 * DAY).toISOString();
    const recent = new Date(now.getTime() - 2 * DAY).toISOString();
    h.seedEpisode({ id: 'ep-old', openedAt: old });
    h.seedEpisode({ id: 'ep-recent', openedAt: recent });
    h.seedProblem({ id: 'p-old', episodeId: 'ep-old', sketch: '旧题 函数', createdAt: old, text: '旧题完整正文' });
    h.seedProblem({ id: 'p-recent', episodeId: 'ep-recent', sketch: '新题 函数', createdAt: recent, text: '新题完整正文' });
    h.database.run("UPDATE study_episode_problem SET norm = 'old-normalized' WHERE id = 'p-old'");
    h.seedTurn({ id: 'turn-old', episodeId: 'ep-old', at: old, text: '旧回合完整正文' });
    h.seedTurn({ id: 'turn-recent', episodeId: 'ep-recent', at: recent, text: '新回合完整正文' });
    h.database.run(
      `INSERT INTO study_window (id, goal_id, kind, start_at, end_at, status, cursor_json, summary_id, closed_at, attempts)
       VALUES ('w-old', 'goal-1', 'day', ?, ?, 'summarized', NULL, 'sum-old', ?, 0)`,
      old,
      recent,
      recent,
    );
    h.database.run(
      `INSERT INTO study_window_summary
        (id, window_id, level, text, data_json, evidence_json, input_hash, model, prompt_version, superseded_by, created_at)
       VALUES ('sum-old', 'w-old', 'day', '旧日摘要仍然可读', '{}', '[]', 'hash-old', NULL, 'rule-v1', NULL, ?)`,
      recent,
    );
    const before = await h.callOk('learning', 'stats', {});

    const result = await h.writeOk('learning', 'prune', {});
    assert.equal(result.turns, 1);
    assert.equal(result.problems, 1);

    const oldTurn = h.row('SELECT text, text_pruned_at FROM study_turn WHERE id = ?', 'turn-old');
    assert.equal(oldTurn.text, null);
    assert.ok(oldTurn.text_pruned_at);
    const oldProblem = h.row('SELECT text, norm, hash, sketch FROM study_episode_problem WHERE id = ?', 'p-old');
    assert.equal(oldProblem.text, null);
    assert.equal(oldProblem.norm, null);
    assert.equal(oldProblem.hash, 'hash-p-old');
    assert.equal(oldProblem.sketch, '旧题 函数');
    const recentTurn = h.row('SELECT text FROM study_turn WHERE id = ?', 'turn-recent');
    assert.equal(recentTurn.text, '新回合完整正文');
    const after = await h.callOk('learning', 'stats', {});
    assert.deepEqual(after, before);

    const detail = await h.callOk('learning', 'get', { id: 'ep-old' });
    assert.equal(detail.turns[0].textPrunedAt, oldTurn.text_pruned_at);
    const again = await h.writeOk('learning', 'prune', {});
    assert.equal(again.turns, 0);
    assert.equal(again.problems, 0);
    const weak = await h.callOk('learning', 'weakTopics', {});
    assert.equal(Array.isArray(weak.items), true);
    const summaries = await h.callOk('learning', 'summaries', {});
    assert.equal(summaries.items[0].text, '旧日摘要仍然可读');
    const report = await h.writeOk('review', 'week', { date: '2026-11-11' }, 'prune:report');
    assert.equal(report.bullets.length, 3);
    assert.match(report.reportMd, /## 我看到的/);
  });
});

describe('export', () => {
  it('writes one JSONL line per unit without turn text and keeps problem sketches', async t => {
    const h = await openS4Harness(t);
    const at = localIso(2026, 11, 9);
    h.seedEpisode({ id: 'ep-export-1', openedAt: at, resolution: 'understood' });
    h.seedProblem({ id: 'p-export-1', episodeId: 'ep-export-1', sketch: '导出 函数', createdAt: at });
    h.seedTurn({ id: 'turn-export-1', episodeId: 'ep-export-1', at, text: '这段正文不应出现在默认导出里' });
    h.seedTopic({ id: 'topic-export', name: '导出主题' });
    h.seedLink('ep-export-1', 'topic-export', 0.8);
    h.seedEpisode({ id: 'ep-export-2', openedAt: localIso(2026, 11, 10) });
    h.seedProblem({ id: 'p-export-2', episodeId: 'ep-export-2', sketch: '导出 概率', createdAt: localIso(2026, 11, 10) });

    const result = await h.callOk('learning', 'export', {});
    assert.equal(result.count, 2);
    const lines = result.jsonl.trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.id, 'ep-export-1');
    assert.equal(first.problems[0].sketch, '导出 函数');
    assert.equal(first.problems[0].text, '题目 p-export-1');
    assert.equal(first.topics[0].topicId, 'topic-export');
    assert.equal(first.turns[0].id, 'turn-export-1');
    assert.equal(first.turns[0].text, undefined);
    assert.equal(JSON.stringify(first).includes('这段正文不应出现在默认导出里'), false);
  });
});
