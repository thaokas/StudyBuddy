import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWriteCall, StudyCallError } from '../../client/lib/api.js';

test('SB-08 UI: double click shares a call; an uncertain network retry keeps the same operation ID', async () => {
  const sent = [];
  const write = createWriteCall(async (_ns, _method, payload) => {
    sent.push(payload);
    if (sent.length === 1) throw new StudyCallError('network', 'response lost after commit');
    return { ok: true, value: { id: 'first-goal' }, revision: 1 };
  });
  const first = write('materials', 'saveGoal', { exam: 'A' });
  assert.equal(write('materials', 'saveGoal', { exam: 'A' }), first);
  await assert.rejects(first, /response lost/);
  const replay = await write('materials', 'saveGoal', { exam: 'A' });
  assert.equal(replay.value.id, 'first-goal');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].requestId, sent[1].requestId);
  await write('materials', 'saveGoal', { exam: 'B' });
  assert.notEqual(sent[2].requestId, sent[0].requestId);
});
