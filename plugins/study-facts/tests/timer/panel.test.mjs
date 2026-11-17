/**
 * Timer page: the contribution shape, the countdown helpers, and every state
 * the student can see, in both languages. `TimerView` is pure, so the React
 * stub renders it into a plain tree without a browser.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installReactStub } from '../../../study-outcomes/tests/client/support/react-stub.mjs';

installReactStub();

const { default: page, TimerView, formatClock } = await import('../../client/pages/timer.js');
const { mergeMessages } = await import('../../../../packages/study-client/definitions.js');
const common = (await import('../../../../packages/study-messages/common.js')).default;
const timerMessages = (await import('../../client/messages/timer.js')).default;

const MINUTE = 60_000;
const dictionary = mergeMessages([
  { file: 'common', dictionary: common },
  { file: 'timer', dictionary: timerMessages },
]);

/**
 * Translate one key with the real dictionary.
 * @param {'en' | 'zh'} locale - Active locale.
 * @returns {(key: string, params?: object) => string} Translator.
 */
function translator(locale) {
  return (key, params) => {
    const template = dictionary[locale][key] ?? dictionary.en[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

/** Record every element as a plain node so the tree can be walked. */
const create = (type, props, ...children) => ({ type, props: props ?? {}, children });

/**
 * Collect the text of one rendered tree.
 * @param {unknown} node - Element node, string, or array.
 * @returns {string} Concatenated text.
 */
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.children);
}

/**
 * Find every element by predicate.
 * @param {unknown} node - Element node, string, or array.
 * @param {(node: object) => boolean} predicate - Test.
 * @returns {object[]} Matches.
 */
function findAll(node, predicate) {
  const matches = [];
  if (node === null || typeof node !== 'object') return matches;
  if (Array.isArray(node)) {
    for (const child of node) matches.push(...findAll(child, predicate));
    return matches;
  }
  if (predicate(node)) matches.push(node);
  for (const child of node.children) matches.push(...findAll(child, predicate));
  return matches;
}

/**
 * Find one element by its test id.
 * @param {unknown} tree - Rendered tree.
 * @param {string} id - `data-testid` value.
 * @returns {object | undefined} First match.
 */
function byTestId(tree, id) {
  return findAll(tree, node => node.props['data-testid'] === id)[0];
}

const NOW = '2026-11-10T01:00:00.000Z';
const TASK = { id: 'task_1', title: '数学分析 第3章', deleted: false };

/**
 * Build a session view as the host serves it.
 * @param {object} overrides - Fields to replace.
 * @returns {object} Session view.
 */
function sessionOf(overrides = {}) {
  return {
    id: 'timer_1',
    kind: 'study',
    phase: 'running',
    task: TASK,
    plannedMinutes: 25,
    plannedMs: 25 * MINUTE,
    focusedMs: 30_000,
    remainingMs: 25 * MINUTE - 30_000,
    progress: 0.02,
    startedAt: NOW,
    resumedAt: NOW,
    lastSeenAt: NOW,
    endedAt: null,
    outcome: null,
    interruption: null,
    ...overrides,
  };
}

/**
 * Build a ready status value.
 * @param {object} overrides - Fields to replace.
 * @returns {object} Status value.
 */
function valueOf(overrides = {}) {
  return {
    now: NOW,
    settings: { studyMinutes: 25, restMinutes: 5 },
    session: sessionOf(),
    lastFinished: null,
    ...overrides,
  };
}

const noop = () => {};

/**
 * Build the render props.
 * @param {object} overrides - Fields to replace.
 * @returns {object} View props.
 */
function props(overrides = {}) {
  return {
    create,
    t: translator('zh'),
    view: { phase: 'ready', value: valueOf() },
    taskOptions: { phase: 'ready', tasks: [TASK] },
    settingsDraft: { studyMinutes: '25', restMinutes: '5' },
    kind: 'study',
    minutes: '25',
    taskId: '',
    notice: null,
    busy: false,
    onRetry: noop,
    onSettingsDraft: noop,
    onSaveSettings: noop,
    onKind: noop,
    onMinutes: noop,
    onTask: noop,
    onStart: noop,
    onPause: noop,
    onResume: noop,
    onFinish: noop,
    onConfirmResume: noop,
    onConfirmFinish: noop,
    ...overrides,
  };
}

/** Render one state as text. */
const render = overrides => text(TimerView(props(overrides)));

describe('timer page definition', () => {
  it('contributes the timer page with a paired dictionary label', () => {
    assert.equal(page.key, 'timer');
    assert.equal(page.label, 'timer.panel');
    assert.equal(typeof page.Page, 'function');
    assert.equal(typeof page.order, 'number');
    assert.equal(dictionary.zh['timer.panel'], '番茄钟');
    assert.equal(dictionary.en['timer.panel'], 'Pomodoro');
  });

  it('formats the countdown as minutes and seconds and never goes negative', () => {
    assert.equal(formatClock(25 * MINUTE), '25:00');
    assert.equal(formatClock(59_000), '00:59');
    assert.equal(formatClock(0), '00:00');
    assert.equal(formatClock(-5_000), '00:00');
    assert.equal(formatClock(65 * MINUTE + 7_000), '65:07');
  });
});

describe('timer page states', () => {
  it('renders the loading and error states with a retry action', () => {
    const loading = TimerView(props({ view: { phase: 'loading' } }));
    assert.ok(byTestId(loading, 'study-loading'));

    const error = text(TimerView(props({ view: { phase: 'error', message: '数据库不可用' } })));
    assert.match(error, /数据库不可用/);
    assert.ok(byTestId(TimerView(props({ view: { phase: 'error', message: 'x' } })), 'timer-retry'));
  });

  it('renders durations, the optional task link, and the start action when idle', () => {
    const tree = TimerView(props({ view: { phase: 'ready', value: valueOf({ session: null }) } }));
    const textOf = text(tree);
    assert.match(textOf, /番茄钟/);
    assert.match(textOf, /时长设置/);
    assert.match(textOf, /学习时长/);
    assert.match(textOf, /休息时长/);
    assert.match(textOf, /不关联任务/);
    assert.match(textOf, /数学分析 第3章/);
    assert.ok(byTestId(tree, 'timer-settings-study'));
    assert.ok(byTestId(tree, 'timer-settings-rest'));
    assert.ok(byTestId(tree, 'timer-minutes'));
    assert.ok(byTestId(tree, 'timer-start'));
    assert.ok(byTestId(tree, 'timer-kind-study'));
    assert.ok(byTestId(tree, 'timer-kind-rest'));
  });

  it('renders a running session with the remaining time, task, and pause/end actions', () => {
    const tree = TimerView(props());
    const textOf = text(tree);
    assert.match(textOf, /当前计时/);
    assert.match(textOf, /计时中/);
    assert.match(textOf, /24:30/);
    assert.match(textOf, /数学分析 第3章/);
    assert.ok(byTestId(tree, 'timer-pause'));
    assert.ok(byTestId(tree, 'timer-finish'));
    assert.equal(byTestId(tree, 'timer-start'), undefined);
  });

  it('renders a paused session with a resume action and a frozen clock', () => {
    const tree = TimerView(props({
      view: {
        phase: 'ready',
        value: valueOf({
          session: sessionOf({ phase: 'paused', resumedAt: null, focusedMs: 5 * MINUTE, remainingMs: 20 * MINUTE }),
        }),
      },
    }));
    assert.match(text(tree), /已暂停/);
    assert.match(text(tree), /20:00/);
    assert.ok(byTestId(tree, 'timer-resume'));
    assert.ok(byTestId(tree, 'timer-finish'));
  });

  it('asks the student to confirm an interrupted session', () => {
    const tree = TimerView(props({
      view: {
        phase: 'ready',
        value: valueOf({
          session: sessionOf({
            phase: 'interrupted',
            resumedAt: null,
            focusedMs: 2 * MINUTE,
            remainingMs: 23 * MINUTE,
            interruption: { at: NOW, gapMs: 10 * MINUTE, reason: 'restart' },
          }),
        }),
      },
    }));
    const textOf = text(tree);
    assert.match(textOf, /计时中断/);
    assert.match(textOf, /10 分钟/);
    assert.match(textOf, /不计入专注时长/);
    assert.ok(byTestId(tree, 'timer-confirm-resume'));
    assert.ok(byTestId(tree, 'timer-confirm-finish'));
    assert.equal(byTestId(tree, 'timer-pause'), undefined);
    assert.equal(byTestId(tree, 'timer-start'), undefined);
  });

  it('renders a finished session without claiming the task is done, then offers a new one', () => {
    const tree = TimerView(props({
      view: {
        phase: 'ready',
        value: valueOf({
          session: sessionOf({
            phase: 'finished',
            resumedAt: null,
            focusedMs: 25 * MINUTE,
            remainingMs: 0,
            endedAt: NOW,
            outcome: 'completed',
          }),
        }),
      },
    }));
    const textOf = text(tree);
    assert.match(textOf, /已完成/);
    assert.match(textOf, /计时结束不会自动完成任务/);
    assert.match(textOf, /专注 25:00 · 计划 25:00/);
    assert.ok(byTestId(tree, 'timer-record'));
    assert.ok(byTestId(tree, 'timer-start'));
  });

  it('marks a deleted linked task and shows the last finished session', () => {
    const tree = TimerView(props({
      view: {
        phase: 'ready',
        value: valueOf({
          session: sessionOf({ task: { id: 'task_1', title: '旧任务', deleted: true } }),
          lastFinished: sessionOf({
            id: 'timer_0',
            phase: 'finished',
            resumedAt: null,
            focusedMs: 20 * MINUTE,
            remainingMs: 0,
            endedAt: NOW,
            outcome: 'ended',
          }),
        }),
      },
    }));
    const textOf = text(tree);
    assert.match(textOf, /任务已删除/);
    assert.match(textOf, /上次专注 20 分钟/);
  });

  it('renders English copy from the dictionary', () => {
    const textOf = render({ t: translator('en') });
    assert.match(textOf, /Pomodoro timer/);
    assert.match(textOf, /Timing is not completion/);
    assert.match(textOf, /Current session/);
    assert.match(textOf, /Running/);
    assert.match(textOf, /Pause/);
  });

  it('surfaces a write failure as a notice', () => {
    const textOf = render({ notice: '操作失败：计时已在进行中' });
    assert.match(textOf, /操作失败：计时已在进行中/);
    assert.ok(byTestId(TimerView(props({ notice: 'x' })), 'timer-notice'));
  });
});
