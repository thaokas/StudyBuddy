/**
 * Plan-creation context service: the snapshot a "Create plan" submission stores,
 * the one-shot claim the first model step performs, and the agent/pre-step
 * waterfall that turns the claim into a durable injected message.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { boot } from './helpers.mjs';

const SESSION = 'sess-plan-1';

describe('planning.start', () => {
  it('stores the form snapshot and renders the goal, brief and instructions', async t => {
    const h = await boot(t);
    const goal = (await h.materials('saveGoal')({ exam: '2027 考研数学一', deadline: '2027-12-20', dailyMinutes: 150, active: true })).goal;
    const started = await h.planning('start')({
      sessionId: SESSION,
      goalId: goal.id,
      brief: { planTitle: '数学一冲刺计划', stageGoal: '六月前过完高数前四章', dailyMinutes: 120, constraints: '周二晚有实验课', notes: '第一章已学', materialIds: [] },
    });
    assert.equal(started.status, 'created');
    assert.equal(started.injected, false);
    assert.equal(started.goalId, goal.id);
    assert.equal(started.version, 2);

    const { link } = await h.planning('get')({ sessionId: SESSION });
    assert.equal(link.injectedAt, null);
    assert.equal(link.goalId, goal.id);
    assert.ok(link.chars > 1000);

    const claimed = await h.planning('claim')({ sessionId: SESSION });
    assert.equal(claimed.claimed, true);
    assert.match(claimed.snapshot, /创建学习计划/);
    assert.match(claimed.snapshot, /2027 考研数学一/);
    assert.match(claimed.snapshot, /2027-12-20/);
    assert.match(claimed.snapshot, /每天可用分钟：120（表单填写）/);
    assert.match(claimed.snapshot, /数学一冲刺计划/);
    assert.match(claimed.snapshot, /六月前过完高数前四章/);
    assert.match(claimed.snapshot, /周二晚有实验课/);
    assert.match(claimed.snapshot, /第一章已学/);
    assert.match(claimed.snapshot, /每轮最多问 2 个问题/);
    assert.match(claimed.snapshot, /完成定义/);
    assert.match(claimed.snapshot, /projectId/);
    assert.match(claimed.snapshot, /工作台/);
    assert.match(claimed.snapshot, /不要写 `start`\/`end`/);
    assert.doesNotMatch(claimed.snapshot, /\{\{KNOWN_INFORMATION\}\}/);
  });

  it('is idempotent for the same form and refreshes before the first injection', async t => {
    const h = await boot(t);
    const first = await h.planning('start')({ sessionId: SESSION, brief: { planTitle: '计划 A' } });
    assert.equal(first.status, 'created');
    const same = await h.planning('start')({ sessionId: SESSION, brief: { planTitle: '计划 A' } });
    assert.equal(same.status, 'unchanged');
    const changed = await h.planning('start')({ sessionId: SESSION, brief: { planTitle: '计划 B' } });
    assert.equal(changed.status, 'updated');
    const claimed = await h.planning('claim')({ sessionId: SESSION });
    assert.match(claimed.snapshot, /计划 B/);
  });

  it('keeps the injected snapshot for the rest of the conversation', async t => {
    const h = await boot(t);
    await h.planning('start')({ sessionId: SESSION, brief: { planTitle: '计划 A' } });
    await h.planning('claim')({ sessionId: SESSION });
    const again = await h.planning('start')({ sessionId: SESSION, brief: { planTitle: '计划 B' } });
    assert.equal(again.status, 'exists');
    assert.equal(again.injected, true);
    const second = await h.planning('claim')({ sessionId: SESSION });
    assert.equal(second.claimed, false);
    const { link } = await h.planning('get')({ sessionId: SESSION });
    assert.notEqual(link.injectedAt, null);
  });

  it('closes a link without touching messages and survives a restart', async t => {
    const h = await boot(t, { cleanup: false });
    await h.planning('start')({ sessionId: SESSION, brief: { planTitle: '计划 A' } });
    await h.fiber.dispose();
    const reopened = await boot(t, { directory: h.directory, cleanup: false });
    const claimed = await reopened.planning('claim')({ sessionId: SESSION });
    assert.equal(claimed.claimed, true);
    const closed = await reopened.planning('close')({ sessionId: SESSION });
    assert.equal(closed.closed, true);
    const { link } = await reopened.planning('get')({ sessionId: SESSION });
    assert.equal(link, null);
    assert.equal((await reopened.planning('claim')({ sessionId: SESSION })).claimed, false);
    await reopened.fiber.dispose();
    await rm(h.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('rejects malformed identities and fields', async t => {
    const h = await boot(t);
    const cases = [
      [{ sessionId: '', brief: {} }, 'sessionId'],
      [{ brief: {} }, 'sessionId'],
      [{ sessionId: SESSION, brief: { planTitle: 'A' }, extra: true }, 'extra'],
      [{ sessionId: SESSION, brief: { dailyMinutes: 2000 } }, 'dailyMinutes'],
      [{ sessionId: SESSION, brief: { materialIds: 'material_1' } }, 'materialIds'],
      [{ sessionId: SESSION, brief: { unknown: 'x' } }, 'unknown'],
    ];
    for (const [payload, field] of cases) {
      const failure = await h.fail('planning', 'start', payload);
      assert.equal(failure.code, 'invalid', `${field} should be rejected: ${JSON.stringify(failure)}`);
      assert.equal(failure.details.field, field);
    }
  });
});

describe('planning context injection', () => {
  it('appends the snapshot once, in the first step of the first turn', async t => {
    const h = await boot(t);
    await h.planning('start')({ sessionId: SESSION, brief: { planTitle: '计划 A' } });
    assert.deepEqual(await h.planning('pending')({ sessionId: SESSION }), { pending: true, sessionId: SESSION });

    const first = await h.preStep({ agent: { id: SESSION }, turn: 1, step: 1 });
    assert.equal(first.kind, 'enter');
    assert.equal(first.messages.length, 1);
    const message = first.messages[0];
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, 'study-planning');
    assert.equal(message.source.form, 'instructions');
    assert.match(message.content[0].text, /计划 A/);
    assert.deepEqual(await h.planning('pending')({ sessionId: SESSION }), { pending: false, sessionId: SESSION });

    const second = await h.preStep({ agent: { id: SESSION }, turn: 1, step: 2 });
    assert.equal(second.messages.length, 0);

    const laterTurn = await h.preStep({ agent: { id: SESSION }, turn: 2, step: 1 });
    assert.equal(laterTurn.messages.length, 0);
  });

  it('leaves an unlinked session and a claimed link untouched', async t => {
    const h = await boot(t);
    const unlinked = await h.preStep({ agent: { id: 'other-session' }, turn: 1, step: 1 });
    assert.equal(unlinked.messages.length, 0);

    await h.planning('start')({ sessionId: SESSION, brief: { planTitle: '计划 A' } });
    await h.planning('claim')({ sessionId: SESSION });
    const claimed = await h.preStep({ agent: { id: SESSION }, turn: 1, step: 1 });
    assert.equal(claimed.messages.length, 0);
  });

  it('does not commit a write for a conversation that never started here', async t => {
    const h = await boot(t);
    const before = (await h.ok('kernel', 'status')).revision;
    const decision = await h.preStep({ agent: { id: 'plain-session' }, turn: 1, step: 1 });
    assert.equal(decision.messages.length, 0);
    const after = (await h.ok('kernel', 'status')).revision;
    assert.equal(after, before);
  });
});
