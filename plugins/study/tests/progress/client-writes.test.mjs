/**
 * T06 write-path evidence: the guarded write runner that sends the page's
 * revision, classifies stale-revision and overlap conflicts, keeps the retry
 * payload, reloads the latest data, and refuses a second concurrent click.
 * The runner is plain async code, so these tests use fake state and service
 * callers instead of a renderer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StudyCallError } from '../../client/lib/api.js';
import { installReactStub } from '../client/support/react-stub.mjs';

installReactStub();

const {
  runGuardedWrite,
  buildWrite,
  classifyWriteFailure,
  summarizeProgress,
} = await import('../../client/pages/workbench.js');
const { mergeMessages } = await import('../../client/lib/definitions.js');
const common = (await import('../../client/messages/common.js')).default;
const workbench = (await import('../../client/messages/workbench.js')).default;
const dictionary = mergeMessages([{ file: 'common', dictionary: common }, { file: 'workbench', dictionary: workbench }]);

/**
 * Translate one key with the real dictionary.
 * @param {string} key - Key.
 * @param {object} [params] - Placeholders.
 * @returns {string} Copy.
 */
function t(key, params) {
  const template = dictionary.zh[key] ?? dictionary.en[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

const TASK_A = {
  id: 'task_a', title: '数学分析', subject: null, materialRef: null, completionCriteria: null,
  estimatedMinutes: 60, prerequisiteIds: [], prerequisites: [], deletedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
};
const BLOCK_A = {
  id: 'block_a', date: '2026-11-11', start: '10:00', end: '11:00', startMinute: 600, endMinute: 660,
  minutes: 60, fixed: false, taskId: TASK_A.id, title: null, note: null,
  task: { id: TASK_A.id, title: TASK_A.title, subject: null, deleted: false },
  createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
};
const BLOCK_B = {
  ...BLOCK_A,
  id: 'block_b',
  date: '2026-11-12',
  start: '09:00',
  end: '10:00',
  startMinute: 540,
  endMinute: 600,
};
const VIEW = {
  phase: 'ready',
  revision: 5,
  value: {
    date: '2026-11-11',
    weekday: 3,
    weekStart: '2026-11-09',
    weekEnd: '2026-11-15',
    blocks: [BLOCK_A],
    tasks: [TASK_A],
    unscheduledTaskIds: [],
    summary: { study: { blockCount: 1, minuteCount: 60, taskCount: 1 }, fixed: { blockCount: 0, minuteCount: 0, taskCount: 0 } },
    progress: {},
    completion: summarizeProgress([TASK_A], {}),
  },
};

/**
 * Build one runtime around a mutable view and recorded side effects.
 * @param {object} options - Overrides for the call/load implementations.
 * @returns {object} Runtime plus its ledger.
 */
function runtime({ call, load, busy = { current: false }, kind = 'block.move', payload = { id: BLOCK_A.id, date: '2026-11-12' } } = {}) {
  const ledger = { views: [], stales: [], notices: [], calls: [], loads: [] };
  const state = { view: VIEW };
  const base = {
    getView: () => state.view,
    setView: next => {
      state.view = typeof next === 'function' ? next(state.view) : next;
      ledger.views.push(state.view);
    },
    setStale: value => ledger.stales.push(value),
    setNotice: value => ledger.notices.push(value),
    call: async (ns, method, body) => {
      ledger.calls.push({ ns, method, body });
      return call(ns, method, body);
    },
    load: async (mode, date, options) => {
      ledger.loads.push({ mode, date, options });
      if (load !== undefined) return load(mode, date, options);
      state.view = { ...state.view, revision: state.view.revision + 1 };
      return undefined;
    },
    t,
    busy,
    kind,
    payload,
    build: (writeKind, writePayload, snapshot) => buildWrite(writeKind, writePayload, snapshot, 'day', '2026-11-11'),
  };
  return { runtime: base, state, ledger };
}

describe('classifyWriteFailure', () => {
  it('separates stale revisions, overlaps, and ordinary failures', () => {
    assert.equal(classifyWriteFailure(new StudyCallError('conflict', 'stale', { details: { revision: 7 } })), 'stale');
    assert.equal(classifyWriteFailure(new StudyCallError('conflict', 'overlap', { details: { reason: 'overlap' } })), 'overlap');
    assert.equal(classifyWriteFailure(new StudyCallError('conflict', 'same request id', { details: {} })), 'failed');
    assert.equal(classifyWriteFailure(new StudyCallError('invalid', 'bad fields', {})), 'failed');
    assert.equal(classifyWriteFailure(new Error('boom')), 'failed');
  });
});

describe('runGuardedWrite', () => {
  it('sends the page revision and refreshes after a committed write', async () => {
    const kit = runtime({
      call: async () => ({ ok: true, value: { moved: true }, revision: 6 }),
    });
    const result = await runGuardedWrite(kit.runtime);
    assert.equal(result.ok, true);
    assert.equal(kit.ledger.calls.length, 1);
    assert.equal(kit.ledger.calls[0].ns, 'tasks');
    assert.equal(kit.ledger.calls[0].method, 'moveBlock');
    assert.equal(kit.ledger.calls[0].body.expectedRevision, 5);
    assert.match(kit.ledger.calls[0].body.requestId, /\S+/);
    assert.equal(kit.ledger.loads.length, 1);
    assert.equal(kit.ledger.loads[0].date, '2026-11-12', '跨日移动后跟随到新的一天');
    assert.deepEqual(kit.ledger.stales.filter(Boolean), []);
    assert.deepEqual(kit.ledger.notices, []);
  });

  it('keeps the latest data and a retry payload when the revision is stale', async () => {
    let attempt = 0;
    const kit = runtime({
      call: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new StudyCallError('conflict', '学习数据已更新到修订 6，本次提交基于旧版本，请重新读取', {
            details: { expectedRevision: 5, revision: 6 },
          });
        }
        return { ok: true, value: { moved: true }, revision: 7 };
      },
    });
    kit.runtime.load = async (mode, date, options) => {
      kit.ledger.loads.push({ mode, date, options });
      kit.state.view = { ...VIEW, revision: 6 };
    };

    const stale = await runGuardedWrite(kit.runtime);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'stale');
    assert.equal(kit.ledger.loads.length, 1, '过期提交后要重新读取');
    assert.equal(kit.state.view.revision, 6);
    const decisions = kit.ledger.stales.filter(Boolean);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].kind, 'stale');
    assert.match(decisions[0].message, /修订 6/);
    assert.deepEqual(decisions[0].retry, {
      kind: 'block.move',
      payload: { id: BLOCK_A.id, date: '2026-11-12' },
    });
    assert.deepEqual(kit.ledger.notices, [], '并发失效不是普通保存失败');

    const retried = await runGuardedWrite({ ...kit.runtime, getView: () => kit.state.view });
    assert.equal(retried.ok, true);
    assert.equal(kit.ledger.calls[1].body.expectedRevision, 6, '重提使用重新读取后的修订号');
    assert.notEqual(kit.ledger.calls[1].body.requestId, kit.ledger.calls[0].body.requestId, '重提必须是新的请求 id');
  });

  it('asks for an explicit keep when the host reports an overlap', async () => {
    const conflicts = [{ id: BLOCK_B.id, start: '09:00', end: '10:00', title: null, fixed: false }];
    const kit = runtime({
      call: async () => {
        throw new StudyCallError('conflict', '这个时间与 1 个时间块重叠', {
          details: { reason: 'overlap', date: '2026-11-12', conflicts },
        });
      },
    });
    const result = await runGuardedWrite(kit.runtime);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'overlap');
    assert.equal(kit.ledger.loads.length, 0, '未确认的冲突不刷新也不保存');
    assert.deepEqual(kit.ledger.notices, []);
    const decision = kit.ledger.stales.filter(Boolean)[0];
    assert.equal(decision.kind, 'overlap');
    assert.deepEqual(decision.conflicts, conflicts);
    assert.equal(decision.retry.payload.allowOverlap, true);
    assert.deepEqual(kit.ledger.views.at(-1), VIEW, '冲突时恢复原状态');
  });

  it('restores the snapshot and reports ordinary failures', async () => {
    const kit = runtime({
      call: async () => {
        throw new StudyCallError('invalid', '结束时间必须晚于开始时间', { details: { field: 'end' } });
      },
    });
    const result = await runGuardedWrite(kit.runtime);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'failed');
    assert.deepEqual(kit.ledger.stales.filter(Boolean), []);
    assert.equal(kit.ledger.notices.length, 1);
    assert.match(kit.ledger.notices[0], /保存失败/);
    assert.match(kit.ledger.notices[0], /结束时间必须晚于开始时间/);
    assert.equal(kit.ledger.views.at(-1).error, '结束时间必须晚于开始时间');
  });

  it('ignores a second click while the first write is in flight', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const kit = runtime({
      call: async () => {
        calls += 1;
        await gate;
        return { ok: true, value: {}, revision: 6 };
      },
    });
    const first = runGuardedWrite(kit.runtime);
    const second = await runGuardedWrite(kit.runtime);
    assert.equal(second.ok, false);
    assert.equal(second.skipped, 'busy');
    assert.equal(kit.ledger.calls.length, 1);
    release();
    assert.equal((await first).ok, true);
    assert.equal(calls, 1, '一次点击只发一次写请求');
    assert.equal(kit.runtime.busy.current, false);
  });

  it('releases the busy guard after a rejected write', async () => {
    const kit = runtime({
      call: async () => { throw new StudyCallError('unavailable', '服务不可用', {}); },
    });
    await runGuardedWrite(kit.runtime);
    assert.equal(kit.runtime.busy.current, false);
    const again = await runGuardedWrite(kit.runtime);
    assert.equal(again.ok, false);
    assert.equal(kit.ledger.calls.length, 2, '失败后用户可以再次提交');
  });
});

describe('buildWrite', () => {
  it('moves only the selected block in the optimistic view', () => {
    const built = buildWrite('block.move', { id: BLOCK_A.id, date: '2026-11-12' }, VIEW, 'day', '2026-11-11');
    assert.equal(built.method, 'moveBlock');
    assert.deepEqual(built.body, { id: BLOCK_A.id, date: '2026-11-12' });
    assert.equal(built.refreshMode, 'day');
    assert.equal(built.refreshDate, '2026-11-12');
    const optimistic = built.optimistic;
    assert.equal(optimistic.value.tasks[0].id, TASK_A.id, '任务身份不变');
    assert.equal(optimistic.value.blocks.length, 0, '当天视图里只剩移走的块');
  });

  it('keeps the week view and moves the block into the target day', () => {
    const week = {
      phase: 'ready',
      revision: 5,
      value: {
        startDate: '2026-11-09',
        endDate: '2026-11-15',
        days: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'].map(date => ({
          date, weekday: 1, blocks: [], summary: { study: { blockCount: 0, minuteCount: 0, taskCount: 0 }, fixed: { blockCount: 0, minuteCount: 0, taskCount: 0 } },
        })),
        tasks: [TASK_A],
        unscheduledTaskIds: [TASK_A.id],
        summary: { study: { blockCount: 0, minuteCount: 0, taskCount: 0 }, fixed: { blockCount: 0, minuteCount: 0, taskCount: 0 } },
        progress: {},
        completion: summarizeProgress([TASK_A], {}),
      },
    };
    week.value.days[2].blocks = [BLOCK_A];
    const built = buildWrite('block.move', { id: BLOCK_A.id, date: '2026-11-12' }, week, 'week', '2026-11-09');
    assert.equal(built.refreshMode, 'week');
    const target = built.optimistic.value.days.find(day => day.date === '2026-11-12');
    assert.deepEqual(target.blocks.map(block => block.id), [BLOCK_A.id]);
    assert.equal(target.blocks[0].taskId, TASK_A.id);
  });

  it('builds a progress write and its optimistic completion', () => {
    const built = buildWrite('progress.record', {
      taskId: TASK_A.id, status: 'done', confirmed: true,
    }, VIEW, 'day', '2026-11-11');
    assert.equal(built.method, 'recordProgress');
    assert.equal(built.body.status, 'done');
    assert.equal(built.optimistic.value.progress[TASK_A.id].status, 'done');
    assert.equal(built.optimistic.value.completion.completion.completedTasks, 1);
    assert.equal(built.optimistic.value.completion.completion.rate, 1);
  });

  it('returns null for an unknown kind or a missing entity', () => {
    assert.equal(buildWrite('mystery.write', {}, VIEW, 'day', '2026-11-11'), null);
    assert.equal(buildWrite('block.update', { id: 'block_missing', start: '09:00' }, VIEW, 'day', '2026-11-11'), null);
  });
});
