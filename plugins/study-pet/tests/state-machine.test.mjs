import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PET_SCENES,
  createPetState,
  normalizeSessions,
  reducePetState,
  resolveScene,
} from '../client/state-machine.js';

const T0 = 1_000_000;
const TIMINGS = { sleepAfterMs: 20_000, celebrateMs: 6_000 };

/** @param {Array<[string, object]>} [entries] @returns {Map} Session status snapshot. */
function statusMap(entries = []) {
  return new Map(entries);
}

/** @param {object} state @param {number} at @returns {{ state: object, effects: object[] }} */
function tick(state, at) {
  return reducePetState(state, { type: 'tick', at }, TIMINGS);
}

/** @param {object} state @param {Map} sessions @param {number} at @returns {{ state: object, effects: object[] }} */
function sessions(state, map, at) {
  return reducePetState(state, { type: 'sessions', sessions: map, at }, TIMINGS);
}

/** @param {object} state @param {object | null} session @param {number} at @returns {{ state: object, effects: object[] }} */
function timer(state, session, at) {
  return reducePetState(state, { type: 'timer', timer: { session, lastFinished: null }, at }, TIMINGS);
}

/** @param {object} [patch] @returns {object} Timer session view. */
function timerSession(patch = {}) {
  return {
    id: 'timer_1',
    kind: 'study',
    phase: 'running',
    task: null,
    remainingMs: 60_000,
    endedAt: null,
    ...patch,
  };
}

/** @param {object} effects @param {string} scene @returns {boolean} */
function speaks(effects, scene) {
  return effects.some(effect => effect.type === 'speak' && effect.scene === scene);
}

describe('pet scene machine', () => {
  it('starts idle and only exposes the documented scenes', () => {
    const state = createPetState(T0);
    assert.equal(state.scene, 'idle');
    assert.deepEqual([...PET_SCENES].sort(), [
      'celebrate', 'dragging', 'error', 'idle', 'rest', 'sleep', 'think', 'working',
    ].sort());
    assert.equal(Object.isFrozen(state), true);
  });

  it('maps a running Session to working and a pending interaction to think', () => {
    const running = sessions(createPetState(T0), statusMap([['s1', { running: true }]]), T0 + 1000);
    assert.equal(running.state.scene, 'working');
    assert.equal(speaks(running.effects, 'working'), true);

    const pending = sessions(running.state, statusMap([['s1', {
      running: true,
      pendingInteraction: { key: 'k', kind: 'approval', sessionId: 's1' },
    }]]), T0 + 2000);
    assert.equal(pending.state.scene, 'think');
    assert.equal(speaks(pending.effects, 'think'), true);
  });

  it('treats completionUnread alone as no completion edge', () => {
    const result = sessions(createPetState(T0), statusMap([['s1', { running: false, completionUnread: true }]]), T0 + 1000);
    assert.equal(result.state.scene, 'idle');
    assert.equal(speaks(result.effects, 'done'), false);
  });

  it('fires done exactly once on a running true to false edge', () => {
    const started = sessions(createPetState(T0), statusMap([['s1', { running: true }]]), T0 + 1000);
    const finished = sessions(started.state, statusMap([['s1', { running: false, completionUnread: true }]]), T0 + 2000);
    assert.equal(finished.state.scene, 'celebrate');
    assert.equal(speaks(finished.effects, 'done'), true);

    const repeated = sessions(finished.state, statusMap([['s1', { running: false, completionUnread: true }]]), T0 + 3000);
    assert.equal(speaks(repeated.effects, 'done'), false);

    const stillRunning = sessions(started.state, statusMap([['s1', { running: true }]]), T0 + 4000);
    assert.equal(speaks(stillRunning.effects, 'done'), false);
  });

  it('lets a running timer outrank idle sleep and maps rest', () => {
    const state = createPetState(T0);
    const study = timer(state, timerSession(), T0 + 30_000);
    assert.equal(study.state.scene, 'working');
    assert.equal(speaks(study.effects, 'timerStart'), true);

    const rest = timer(study.state, timerSession({ id: 'timer_2', kind: 'rest' }), T0 + 40_000);
    assert.equal(rest.state.scene, 'rest');
    assert.equal(speaks(rest.effects, 'timerStart'), false);
  });

  it('maps an interrupted timer to error once and clears it on resume', () => {
    const interrupted = timer(createPetState(T0), timerSession({ phase: 'interrupted' }), T0 + 1000);
    assert.equal(interrupted.state.scene, 'error');
    assert.equal(speaks(interrupted.effects, 'error'), true);

    const repeated = timer(interrupted.state, timerSession({ phase: 'interrupted' }), T0 + 2000);
    assert.equal(speaks(repeated.effects, 'error'), false);

    const resumed = timer(repeated.state, timerSession({ phase: 'running' }), T0 + 3000);
    assert.equal(resumed.state.scene, 'working');
  });

  it('celebrates one fresh timer finish and ignores an old one', () => {
    const fresh = timer(createPetState(T0), timerSession({
      phase: 'finished',
      endedAt: new Date(T0 + 5000).toISOString(),
      outcome: 'completed',
    }), T0 + 6000);
    assert.equal(fresh.state.scene, 'celebrate');
    assert.equal(speaks(fresh.effects, 'timerFinish'), true);

    const repeated = timer(fresh.state, timerSession({
      phase: 'finished',
      endedAt: new Date(T0 + 5000).toISOString(),
      outcome: 'completed',
    }), T0 + 7000);
    assert.equal(speaks(repeated.effects, 'timerFinish'), false);

    const old = timer(createPetState(T0), timerSession({
      phase: 'finished',
      endedAt: new Date(T0 - 3_600_000).toISOString(),
      outcome: 'completed',
    }), T0 + 1000);
    assert.equal(speaks(old.effects, 'timerFinish'), false);
    assert.equal(old.state.scene, 'idle');
  });

  it('falls asleep after 20 s without a gesture and greets on wake', () => {
    const awake = tick(createPetState(T0), T0 + 19_999);
    assert.equal(awake.state.scene, 'idle');

    const asleep = tick(awake.state, T0 + 20_000);
    assert.equal(asleep.state.scene, 'sleep');

    const woken = reducePetState(asleep.state, { type: 'interact', at: T0 + 60_000 }, TIMINGS);
    assert.equal(woken.state.scene, 'idle');
    assert.equal(speaks(woken.effects, 'greet'), true);
    assert.equal(woken.state.lastInteractionAt, T0 + 60_000);
  });

  it('never sleeps while a Session runs, but sleeps once it is idle again', () => {
    const running = sessions(createPetState(T0), statusMap([['s1', { running: true }]]), T0 + 1000);
    const late = tick(running.state, T0 + 60_000);
    assert.equal(late.state.scene, 'working');

    const stopped = sessions(late.state, statusMap([['s1', { running: false }]]), T0 + 61_000);
    assert.equal(stopped.state.scene, 'celebrate');
    const afterCelebration = tick(stopped.state, T0 + 68_000);
    assert.equal(afterCelebration.state.scene, 'sleep');
  });

  it('lets dragging override every other scene', () => {
    const running = sessions(createPetState(T0), statusMap([['s1', { running: true }]]), T0 + 1000);
    const dragged = reducePetState(running.state, { type: 'dragging', value: true, at: T0 + 2000 }, TIMINGS);
    assert.equal(dragged.state.scene, 'dragging');
    const released = reducePetState(dragged.state, { type: 'dragging', value: false, at: T0 + 3000 }, TIMINGS);
    assert.equal(released.state.scene, 'working');
  });

  it('normalizes snapshots and ignores malformed entries', () => {
    const facts = normalizeSessions(new Map([
      ['s1', { running: true, pendingInteraction: null }],
      ['s2', null],
      ['s3', { pendingInteraction: { key: 'k' } }],
    ]));
    assert.deepEqual(facts, {
      s1: { running: true, pendingInteraction: false },
      s3: { running: false, pendingInteraction: true },
    });
    assert.deepEqual(normalizeSessions(undefined), {});
    assert.equal(resolveScene(createPetState(T0), T0, TIMINGS), 'idle');
  });
});
