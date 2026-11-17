import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMemoryHarness } from './helpers.mjs';

test('student preferences, goal observations and temporary sessions have separate visibility and durable sources', async t => {
  const h = await openMemoryHarness(t);
  h.database.run("INSERT INTO study_goal (id, active) VALUES ('other-goal', 0)");
  const preference = await h.remember({ text: '先看例子', sourceRef: { sessionId: 's1', messageId: 'm1', quote: '先看例子' } });
  assert.equal(preference.ok, true, JSON.stringify(preference));
  assert.equal(preference.value.item.scope, 'student');
  assert.equal(preference.value.item.goalId, null);
  await h.writeOk('memory', 'remember', { text: '数学材料缺少例题', kind: 'observation', goalId: 'memory-goal' });
  await h.writeOk('memory', 'remember', { text: '本轮先做例题', kind: 'state', scope: 'session', sessionId: 's1' });
  const other = await h.ok('memory', 'recall', { goalId: 'other-goal', sessionId: 's2' });
  assert.deepEqual(other.items.map(x => x.text), ['先看例子']);
  const same = await h.ok('memory', 'recall', { sessionId: 's1' });
  assert.equal(same.items.length, 3);
  await h.kernel.close();
  const restarted = await openMemoryHarness(t, { directory: h.directory });
  const read = await restarted.ok('memory', 'recall');
  assert.deepEqual(read.items.find(x => x.text === '先看例子').sourceRef, { sessionId: 's1', messageId: 'm1', quote: '先看例子' });
});

test('correction suppresses old text and reworded old evidence without replacing the correction', async t => {
  const h = await openMemoryHarness(t);
  const sourceRef = { sessionId: 's1', messageId: 'old-message' };
  const saved = await h.writeOk('memory', 'remember', { text: '上午学数学', sourceRef });
  const corrected = await h.writeOk('memory', 'remember', { id: saved.item.id, text: '晚上学数学', sourceRef: { sessionId: 's1', messageId: 'new-message' } });
  assert.equal(corrected.status, 'updated');
  assert.equal((await h.writeOk('memory', 'remember', { text: '上午学数学' })).status, 'suppressed');
  assert.equal((await h.writeOk('memory', 'remember', { text: '早上学习数学', sourceRef })).status, 'suppressed');
  assert.equal(corrected.item.history[0].text, '上午学数学');
  assert.deepEqual((await h.ok('memory', 'recall')).items.map(x => x.text), ['晚上学数学']);
});

test('injection ranks the current question before preference fallback and enforces a total character budget', async t => {
  const h = await openMemoryHarness(t);
  await h.writeOk('memory', 'remember', { kind: 'observation', text: '数学积分需要分步检查', goalId: 'memory-goal' });
  for (let i = 0; i < 9; i++) await h.writeOk('memory', 'remember', { text: `英语偏好${i}` });
  const section = h.contexts.find(x => x.name === 'study:memory');
  const text = section.text({ goalId: 'memory-goal', query: '数学积分', maxChars: 260 });
  assert.match(text, /数学积分需要分步检查/);
  assert.ok(text.length <= 260, text);
  const other = section.text({ goalId: 'unrelated', query: '数学积分' });
  assert.doesNotMatch(other, /数学积分需要分步检查/);
});

test('more than 500 tombstones retain the oldest deletion suppression', async t => {
  const h = await openMemoryHarness(t);
  const saved = await h.writeOk('memory', 'remember', { text: '最早的偏好' });
  await h.writeOk('memory', 'forget', { id: saved.item.id });
  for (let i = 0; i < 501; i++) h.database.run('INSERT INTO study_memory_tombstone VALUES (?, ?, ?, ?, ?)', `old-${i}`, `hash-${i}`, 'memory-goal', h.clock.now().toISOString(), '{}');
  const last = await h.writeOk('memory', 'remember', { text: '最后的偏好' });
  await h.writeOk('memory', 'forget', { id: last.item.id });
  assert.equal((await h.writeOk('memory', 'remember', { text: '最早的偏好' })).status, 'suppressed');
  assert.equal(h.count('SELECT count(*) AS count FROM study_memory_tombstone'), 503);
});

test('real inbox context supplies the current question and an exact tool source reference', async t => {
  const h = await openMemoryHarness(t);
  await h.writeOk('memory', 'remember', { text: '积分必须检查上下限', kind: 'observation' });
  for (let i = 0; i < 9; i++) await h.writeOk('memory', 'remember', { text: `英语观察${i}`, kind: 'observation' });
  h.emitInbox({ sessionId: 'session-live', messageId: 'message-live', text: '现在做积分上下限' });
  const section = h.contexts.find(x => x.name === 'study:memory');
  const context = section.text({ agent: { id: 'session-live' }, maxChars: 260 });
  assert.match(context, /积分必须检查上下限/);
  const value = await h.tools.memory_remember.execute({ text: '以后检查积分上下限' }, { agent: { id: 'session-live' }, callId: 'tool-live', signal: new AbortController().signal });
  assert.equal(value.item.sourceRef.messageId, 'message-live');
  assert.equal(value.item.sourceRef.sessionId, 'session-live');
});

test('temporary memories always expire and remain isolated when the active goal changes', async t => {
  const h = await openMemoryHarness(t);
  const saved = await h.writeOk('memory', 'remember', { text: '仅本轮先给提示', scope: 'session', sessionId: 's' });
  assert.equal(typeof saved.item.expiresAt, 'string');
  h.database.exec('CREATE TABLE study_planning_link (session_id TEXT PRIMARY KEY, goal_id TEXT) STRICT');
  h.database.run("INSERT INTO study_planning_link VALUES ('s', 'memory-goal')");
  h.database.run("INSERT INTO study_goal (id, active) VALUES ('goal-b', 1)");
  h.database.run("UPDATE study_goal SET active = 0 WHERE id = 'memory-goal'");
  const section = h.contexts.find(x => x.name === 'study:memory');
  assert.match(section.text({ agent: { id: 's' } }), /仅本轮先给提示/);
  assert.doesNotMatch(section.text({ agent: { id: 'other' } }), /仅本轮先给提示/);
  assert.ok(section.text({ agent: { id: 's' }, maxChars: 80 }).length <= 80);
  const execution = { agent: { id: 's' }, callId: 'session-recall', signal: new AbortController().signal };
  h.emitInbox({ sessionId: 's', messageId: 'in-goal-a', text: '这份资料需要例题' });
  const observed = await h.tools.memory_remember.execute({ text: '资料缺少例题', kind: 'observation' }, { ...execution, callId: 'session-observe' });
  assert.equal(observed.item.goalId, 'memory-goal');
  const recalled = await h.tools.memory_recall.execute({}, execution);
  assert.equal(recalled.items.length, 2);
  assert.ok(recalled.items.some(x => x.text === '仅本轮先给提示'));
  const forgotten = await h.tools.memory_forget.execute({ id: saved.item.id }, { ...execution, callId: 'session-forget' });
  assert.equal(forgotten.deleted, 1);
});

test('tutoring task title and subject rank related memories before unrelated observations', async t => {
  const h = await openMemoryHarness(t);
  h.database.exec('CREATE TABLE study_task (id TEXT PRIMARY KEY, goal_id TEXT, title TEXT, subject TEXT) STRICT');
  h.database.exec('CREATE TABLE study_tutoring_link (session_id TEXT PRIMARY KEY, task_id TEXT) STRICT');
  h.database.run("INSERT INTO study_task VALUES ('t', 'memory-goal', '积分上下限', '数学')");
  h.database.run("INSERT INTO study_tutoring_link VALUES ('tutor-session', 't')");
  await h.writeOk('memory', 'remember', { text: '积分上下限需要分步检查', kind: 'observation' });
  for (let i = 0; i < 9; i++) await h.writeOk('memory', 'remember', { text: `英语观察${i}`, kind: 'observation' });
  assert.match(h.contexts.find(x => x.name === 'study:memory').text({ agent: { id: 'tutor-session' }, maxChars: 260 }), /积分上下限需要分步检查/);
});
