/**
 * Restart and interruption recovery: a timer that was running when the app
 * stopped must come back interrupted, credit only the time the app actually
 * observed, and wait for the student's decision. Suspended time is never added
 * to the focused total.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MINUTE, bootTimer, createClock } from './helpers.mjs';

/**
 * All interruption entries recorded for the timer namespace.
 * @param {object} harness - Booted timer fixture.
 * @returns {Array<{ action: string, actor: string }>} Change-log rows.
 */
function timerChanges(harness) {
  return harness.database
    .all("SELECT action, actor FROM change_log WHERE entity = 'timer_session' ORDER BY id")
    .map(row => ({ action: String(row.action), actor: String(row.actor) }));
}

describe('restart recovery', () => {
  it('interrupts a running session after an exit and credits only observed time', async t => {
    const clock = createClock();
    const first = await bootTimer(t, { clock });
    const started = (await first.ok('timer', 'start', { kind: 'study' })).value.session;
    first.tick(5 * MINUTE);
    assert.equal((await first.ok('timer', 'status', {})).value.session.focusedMs, 5 * MINUTE);
    await first.close();

    clock.set('2026-11-10T01:20:00.000Z');
    const second = await bootTimer(t, { directory: first.directory, clock });
    const recovered = (await second.ok('timer', 'status', {})).value.session;
    assert.equal(recovered.id, started.id);
    assert.equal(recovered.phase, 'interrupted');
    assert.equal(recovered.focusedMs, 5 * MINUTE, '重启不得把关机的 15 分钟算进专注时长');
    assert.equal(recovered.interruption.reason, 'restart');
    assert.equal(recovered.interruption.gapMs, 15 * MINUTE);
    assert.equal(recovered.outcome, null);

    const pause = await second.fail('timer', 'pause', { id: started.id });
    assert.equal(pause.code, 'conflict');
    assert.equal(pause.details.reason, 'interruption_unconfirmed');

    const silentFinish = await second.fail('timer', 'finish', { id: started.id });
    assert.equal(silentFinish.code, 'conflict');
    assert.equal(silentFinish.details.reason, 'interruption_unconfirmed');
    assert.equal(silentFinish.details.interruption.gapMs, 15 * MINUTE);

    // The student confirms continuing: the gap is skipped, not counted.
    const resumed = (await second.ok('timer', 'confirm', { id: started.id, action: 'resume' })).value.session;
    assert.equal(resumed.phase, 'running');
    assert.equal(resumed.focusedMs, 5 * MINUTE);
    second.tick(2 * MINUTE);

    await second.close();
    clock.set('2026-11-10T01:40:00.000Z');
    const third = await bootTimer(t, { directory: first.directory, clock });
    const again = (await third.ok('timer', 'status', {})).value.session;
    assert.equal(again.phase, 'interrupted');
    assert.equal(again.focusedMs, 7 * MINUTE, '第二次重启同样不得虚增');
    assert.equal(again.interruption.gapMs, 18 * MINUTE);

    const finished = (await third.ok('timer', 'confirm', { id: started.id, action: 'finish' })).value.session;
    assert.equal(finished.phase, 'finished');
    assert.equal(finished.outcome, 'ended');
    assert.equal(finished.focusedMs, 7 * MINUTE);
    assert.equal((await third.ok('timer', 'status', {})).value.session.phase, 'finished');
    assert.equal(timerChanges(third).filter(row => row.action === 'interrupt').length, 2);
    await third.close();
  });

  it('keeps a completed timer completed across a restart', async t => {
    const clock = createClock();
    const first = await bootTimer(t, { clock });
    const started = (await first.ok('timer', 'start', { kind: 'study', minutes: 1 })).value.session;
    first.tick(2 * MINUTE);
    assert.equal((await first.ok('timer', 'status', {})).value.session.phase, 'finished');
    await first.close();

    clock.set('2026-11-10T03:00:00.000Z');
    const second = await bootTimer(t, { directory: first.directory, clock });
    const status = (await second.ok('timer', 'status', {})).value;
    assert.equal(status.session.id, started.id);
    assert.equal(status.session.phase, 'finished');
    assert.equal(status.session.outcome, 'completed');
    assert.equal(status.session.focusedMs, MINUTE);
    assert.equal(status.session.interruption, null);

    const next = (await second.ok('timer', 'start', { kind: 'rest' })).value.session;
    assert.equal(next.phase, 'running');
    await second.close();
  });

  it('keeps a paused session paused across a restart', async t => {
    const clock = createClock();
    const first = await bootTimer(t, { clock });
    const started = (await first.ok('timer', 'start', { kind: 'study' })).value.session;
    first.tick(2 * MINUTE);
    await first.ok('timer', 'pause', { id: started.id });
    await first.close();

    clock.set('2026-11-10T04:00:00.000Z');
    const second = await bootTimer(t, { directory: first.directory, clock });
    const session = (await second.ok('timer', 'status', {})).value.session;
    assert.equal(session.phase, 'paused');
    assert.equal(session.focusedMs, 2 * MINUTE);
    assert.equal(session.interruption, null);

    const resumed = (await second.ok('timer', 'resume', { id: started.id })).value.session;
    assert.equal(resumed.phase, 'running');
    await second.close();
  });

  it('asks for confirmation when the app was suspended without exiting', async t => {
    const harness = await bootTimer(t);
    const started = (await harness.ok('timer', 'start', { kind: 'study' })).value.session;
    harness.tick(2 * MINUTE);
    harness.sleep(10 * MINUTE);

    // The heartbeat fires after wake: the interval persists the interruption so
    // the next process, page, or restart sees the same fact.
    harness.tick(0);
    const row = harness.database.get('SELECT phase, interruption_reason FROM study_timer_session');
    assert.equal(row.phase, 'interrupted');
    assert.equal(row.interruption_reason, 'gap');

    const session = (await harness.ok('timer', 'status', {})).value.session;
    assert.equal(session.phase, 'interrupted');
    assert.equal(session.focusedMs, 2 * MINUTE);
    assert.equal(session.interruption.gapMs, 10 * MINUTE);

    const resumed = (await harness.ok('timer', 'confirm', { id: started.id, action: 'resume' })).value.session;
    assert.equal(resumed.phase, 'running');
    assert.equal(resumed.focusedMs, 2 * MINUTE);
    harness.tick(1 * MINUTE);
    const finished = (await harness.ok('timer', 'finish', { id: started.id })).value.session;
    assert.equal(finished.outcome, 'ended');
    assert.equal(finished.focusedMs, 3 * MINUTE);
  });

  it('rejects confirming a session that is not interrupted', async t => {
    const harness = await bootTimer(t);
    const started = (await harness.ok('timer', 'start', { kind: 'study' })).value.session;
    const conflict = await harness.fail('timer', 'confirm', { id: started.id, action: 'resume' });
    assert.equal(conflict.code, 'conflict');
    assert.equal(conflict.details.reason, 'not_interrupted');
    assert.equal(conflict.details.phase, 'running');

    const wrongAction = await harness.fail('timer', 'confirm', { id: started.id, action: 'pause' });
    assert.equal(wrongAction.code, 'invalid');
    assert.equal(wrongAction.details.field, 'action');
  });

  it('does not count a suspended gap when resuming from paused', async t => {
    const harness = await bootTimer(t);
    const started = (await harness.ok('timer', 'start', { kind: 'study' })).value.session;
    harness.tick(3 * MINUTE);
    await harness.ok('timer', 'pause', { id: started.id });
    harness.sleep(30 * MINUTE);
    const resumed = (await harness.ok('timer', 'resume', { id: started.id })).value.session;
    assert.equal(resumed.focusedMs, 3 * MINUTE);
    harness.tick(2 * MINUTE);
    const finished = (await harness.ok('timer', 'finish', { id: started.id })).value.session;
    assert.equal(finished.focusedMs, 5 * MINUTE);
  });
});
