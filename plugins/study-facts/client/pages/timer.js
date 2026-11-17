/**
 * Timer page: a local pomodoro clock with adjustable study and rest lengths and
 * an optional task link.
 *
 * The host owns the clock and the session state, so the page never invents
 * elapsed time. It polls `POST /api/study/timer/status` once a second while
 * mounted, renders the host's remaining time, and sends explicit start / pause /
 * resume / finish / confirm calls. A finished timer never completes the task;
 * the page says so on screen.
 *
 * `TimerView` is pure and `formatClock` is exported, so Node tests cover every
 * rendered state without a browser or a renderer.
 */
import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react';
import {
  BADGE_STYLE, BUTTON_ACTIVE_STYLE, BUTTON_PRIMARY_STYLE, BUTTON_STYLE, CARD_ALERT_STYLE, CARD_STYLE,
  ERROR_STYLE, FIELD_STYLE, FIELDS_STYLE, FONT_MONO, HEADER_STYLE, INPUT_STYLE, MESSAGE_STYLE, NOTE_STYLE,
  ROOT_STYLE, RULE_STYLE, SECTION_HEADING_STYLE, SUBHEADING_STYLE, SUBTITLE_STYLE, TITLE_STYLE, TOOLBAR_STYLE,
  WARNING_CARD_STYLE, WARNING_STYLE, contentStyle,
} from '../../../../packages/study-client/ui.js';

const POLL_MS = 1_000;
const IDLE_POLL_MS = 5_000;
const MIN_MINUTES = 1;
const MAX_MINUTES = 180;
const MINUTE_MS = 60_000;

/** The countdown: large mono tabular figures, baseline-aligned with the label. */
const CLOCK_STYLE = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '10px',
  fontFamily: FONT_MONO,
  fontVariantNumeric: 'tabular-nums',
};
const CLOCK_VALUE_STYLE = {
  fontFamily: FONT_MONO,
  fontVariantNumeric: 'tabular-nums',
  fontSize: '38px',
  fontWeight: 400,
  lineHeight: 1.1,
  letterSpacing: '-0.02em',
};
/** The page body under the header; the outer column already carries the page gap. */
const BODY_STYLE = { display: 'flex', flexDirection: 'column', gap: '18px' };
/** Interruption title keeps the mono micro-label voice but reads as a warning. */
const INTERRUPTION_TITLE_STYLE = { ...SUBHEADING_STYLE, color: WARNING_STYLE.color };

/** One discovered page: contract consumed by `client/plugin.js`. */
export default {
  key: 'timer',
  order: 15,
  label: 'timer.panel',
  Page: TimerPage,
};

/**
 * Format a duration as `mm:ss`. Negative and non-finite values render as 00:00.
 * @param {number} ms - Milliseconds.
 * @returns {string} Clock text.
 */
export function formatClock(ms) {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  const totalSeconds = Math.floor(total / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Page body: owns the polled status, the two forms, and the explicit writes.
 * @param {{ t: Function, call: Function }} props - Locale seat and study route caller.
 * @returns {object} Page element.
 */
function TimerPage({ t, call }) {
  const [view, setView] = useState({ phase: 'loading' });
  const [taskOptions, setTaskOptions] = useState({ phase: 'loading', tasks: [] });
  const [settingsDraft, setSettingsDraft] = useState({ studyMinutes: '', restMinutes: '' });
  const [kind, setKind] = useState('study');
  const [minutes, setMinutes] = useState('');
  const [taskId, setTaskId] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pollMs, setPollMs] = useState(IDLE_POLL_MS);
  const initialized = useMemo(() => ({ settings: false }), []);
  const loadSequence = useMemo(() => ({ current: 0 }), []);

  const load = useCallback(async (options = {}) => {
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    if (!options.silent) setView({ phase: 'loading' });
    try {
      const envelope = await call('timer', 'status', {});
      if (sequence !== loadSequence.current) return;
      const value = envelope.value;
      if (!initialized.settings) {
        initialized.settings = true;
        setSettingsDraft({
          studyMinutes: String(value.settings.studyMinutes),
          restMinutes: String(value.settings.restMinutes),
        });
        setMinutes(String(value.settings.studyMinutes));
      }
      setView({ phase: 'ready', value });
      const active = value.session !== null && value.session.phase !== 'finished';
      setPollMs(active ? POLL_MS : IDLE_POLL_MS);
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      const message = describeError(t, error);
      setView(current => (current.phase === 'ready' && options.silent
        ? { ...current, error: message }
        : { phase: 'error', message }));
    }
  }, [call, initialized, loadSequence, t]);

  const loadTasks = useCallback(async () => {
    try {
      const envelope = await call('tasks', 'listTasks', {});
      setTaskOptions({ phase: 'ready', tasks: envelope.value.tasks });
    } catch (error) {
      setTaskOptions({ phase: 'error', tasks: [], message: describeError(t, error) });
    }
  }, [call, t]);

  useEffect(() => { void load(); void loadTasks(); }, [load, loadTasks]);

  useEffect(() => {
    const handle = setInterval(() => { void load({ silent: true }); }, pollMs);
    return () => clearInterval(handle);
  }, [load, pollMs]);

  const write = useCallback(async (method, payload, options = {}) => {
    setBusy(true);
    try {
      await call('timer', method, { requestId: requestId(), ...payload });
      setNotice(options.success ?? null);
      await load({ silent: true });
      return true;
    } catch (error) {
      setNotice(t(options.errorKey ?? 'timer.notice.writeFailed', { message: describeError(t, error) }));
      return false;
    } finally {
      setBusy(false);
    }
  }, [call, load, t]);

  const saveSettings = useCallback(async () => {
    const study = Number(settingsDraft.studyMinutes);
    const rest = Number(settingsDraft.restMinutes);
    if (!validMinutes(study) || !validMinutes(rest)) {
      setNotice(t('timer.settings.invalid'));
      return;
    }
    const saved = await write('updateSettings', { studyMinutes: study, restMinutes: rest }, { success: t('timer.settings.saved') });
    if (saved) setMinutes(String(kind === 'study' ? study : rest));
  }, [kind, settingsDraft, t, write]);

  const changeKind = useCallback(nextKind => {
    setKind(nextKind);
    const draft = nextKind === 'study' ? settingsDraft.studyMinutes : settingsDraft.restMinutes;
    if (validMinutes(Number(draft))) setMinutes(String(Number(draft)));
  }, [settingsDraft]);

  const startSession = useCallback(async () => {
    const length = Number(minutes);
    if (!validMinutes(length)) {
      setNotice(t('timer.start.invalid'));
      return;
    }
    const payload = { kind, minutes: length };
    if (kind === 'study' && taskId !== '') payload.taskId = taskId;
    await write('start', payload, { errorKey: 'timer.notice.startFailed' });
  }, [kind, minutes, taskId, t, write]);

  const session = view.phase === 'ready' ? view.value.session : null;
  const sessionId = session === null ? null : session.id;

  const pause = useCallback(() => {
    if (sessionId !== null) void write('pause', { id: sessionId });
  }, [sessionId, write]);

  const resume = useCallback(() => {
    if (sessionId !== null) void write('resume', { id: sessionId });
  }, [sessionId, write]);

  const finish = useCallback(() => {
    if (sessionId !== null) void write('finish', { id: sessionId });
  }, [sessionId, write]);

  const confirmResume = useCallback(() => {
    if (sessionId !== null) void write('confirm', { id: sessionId, action: 'resume' });
  }, [sessionId, write]);

  const confirmFinish = useCallback(() => {
    if (sessionId !== null) void write('confirm', { id: sessionId, action: 'finish' });
  }, [sessionId, write]);

  return TimerView({
    create: h,
    t,
    view,
    taskOptions,
    settingsDraft,
    kind,
    minutes,
    taskId,
    notice,
    busy,
    onRetry: () => { setNotice(null); void load(); },
    onSettingsDraft: (field, value) => setSettingsDraft(current => ({ ...current, [field]: value })),
    onSaveSettings: saveSettings,
    onKind: changeKind,
    onMinutes: setMinutes,
    onTask: setTaskId,
    onStart: startSession,
    onPause: pause,
    onResume: resume,
    onFinish: finish,
    onConfirmResume: confirmResume,
    onConfirmFinish: confirmFinish,
  });
}

/**
 * Render one state of the timer page.
 * @param {object} props - Render inputs; see the page body for producers.
 * @returns {object} Section element.
 */
export function TimerView(props) {
  const { create, t, view, notice } = props;
  return create('section', { 'data-testid': 'study-timer', 'data-page': 'timer', 'data-study-page': '', style: ROOT_STYLE },
    create('div', { style: contentStyle(840) },
      create('header', null,
        create('h1', { style: TITLE_STYLE }, t('timer.title')),
        create('p', { style: SUBTITLE_STYLE }, t('timer.subtitle')),
        create('p', { style: RULE_STYLE }, t('timer.rule'))),
      notice === null ? null : create('p', { 'data-testid': 'timer-notice', role: 'status', style: MESSAGE_STYLE }, notice),
      renderBody(create, t, view, props.onRetry),
      view.phase === 'ready' ? renderReady(create, t, props) : null));
}

/** Render the loading, error, or nothing for a ready view. */
function renderBody(create, t, view, onRetry) {
  if (view.phase === 'loading') {
    return create('p', { 'data-testid': 'study-loading', role: 'status', style: MESSAGE_STYLE }, t('timer.loading'));
  }
  if (view.phase === 'error') {
    return create('div', { style: CARD_ALERT_STYLE },
      create('p', { 'data-testid': 'study-error', role: 'alert', style: ERROR_STYLE }, t('common.error', { message: view.message })),
      create('div', { style: TOOLBAR_STYLE },
        create('button', { type: 'button', 'data-testid': 'timer-retry', style: BUTTON_STYLE, onClick: onRetry }, t('timer.retry'))));
  }
  return null;
}

/** Render the loaded page: settings, the session, the start form, and the last session. */
function renderReady(create, t, props) {
  const value = props.view.value;
  const session = value.session;
  const canStart = session === null || session.phase === 'finished';
  return create('div', { style: BODY_STYLE },
    props.view.error === undefined
      ? null
      : create('p', { 'data-testid': 'timer-error-banner', role: 'alert', style: ERROR_STYLE }, t('common.error', { message: props.view.error })),
    renderSettings(create, t, props),
    session === null ? null : renderSession(create, t, props, session),
    canStart ? renderStartForm(create, t, props) : null,
    value.lastFinished === null ? null : renderLastFinished(create, t, value.lastFinished),
  );
}

/** Render the study/rest duration settings. */
function renderSettings(create, t, props) {
  const { settingsDraft, busy } = props;
  return create('div', { 'data-testid': 'timer-settings', style: CARD_STYLE },
    create('h2', { style: SECTION_HEADING_STYLE }, t('timer.settings.title')),
    create('div', { style: FIELDS_STYLE },
      field(create, t('timer.settings.study'), create('input', {
        'data-testid': 'timer-settings-study',
        name: 'studyMinutes',
        type: 'number',
        min: MIN_MINUTES,
        max: MAX_MINUTES,
        step: 1,
        value: settingsDraft.studyMinutes,
        style: INPUT_STYLE,
        onChange: event => props.onSettingsDraft('studyMinutes', event.target.value),
      })),
      field(create, t('timer.settings.rest'), create('input', {
        'data-testid': 'timer-settings-rest',
        name: 'restMinutes',
        type: 'number',
        min: MIN_MINUTES,
        max: MAX_MINUTES,
        step: 1,
        value: settingsDraft.restMinutes,
        style: INPUT_STYLE,
        onChange: event => props.onSettingsDraft('restMinutes', event.target.value),
      }))),
    create('div', { style: TOOLBAR_STYLE },
      create('button', {
        type: 'button',
        'data-testid': 'timer-settings-save',
        style: BUTTON_STYLE,
        disabled: busy,
        onClick: props.onSaveSettings,
      }, t('timer.settings.save'))));
}

/** Render the start form with the kind toggle, the duration, and the optional task. */
function renderStartForm(create, t, props) {
  const { kind, minutes, taskId, taskOptions, busy } = props;
  return create('form', {
    'data-testid': 'timer-start-card',
    style: CARD_STYLE,
    onSubmit: event => { event.preventDefault(); props.onStart(); },
  },
  create('h2', { style: SECTION_HEADING_STYLE }, t('timer.start.title')),
  create('div', { style: TOOLBAR_STYLE },
    create('button', {
      type: 'button',
      'data-testid': 'timer-kind-study',
      style: kind === 'study' ? BUTTON_ACTIVE_STYLE : BUTTON_STYLE,
      'aria-pressed': kind === 'study',
      onClick: () => props.onKind('study'),
    }, t('timer.kind.study')),
    create('button', {
      type: 'button',
      'data-testid': 'timer-kind-rest',
      style: kind === 'rest' ? BUTTON_ACTIVE_STYLE : BUTTON_STYLE,
      'aria-pressed': kind === 'rest',
      onClick: () => props.onKind('rest'),
    }, t('timer.kind.rest'))),
  create('div', { style: FIELDS_STYLE },
    field(create, t('timer.start.minutes'), create('input', {
      'data-testid': 'timer-minutes',
      name: 'minutes',
      type: 'number',
      min: MIN_MINUTES,
      max: MAX_MINUTES,
      step: 1,
      value: minutes,
      style: INPUT_STYLE,
      onChange: event => props.onMinutes(event.target.value),
    })),
    kind === 'study'
      ? field(create, t('timer.start.task'), create('select', {
        'data-testid': 'timer-task',
        name: 'taskId',
        value: taskId,
        style: INPUT_STYLE,
        onChange: event => props.onTask(event.target.value),
      },
      create('option', { value: '' }, t('timer.start.noTask')),
      taskOptions.tasks.map(task => create('option', { key: task.id, value: task.id }, task.title))))
      : null),
  create('p', { style: NOTE_STYLE }, taskOptions.phase === 'error' ? t('timer.tasks.failed') : t('timer.start.hint')),
  create('div', { style: TOOLBAR_STYLE },
    create('button', { type: 'submit', 'data-testid': 'timer-start', style: BUTTON_PRIMARY_STYLE, disabled: busy }, t('timer.start.action'))));
}

/** Render the active or finished session with the actions its phase allows. */
function renderSession(create, t, props, session) {
  const finished = session.phase === 'finished';
  return create('div', { 'data-testid': 'timer-session', style: CARD_STYLE },
    create('div', { style: HEADER_STYLE },
      create('h2', { style: SECTION_HEADING_STYLE }, t('timer.current.title')),
      create('div', { style: TOOLBAR_STYLE },
        create('span', { 'data-testid': 'timer-kind', style: BADGE_STYLE }, t(`timer.kind.${session.kind}`)),
        create('span', { 'data-testid': 'timer-phase', style: BADGE_STYLE }, t(`timer.phase.${session.phase}`)))),
    finished
      ? renderFinishedSummary(create, t, session)
      : create('div', { style: CLOCK_STYLE },
        create('strong', { 'data-testid': 'timer-clock', style: CLOCK_VALUE_STYLE }, formatClock(session.remainingMs)),
        create('span', { style: NOTE_STYLE }, t('timer.session.remaining'))),
    create('p', { 'data-testid': 'timer-focus', style: MESSAGE_STYLE }, t('timer.session.focus', {
      focused: formatClock(session.focusedMs),
      planned: formatClock(session.plannedMs),
    })),
    session.task === null
      ? null
      : create('p', { 'data-testid': 'timer-session-task', style: MESSAGE_STYLE },
        t('timer.session.task', { title: session.task.title }),
        session.task.deleted
          ? create('span', { 'data-testid': 'timer-task-deleted', style: NOTE_STYLE }, t('timer.session.taskDeleted'))
          : null),
    session.interruption === null || finished ? null : renderInterruption(create, t, session),
    renderActions(create, t, props, session));
}

/** Render the interruption explanation and the two confirmation choices. */
function renderInterruption(create, t, session) {
  return create('div', { style: WARNING_CARD_STYLE },
    create('h3', { style: INTERRUPTION_TITLE_STYLE }, t('timer.interrupted.title')),
    create('p', { 'data-testid': 'timer-interruption', style: MESSAGE_STYLE }, t('timer.interrupted.gap', {
      minutes: Math.max(1, Math.round(session.interruption.gapMs / MINUTE_MS)),
    })),
    session.interruption.reason === 'restart'
      ? create('p', { style: NOTE_STYLE }, t('timer.interrupted.restart'))
      : null);
}

/** Render the outcome and the on-screen rule that a finished timer is not a completed task. */
function renderFinishedSummary(create, t, session) {
  return create('div', null,
    create('p', { 'data-testid': 'timer-outcome', style: MESSAGE_STYLE }, t(session.outcome === 'completed' ? 'timer.outcome.completed' : 'timer.outcome.ended')),
    create('p', { style: NOTE_STYLE }, t('timer.finished.note')));
}

/** Render the buttons the session's phase allows; a busy page disables them. */
function renderActions(create, t, props, session) {
  const { busy } = props;
  const button = (id, label, onClick) => create('button', {
    type: 'button',
    'data-testid': id,
    style: BUTTON_STYLE,
    disabled: busy,
    onClick,
  }, label);
  if (session.phase === 'running') {
    return create('div', { style: TOOLBAR_STYLE },
      button('timer-pause', t('timer.pause'), props.onPause),
      button('timer-finish', t('timer.finish'), props.onFinish));
  }
  if (session.phase === 'paused') {
    return create('div', { style: TOOLBAR_STYLE },
      button('timer-resume', t('timer.resume'), props.onResume),
      button('timer-finish', t('timer.finish'), props.onFinish));
  }
  if (session.phase === 'interrupted') {
    return create('div', { style: TOOLBAR_STYLE },
      button('timer-confirm-resume', t('timer.continue'), props.onConfirmResume),
      button('timer-confirm-finish', t('timer.finishConfirmed'), props.onConfirmFinish));
  }
  if (session.outcome === 'completed') {
    return create('div', { style: TOOLBAR_STYLE },
      button('timer-record', t('timer.record'), props.onFinish));
  }
  return null;
}

/** Render the most recent finished session below the active one. */
function renderLastFinished(create, t, session) {
  return create('p', { 'data-testid': 'timer-last', style: NOTE_STYLE }, t('timer.last.line', {
    minutes: Math.max(0, Math.round(session.focusedMs / MINUTE_MS)),
  }));
}

/** Wrap one labelled control. */
function field(create, label, control) {
  return create('label', { style: FIELD_STYLE },
    create('span', null, label),
    control);
}

/** Whether a value is one of the accepted minute lengths. */
function validMinutes(value) {
  return Number.isSafeInteger(value) && value >= MIN_MINUTES && value <= MAX_MINUTES;
}

/** Add a fresh request id so a retried write cannot apply twice. */
function requestId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `timer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Pick the text shown for a failed call: a localized line for transport failures, the host's message otherwise. */
function describeError(t, error) {
  if (error instanceof Error && error.code === 'network') {
    return t === undefined ? 'the study service is unreachable' : t('common.networkError');
  }
  return error instanceof Error ? error.message : String(error);
}
