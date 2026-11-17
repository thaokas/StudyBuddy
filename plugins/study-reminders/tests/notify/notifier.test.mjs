/**
 * Completion detection and announcement: one reminder per finished turn, one
 * merged reminder for completions landing together, a page-level fallback when
 * the system notification cannot be used, and no repeat after a reload.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../../../study-outcomes/tests/client/support/react-stub.mjs';
import {
  BLOCKED_AREA, clock, gateway, listOf, memoryArea, sessionList, settle, translator,
} from './support.mjs';

// The module's browser entry imports React for its components; the reminder
// core under test never renders. The stub must be installed before that import
// is resolved.
installReactStub();
const {
  ANNOUNCED_KEY, BANNER_DURATION_MS, ENABLED_KEY, MERGE_WINDOW_MS, createCompletionNotifier,
} = await import('../../client/notify.js');

/**
 * Assemble a notifier over the virtual clock and recording edges.
 * @param {{ sessions?: object, gateway?: object, storage?: object, focus?: Function,
 *   isWatching?: Function }} [overrides] - Edge overrides.
 * @returns {object} Harness with the notifier, its edges, and `observe`/`advance` shortcuts.
 */
function harness(overrides = {}) {
  const time = clock();
  const local = overrides.storage?.local ?? memoryArea();
  const session = overrides.storage?.session ?? memoryArea();
  const permissions = overrides.gateway ?? gateway();
  const sessions = overrides.sessions ?? sessionList(listOf([]));
  const focused = [];
  const notifier = createCompletionNotifier({
    translate: translator(),
    gateway: permissions,
    storage: { local, session },
    timer: time.timer,
    now: time.now,
    focus: overrides.focus ?? (sessionId => { focused.push(sessionId); }),
    isWatching: overrides.isWatching ?? (() => false),
  });
  const observe = (rows) => {
    const next = listOf(rows);
    sessions.set(next);
    notifier.observe(next);
    return next;
  };
  return { notifier, time, local, session, permissions, sessions, focused, observe };
}

describe('completion detection', () => {
  it('announces one finished turn exactly once', () => {
    const b = harness();
    b.observe([{ id: 's1', running: true }]);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 0);

    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    const state = b.notifier.source.getSnapshot();
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0].sessionId, 's1');
    assert.equal(b.permissions.shown.length, 1);

    // The same still-idle snapshot arriving again is not another completion.
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(b.permissions.shown.length, 1);
    assert.equal(b.notifier.source.getSnapshot().seq, 1);
  });

  it('announces each later turn of the same session', () => {
    const b = harness();
    b.observe([{ id: 's1', running: true, updatedAt: 10 }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    b.observe([{ id: 's1', running: true, updatedAt: 20 }]);
    b.observe([{ id: 's1', running: false, updatedAt: 20 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(b.permissions.shown.length, 2);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 1);
  });

  it('ignores subagent rows', () => {
    const b = harness();
    const next = listOf([{ id: 'child', running: true, origin: 'subagent' }]);
    b.sessions.set(next);
    b.notifier.observe(next);
    const done = listOf([{ id: 'child', running: false, origin: 'subagent' }]);
    b.sessions.set(done);
    b.notifier.observe(done);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(b.permissions.shown.length, 0);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 0);
  });

  it('starts from the observed baseline without a reminder', () => {
    const b = harness();
    // First observation already shows an idle session: no turn ended here.
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(b.permissions.shown.length, 0);
  });
});

describe('merging', () => {
  it('merges three sessions finishing together into one reminder', () => {
    const b = harness();
    b.observe([
      { id: 's1', running: true, updatedAt: 10, displayTitle: 'Algebra' },
      { id: 's2', running: true, updatedAt: 11, displayTitle: 'Physics' },
      { id: 's3', running: true, updatedAt: 12, displayTitle: 'History' },
    ]);
    b.observe([
      { id: 's1', running: false, updatedAt: 10, displayTitle: 'Algebra' },
      { id: 's2', running: false, updatedAt: 11, displayTitle: 'Physics' },
      { id: 's3', running: false, updatedAt: 12, displayTitle: 'History' },
    ]);
    b.time.advance(MERGE_WINDOW_MS);

    const state = b.notifier.source.getSnapshot();
    assert.equal(state.entries.length, 3);
    assert.deepEqual(state.entries.map(entry => entry.title), ['Algebra', 'Physics', 'History']);
    assert.equal(b.permissions.shown.length, 1);
    assert.match(b.permissions.shown[0].body, /^3 sessions finished replying$/);
    assert.equal(b.permissions.shown[0].tag, 'study.completion', '合并后的系统通知只占一个位置');
  });

  it('keeps completions from separate windows apart', () => {
    const b = harness();
    b.observe([{ id: 's1', running: true }, { id: 's2', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }, { id: 's2', running: true }]);
    b.time.advance(MERGE_WINDOW_MS);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }, { id: 's2', running: false, updatedAt: 11 }]);
    b.time.advance(MERGE_WINDOW_MS);

    assert.equal(b.permissions.shown.length, 2);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 1);
    assert.equal(b.notifier.source.getSnapshot().entries[0].sessionId, 's2');
  });

  it('dismisses the banner after its display window', () => {
    const b = harness();
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 1);
    b.time.advance(BANNER_DURATION_MS);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 0);
  });
});

describe('fallback', () => {
  it('keeps the in-app banner when the browser has no notification API', () => {
    const b = harness({ gateway: gateway({ supported: false }) });
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);

    const state = b.notifier.source.getSnapshot();
    assert.equal(state.entries.length, 1, '页内提示必须仍然出现');
    assert.equal(state.osStatus, 'unsupported');
    assert.equal(b.permissions.shown.length, 0);
  });

  it('keeps the in-app banner when permission is denied, without re-prompting', () => {
    const permissions = gateway({ permission: 'denied' });
    const b = harness({ gateway: permissions });
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);

    const state = b.notifier.source.getSnapshot();
    assert.equal(state.entries.length, 1);
    assert.equal(state.osStatus, 'denied');
    assert.deepEqual(permissions.requests, []);

    b.observe([{ id: 's1', running: true, updatedAt: 20 }]);
    b.observe([{ id: 's1', running: false, updatedAt: 20 }]);
    b.time.advance(MERGE_WINDOW_MS);
    return settle().then(() => {
      assert.deepEqual(permissions.requests, [], '拒绝后不再请求权限');
    });
  });

  it('asks for permission once when the browser has not decided', async () => {
    const permissions = gateway({ permission: 'default', grant: 'denied' });
    const b = harness({ gateway: permissions });
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    await settle();

    assert.deepEqual(permissions.requests, ['default']);
    assert.equal(b.notifier.source.getSnapshot().osStatus, 'denied');
    assert.equal(b.notifier.source.getSnapshot().entries.length, 1);
    assert.equal(permissions.shown.length, 0);
  });

  it('shows a system notification when permission is granted', async () => {
    const b = harness({ gateway: gateway({ permission: 'default', grant: 'granted' }) });
    b.observe([{ id: 's1', running: true, displayTitle: 'Algebra' }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10, displayTitle: 'Algebra' }]);
    b.time.advance(MERGE_WINDOW_MS);
    await settle();

    assert.equal(b.notifier.source.getSnapshot().osStatus, 'granted');
    assert.equal(b.permissions.shown.length, 1);
    assert.equal(b.permissions.shown[0].title, 'StudyBuddy');
    assert.match(b.permissions.shown[0].body, /Algebra/);
    assert.equal(b.permissions.shown[0].tag, 'study.completion');
  });
});

describe('reload and dedupe ledger', () => {
  it('does not repeat a completion that was already announced before a reload', () => {
    const storage = { local: memoryArea(), session: memoryArea() };
    const first = harness({ storage });
    first.observe([{ id: 's1', running: true, updatedAt: 10 }]);
    first.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    first.time.advance(MERGE_WINDOW_MS);
    assert.equal(first.permissions.shown.length, 1);
    assert.match(storage.session.getItem(ANNOUNCED_KEY), /"s1":10/);

    // Reload: a fresh notifier sees the idle session as its baseline.
    const second = harness({ storage });
    second.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    second.time.advance(MERGE_WINDOW_MS);
    assert.equal(second.permissions.shown.length, 0);
    assert.equal(second.notifier.source.getSnapshot().entries.length, 0);
  });

  it('does not repeat when the same finished turn is observed twice', () => {
    const storage = { local: memoryArea(), session: memoryArea() };
    const first = harness({ storage });
    first.observe([{ id: 's1', running: true, updatedAt: 10 }]);
    first.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    first.time.advance(MERGE_WINDOW_MS);

    // A second controller (for example a remounted plugin) did see the run.
    const second = harness({ storage });
    second.observe([{ id: 's1', running: true, updatedAt: 10 }]);
    second.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    second.time.advance(MERGE_WINDOW_MS);
    assert.equal(second.permissions.shown.length, 0);
  });

  it('survives a blocked storage area', () => {
    const b = harness({ storage: { local: BLOCKED_AREA, session: BLOCKED_AREA } });
    assert.equal(b.notifier.source.getSnapshot().enabled, true);
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(b.permissions.shown.length, 1);
  });
});

describe('switch', () => {
  it('stops reminding when turned off and remembers the choice', () => {
    const storage = { local: memoryArea(), session: memoryArea() };
    const b = harness({ storage });
    b.notifier.setEnabled(false);
    assert.equal(b.notifier.source.getSnapshot().enabled, false);
    assert.equal(storage.local.getItem(ENABLED_KEY), '0');

    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(b.permissions.shown.length, 0);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 0);

    const reloaded = harness({ storage });
    assert.equal(reloaded.notifier.source.getSnapshot().enabled, false);
    reloaded.notifier.setEnabled(true);
    reloaded.observe([{ id: 's1', running: true, updatedAt: 20 }]);
    reloaded.observe([{ id: 's1', running: false, updatedAt: 20 }]);
    reloaded.time.advance(MERGE_WINDOW_MS);
    assert.equal(reloaded.permissions.shown.length, 1);
  });

  it('asks for system permission when the student switches reminders on', async () => {
    const permissions = gateway({ permission: 'default', grant: 'granted' });
    const b = harness({ gateway: permissions });
    b.notifier.setEnabled(false);
    b.notifier.setEnabled(true);
    await settle();
    assert.deepEqual(permissions.requests, ['default']);
    assert.equal(b.notifier.source.getSnapshot().osStatus, 'granted');
  });

  it('clears a pending banner when turned off', () => {
    const b = harness();
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 1);
    b.notifier.setEnabled(false);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 0);
  });
});

describe('navigation and dismissal', () => {
  it('opens the finished session and clears the banner', () => {
    const b = harness();
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);

    b.notifier.focus('s1');
    assert.deepEqual(b.focused, ['s1']);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 0);
    assert.equal(b.notifier.source.getSnapshot().focusable, true);
  });

  it('omits the navigation capability when nothing can open a session', () => {
    const notifier = createCompletionNotifier({
      translate: translator(),
      gateway: gateway(),
      storage: { local: memoryArea(), session: memoryArea() },
      timer: clock().timer,
    });
    assert.equal(notifier.source.getSnapshot().focusable, false);
    assert.doesNotThrow(() => notifier.focus('s1'));
  });

  it('dismisses without opening anything', () => {
    const b = harness();
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    b.notifier.dismiss();
    assert.equal(b.notifier.source.getSnapshot().entries.length, 0);
    assert.deepEqual(b.focused, []);
  });

  it('notifies every subscriber and stops after dispose', () => {
    const b = harness();
    let calls = 0;
    const unsubscribe = b.notifier.source.subscribe(() => { calls += 1; });
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.ok(calls > 0);

    unsubscribe();
    const before = calls;
    b.notifier.dismiss();
    b.observe([{ id: 's1', running: true, updatedAt: 20 }]);
    b.observe([{ id: 's1', running: false, updatedAt: 20 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(calls, before);

    b.notifier.dispose();
    assert.equal(b.notifier.source.getSnapshot().entries.length, 0);
  });

  it('skips the session the student is already looking at', () => {
    const b = harness({ isWatching: sessionId => sessionId === 's1' });
    b.observe([{ id: 's1', running: true }]);
    b.observe([{ id: 's1', running: false, updatedAt: 10 }]);
    b.time.advance(MERGE_WINDOW_MS);
    assert.equal(b.permissions.shown.length, 0);
    assert.equal(b.notifier.source.getSnapshot().entries.length, 0);
  });
});
