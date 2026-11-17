import assert from 'node:assert/strict';
import { it } from 'node:test';
import { rm } from 'node:fs/promises';
import { boot } from './helpers.mjs';

it('finds the latest planning conversation for one goal, survives restart, and clears on close', async t => {
  const h = await boot(t, { cleanup: false });
  const a = (await h.ok('materials', 'saveGoal', { exam: '目标A', active: true })).goal;
  const b = (await h.ok('materials', 'saveGoal', { exam: '目标B', active: true })).goal;
  await h.ok('planning', 'start', { goalId: a.id, sessionId: 'session-a', brief: {} });
  await h.ok('planning', 'start', { goalId: b.id, sessionId: 'session-b', brief: {} });
  await h.fiber.dispose();
  const reopened = await boot(t, { directory: h.directory, cleanup: false });
  t.after(async () => { await reopened.fiber.dispose(); await rm(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  assert.equal((await reopened.ok('planning', 'latest', { goalId: a.id })).link.sessionId, 'session-a');
  assert.equal((await reopened.ok('planning', 'latest', {})).link.sessionId, 'session-b');
  await reopened.ok('planning', 'close', { sessionId: 'session-b' });
  assert.equal((await reopened.ok('planning', 'latest', { goalId: b.id })).link, null);
});
