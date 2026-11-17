/**
 * Workbench page: the student's day and week, task CRUD, time-block CRUD,
 * single-block drag, and task progress — without sending a message.
 *
 * The page offers two display modes. `full` is the editor described above;
 * `compact` replaces the old always-on middle column with today's summary and
 * schedule, and reads today independently through the same `tasks.day` route.
 * The choice is remembered in Web Storage and defaults to `full`.
 *
 * Every read and write goes through the study route (`POST /api/study/tasks/…`).
 * The page never opens `study.db`, never derives a task id from a display
 * position, and never counts fixed course/rest blocks as study work.
 *
 * Writes are optimistic: the new state is rendered first, a rejected write puts
 * the previous state back and shows the service message. Writes also send the
 * revision the page was rendered from; when another client already advanced it,
 * the page reloads the latest data and keeps a "submit again" action instead of
 * silently overwriting anything. A block drop that lands on another block is
 * offered as an explicit "keep overlap" decision, never saved silently.
 *
 * `WorkbenchView` is the pure part, and the exported state/write helpers are
 * pure or plain-async code, so Node tests cover the views, the rollback rule,
 * the conflict decisions, and the write runner without a browser.
 */
import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react';
import { createStorageArea, writeValue } from '../lib/storage.js';
import {
  BADGE_STYLE, BUTTON_ACTIVE_STYLE, BUTTON_PRIMARY_STYLE, BUTTON_STYLE, CARD_STYLE, ERROR_STYLE,
  FIELD_STYLE, FIELDS_STYLE, FONT_MONO, HEADER_STYLE, INPUT_STYLE, LIST_STYLE, MESSAGE_STYLE,
  META_STYLE, NOTE_STYLE, PENDING_STYLE, ROOT_STYLE, ROW_STYLE, SECTION_HEADING_STYLE,
  SUBHEADING_STYLE, SUBTITLE_STYLE, SUMMARY_BLOCK_STYLE, SUMMARY_LABEL_STYLE, SUMMARY_STYLE, TITLE_STYLE,
  TOOLBAR_STYLE, VALUE_STYLE, WARNING_CARD_STYLE, contentStyle,
} from '../../../../packages/study-client/ui.js';

/** Browser key holding the workbench display preference. */
export const DISPLAY_KEY = 'study.workbench.display';

/** Display modes offered by the workbench: the full editor or today's summary. */
export const DISPLAY_MODES = Object.freeze(['full', 'compact']);

/** Today's blocks shown before the compact view points at the full view. */
export const COMPACT_BLOCK_LIMIT = 6;

const WEEKDAY_KEYS = [
  'workbench.weekday.mon',
  'workbench.weekday.tue',
  'workbench.weekday.wed',
  'workbench.weekday.thu',
  'workbench.weekday.fri',
  'workbench.weekday.sat',
  'workbench.weekday.sun',
];

/** Task progress states, in the order the editor offers them. */
const PROGRESS_STATUSES = ['not_started', 'in_progress', 'partial', 'done', 'cancelled'];

/** Dictionary key for one stored progress state. */
const PROGRESS_STATUS_KEYS = {
  not_started: 'workbench.progress.status.notStarted',
  in_progress: 'workbench.progress.status.inProgress',
  partial: 'workbench.progress.status.partial',
  done: 'workbench.progress.status.done',
  cancelled: 'workbench.progress.status.cancelled',
};

/** Week view: days are tinted groups inside the schedule card, not wireframes. */
const DAY_GRID_STYLE = { display: 'flex', flexDirection: 'column', gap: '8px' };
const DAY_TINT = 'color-mix(in srgb, var(--dsw-alias-label-primary) 2.6%, transparent)';
const DAY_CARD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '12px 14px',
  borderRadius: '3px',
  background: DAY_TINT,
  boxSizing: 'border-box',
};
const DAY_ACTIVE_STYLE = {
  ...DAY_CARD_STYLE,
  boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent)',
};
const DAY_HEADER_STYLE = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '10px',
  flexWrap: 'wrap',
  alignItems: 'baseline',
};
const BLOCK_MAIN_STYLE = {
  display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'baseline',
  minWidth: '240px', flex: '1 1 320px',
};
const BLOCK_TIME_STYLE = {
  ...VALUE_STYLE,
  fontVariantNumeric: 'tabular-nums',
  flex: 'none',
};
const BANNER_STYLE = { ...WARNING_CARD_STYLE, gap: '8px' };
const OVERLAP_LIST_STYLE = { margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: 1.7 };
const DROP_ZONE_STYLE = {
  border: '1px dashed color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent)',
  borderRadius: '3px',
  padding: '8px 12px',
  fontFamily: FONT_MONO,
  fontSize: '10.5px',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--dsw-alias-label-tertiary)',
  flex: '1 1 180px',
  textAlign: 'center',
};
const TODO_CHECK_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  fontFamily: FONT_MONO,
  fontSize: '10.5px',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'nowrap',
};
const COMPACT_ROW_STYLE = {
  ...ROW_STYLE,
  justifyContent: 'flex-start',
  alignItems: 'baseline',
  gap: '10px',
  padding: '8px 0',
};
const COMPACT_TIME_STYLE = {
  ...VALUE_STYLE,
  fontVariantNumeric: 'tabular-nums',
  minWidth: '84px',
  flex: 'none',
};


/** One discovered page: contract consumed by `client/plugin.js`. */
export default {
  key: 'workbench',
  order: 10,
  label: 'workbench.panel',
  Page: WorkbenchPage,
};

/** An empty task form. */
function emptyTaskDraft() {
  return {
    title: '',
    subject: '',
    materialRef: '',
    completionCriteria: '',
    estimatedMinutes: '',
    prerequisites: [],
  };
}

/** A new time-block form for one date. */
function emptyBlockDraft(date) {
  return {
    id: null,
    date: date ?? '',
    start: '09:00',
    end: '10:00',
    fixed: false,
    taskId: '',
    title: '',
    note: '',
  };
}

/** Turn a stored task into form fields. */
function taskDraftFrom(task) {
  return {
    title: task.title,
    subject: task.subject ?? '',
    materialRef: task.materialRef ?? '',
    completionCriteria: task.completionCriteria ?? '',
    estimatedMinutes: task.estimatedMinutes === null ? '' : String(task.estimatedMinutes),
    prerequisites: [...task.prerequisiteIds],
  };
}

/** Turn a stored block into form fields. */
function blockDraftFrom(block) {
  return {
    id: block.id,
    date: block.date,
    start: block.start,
    end: block.end,
    fixed: block.fixed,
    taskId: block.taskId ?? '',
    title: block.title ?? '',
    note: block.note ?? '',
  };
}

/** Turn the latest progress (or its absence) into the inline editor fields. */
function progressDraftFrom(taskId, current) {
  const number = value => (value === null || value === undefined ? '' : String(value));
  return {
    taskId,
    status: current?.status ?? 'in_progress',
    quantityDone: number(current?.quantityDone),
    quantityTotal: number(current?.quantityTotal),
    note: current?.note ?? '',
  };
}

/** Normalize the task form into a service payload; `null` clears optional fields. */
function taskPayloadOf(draft) {
  return {
    title: draft.title.trim(),
    subject: draft.subject.trim() === '' ? null : draft.subject.trim(),
    materialRef: draft.materialRef.trim() === '' ? null : draft.materialRef.trim(),
    completionCriteria: draft.completionCriteria.trim() === '' ? null : draft.completionCriteria.trim(),
    estimatedMinutes: draft.estimatedMinutes.trim() === '' ? null : Number(draft.estimatedMinutes),
    prerequisites: [...draft.prerequisites],
  };
}

/** Normalize the block form into a service payload; `null` clears optional fields. */
function blockPayloadOf(draft) {
  return {
    date: draft.date,
    start: draft.start,
    end: draft.end,
    fixed: draft.fixed,
    taskId: draft.taskId === '' ? null : draft.taskId,
    title: draft.title.trim() === '' ? null : draft.title.trim(),
    note: draft.note.trim() === '' ? null : draft.note.trim(),
  };
}

/**
 * Read the saved display preference.
 * @param {{ getItem: (key: string) => string | null }} storage - Storage area.
 * @returns {'full' | 'compact'} The saved mode, or `full` when nothing valid is stored.
 */
export function readDisplayMode(storage) {
  const raw = storage?.getItem(DISPLAY_KEY);
  return DISPLAY_MODES.includes(raw) ? raw : 'full';
}

/**
 * Save the display preference.
 * @param {{ setItem: (key: string, value: string) => void }} storage - Storage area.
 * @param {'full' | 'compact'} display - Mode to save.
 * @returns {boolean} Whether the value was written.
 */
export function writeDisplayMode(storage, display) {
  if (!DISPLAY_MODES.includes(display)) return false;
  return writeValue(storage, DISPLAY_KEY, display);
}


/**
 * Page body: owns the loaded view, the two forms, and the optimistic writes.
 * @param {{ t: Function, call: Function, actions: object }} props
 *   Framework locale seat, the study route caller, and the action registry.
 * @returns {object} Page element.
 */
function WorkbenchPage({ t, call, actions, activity, studyRefresh }) {
  const { onStudyDataChanged } = studyRefresh;
  const [mode, setMode] = useState('day');
  const [date, setDate] = useState(null);
  const [view, setView] = useState({ phase: 'loading' });
  const [taskDraft, setTaskDraft] = useState(emptyTaskDraft);
  const [taskEditingId, setTaskEditingId] = useState(null);
  const [taskReplacingId, setTaskReplacingId] = useState(null);
  const [replacementOutcome, setReplacementOutcome] = useState(null);
  const [blockDraft, setBlockDraft] = useState(null);
  const [progressDraft, setProgressDraft] = useState(null);
  const [notice, setNotice] = useState(null);
  const [stale, setStale] = useState(null);
  const [drag, setDrag] = useState(null);
  const storage = useMemo(() => createStorageArea(), []);
  const [display, setDisplay] = useState(() => readDisplayMode(storage));
  // The compact display reads today independently of the full day/week range,
  // so browsing the full view never changes which day the overview shows.
  const [overview, setOverview] = useState({ phase: 'loading' });
  const loadSequence = useMemo(() => ({ current: 0 }), []);
  const overviewSequence = useMemo(() => ({ current: 0 }), []);
  // The write runner and the retry callback need the freshest view even when a
  // React state update has not re-rendered yet; the stub-friendly ref is a
  // plain memo object so Node tests and the browser see the same semantics.
  const viewRef = useMemo(() => ({ current: { phase: 'loading' } }), []);
  const busy = useMemo(() => ({ current: false }), []);

  const applyView = useCallback(next => {
    const resolved = typeof next === 'function' ? next(viewRef.current) : next;
    viewRef.current = resolved;
    setView(resolved);
  }, []);

  const load = useCallback(async (nextMode, nextDate, options = {}) => {
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    if (!options.silent) applyView({ phase: 'loading' });
    try {
      const payload = nextDate === null || nextDate === undefined ? {} : { date: nextDate };
      const envelope = await call('tasks', nextMode === 'week' ? 'week' : 'day', payload);
      if (sequence !== loadSequence.current) return;
      const value = await withOutcomeCompletion(call, envelope.value, nextMode);
      if (sequence !== loadSequence.current) return;
      setMode(nextMode);
      setDate(nextMode === 'week' ? value.startDate : value.date);
      applyView({ phase: 'ready', value, revision: envelope.revision });
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      const message = describeError(t, error);
      applyView(current => (current.phase === 'ready' && options.silent
        ? { ...current, error: message }
        : { phase: 'error', message }));
    }
  }, [applyView, call, loadSequence, t]);

  useEffect(() => { void load('day', null); }, [load]);

  const loadOverview = useCallback(async () => {
    const sequence = overviewSequence.current + 1;
    overviewSequence.current = sequence;
    setOverview(current => (current.phase === 'ready'
      ? { ...current, refreshing: true }
      : { phase: 'loading' }));
    try {
      const envelope = await call('tasks', 'day', {});
      if (sequence !== overviewSequence.current) return;
      const value = await withOutcomeCompletion(call, envelope.value, 'day');
      if (sequence !== overviewSequence.current) return;
      setOverview({ phase: 'ready', value, revision: envelope.revision });
    } catch (error) {
      if (sequence !== overviewSequence.current) return;
      setOverview({ phase: 'error', message: describeError(t, error) });
    }
  }, [call, overviewSequence, t]);

  useEffect(() => {
    if (display !== 'compact') return undefined;
    void loadOverview();
    return onStudyDataChanged(() => { void loadOverview(); });
  }, [display, loadOverview, onStudyDataChanged]);

  const changeDisplay = useCallback(next => {
    if (!DISPLAY_MODES.includes(next) || next === display) return;
    writeDisplayMode(storage, next);
    setDisplay(next);
    setNotice(null);
    setStale(null);
    // The full view stays mounted in memory while the compact view is shown;
    // re-read once when it becomes visible again so an external write is not
    // hidden behind stale data.
    if (next === 'full') void load(mode, date, { silent: true });
  }, [date, display, load, mode, storage]);

  const commit = useCallback((kind, payload) => runGuardedWrite({
    studyRefresh,
    getView: () => viewRef.current,
    setView: applyView,
    setStale,
    setNotice,
    call,
    load,
    t,
    busy,
    kind,
    payload,
    build: (writeKind, writePayload, snapshot) => buildWrite(writeKind, writePayload, snapshot, mode, date),
  }), [applyView, busy, call, date, load, mode, studyRefresh, t]);

  const changeMode = useCallback(nextMode => {
    if (nextMode === mode && view.phase === 'ready') return;
    setNotice(null);
    setStale(null);
    void load(nextMode, date);
  }, [date, load, mode, view.phase]);

  const move = useCallback(direction => {
    if (date === null) return;
    const delta = mode === 'week' ? direction * 7 : direction;
    setNotice(null);
    setStale(null);
    void load(mode, addDays(date, delta));
  }, [date, load, mode]);

  const goToday = useCallback(() => {
    setNotice(null);
    setStale(null);
    void load(mode, null);
  }, [load, mode]);

  const refresh = useCallback(() => {
    setStale(null);
    void load(mode, date, { silent: true });
  }, [date, load, mode]);

  const editTask = useCallback(task => {
    setTaskReplacingId(null);
    setTaskEditingId(task.id);
    setTaskDraft(taskDraftFrom(task));
    setNotice(null);
  }, []);

  const cancelTask = useCallback(() => {
    setTaskReplacingId(null);
    setTaskEditingId(null);
    setTaskDraft(emptyTaskDraft());
    setNotice(null);
  }, []);

  const replaceTask = useCallback(task => {
    setTaskEditingId(task.id);
    setTaskReplacingId(task.id);
    setTaskDraft({ ...taskDraftFrom(task), materialRef: '', completionCriteria: '' });
    setNotice(t('workbench.task.replaceNote'));
  }, [t]);

  const submitTask = useCallback(async event => {
    event.preventDefault();
    if (viewRef.current.phase !== 'ready') return;
    const payload = taskPayloadOf(taskDraft);
    if (payload.title.length === 0) {
      setNotice(t('workbench.task.titleRequired'));
      return;
    }
    if (payload.estimatedMinutes !== null
      && (!Number.isSafeInteger(payload.estimatedMinutes) || payload.estimatedMinutes < 0)) {
      setNotice(t('workbench.task.estimateInvalid'));
      return;
    }

    const editingId = taskEditingId;
    const result = await commit(
      taskReplacingId !== null ? 'task.replace' : editingId === null ? 'task.create' : 'task.update',
      editingId === null ? payload : { id: editingId, ...payload },
    );
    if (result.ok) {
      if (taskReplacingId !== null) setReplacementOutcome(result.value);
      setTaskEditingId(null);
      setTaskReplacingId(null);
      setTaskDraft(emptyTaskDraft());
      setNotice(taskReplacingId === null ? null : t('workbench.task.replaced', { count: result.value?.preservedProgress?.length ?? 0 }));
    }
  }, [commit, t, taskDraft, taskEditingId, taskReplacingId]);

  const removeTask = useCallback(async task => {
    if (viewRef.current.phase !== 'ready') return;
    if (!confirmAction(t('workbench.task.confirmDelete'))) return;
    const result = await commit('task.delete', { id: task.id });
    if (result.ok && taskEditingId === task.id) cancelTask();
  }, [cancelTask, commit, t, taskEditingId]);

  const addBlock = useCallback(() => {
    setBlockDraft(emptyBlockDraft(date));
    setNotice(null);
  }, [date]);

  const editBlock = useCallback(block => {
    setBlockDraft(blockDraftFrom(block));
    setNotice(null);
  }, []);

  const cancelBlock = useCallback(() => {
    setBlockDraft(null);
    setNotice(null);
  }, []);

  const submitBlock = useCallback(async event => {
    event.preventDefault();
    if (viewRef.current.phase !== 'ready' || blockDraft === null) return;
    const payload = blockPayloadOf(blockDraft);
    const startMinute = parseClock(payload.start);
    const endMinute = parseClock(payload.end, { allow24: true });
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      setNotice(t('workbench.block.invalidTime'));
      return;
    }
    if (payload.taskId === null && payload.title === null) {
      setNotice(t('workbench.block.needTitle'));
      return;
    }

    const editingId = blockDraft.id;
    const result = await commit(
      editingId === null ? 'block.create' : 'block.update',
      editingId === null ? payload : { id: editingId, ...payload },
    );
    if (result.ok) {
      setBlockDraft(null);
      setNotice(null);
    }
  }, [blockDraft, commit, t]);

  const removeBlock = useCallback(async block => {
    if (viewRef.current.phase !== 'ready') return;
    if (!confirmAction(t('workbench.block.confirmDelete'))) return;
    const result = await commit('block.delete', { id: block.id });
    if (result.ok && blockDraft?.id === block.id) setBlockDraft(null);
  }, [blockDraft, commit, t]);

  const openProgress = useCallback(task => {
    const currentView = viewRef.current;
    const current = currentView.phase === 'ready' ? progressOf(currentView.value, task.id) : null;
    setProgressDraft(progressDraftFrom(task.id, current));
    setNotice(null);
    setStale(null);
  }, []);

  const closeProgress = useCallback(() => {
    setProgressDraft(null);
    setNotice(null);
  }, []);

  const submitProgress = useCallback(async event => {
    event.preventDefault();
    if (progressDraft === null) return;
    const quantityDone = progressDraft.quantityDone.trim() === '' ? null : Number(progressDraft.quantityDone);
    const quantityTotal = progressDraft.quantityTotal.trim() === '' ? null : Number(progressDraft.quantityTotal);
    const validQuantity = value => value === null || (Number.isSafeInteger(value) && value >= 0);
    if (!validQuantity(quantityDone) || !validQuantity(quantityTotal)) {
      setNotice(t('workbench.progress.invalidQuantity'));
      return;
    }
    if (quantityDone !== null && quantityTotal !== null && quantityDone > quantityTotal) {
      setNotice(t('workbench.progress.invalidQuantity'));
      return;
    }
    if (progressDraft.status === 'done'
      && quantityDone !== null && quantityTotal !== null && quantityDone < quantityTotal) {
      setNotice(t('workbench.progress.doneBelowTotal'));
      return;
    }
    const result = await commit('progress.record', {
      taskId: progressDraft.taskId,
      status: progressDraft.status,
      quantityDone,
      quantityTotal,
      note: progressDraft.note.trim() === '' ? null : progressDraft.note.trim(),
    });
    if (result.ok) {
      setProgressDraft(null);
      setNotice(null);
    }
  }, [commit, progressDraft, t]);

  const toggleTaskDone = useCallback((task, checked) => {
    const currentView = viewRef.current;
    const current = currentView.phase === 'ready' ? progressOf(currentView.value, task.id) : null;
    const isDone = current !== null && current.status === 'done' && current.confirmed !== false;
    if (checked === isDone) return;
    void commit('progress.record', {
      taskId: task.id,
      status: checked ? 'done' : 'in_progress',
      confirmed: true,
    });
  }, [commit]);

  const startBlockDrag = useCallback(blockId => {
    setDrag({ blockId, targetDate: null, conflicts: [] });
    setStale(null);
  }, []);

  const endBlockDrag = useCallback(() => setDrag(null), []);

  const dragOverBlockDate = useCallback((targetDate, targetMinute) => {
    setDrag(current => {
      if (current === null || (current.targetDate === targetDate && current.targetMinute === targetMinute)) return current;
      return { ...current, targetDate, targetMinute, conflicts: moveConflicts(viewRef.current, current.blockId, targetDate, targetMinute) };
    });
  }, []);

  const dropBlockOnDate = useCallback((targetDate, targetMinute) => {
    const currentDrag = drag;
    setDrag(null);
    if (currentDrag === null) return;
    const currentView = viewRef.current;
    if (currentView.phase !== 'ready') return;
    const block = blockById(currentView, currentDrag.blockId);
    if (block === null) return;
    const payload = movePayload(block, targetDate, targetMinute);
    if (payload === null) { setNotice(t('workbench.block.invalidTime')); return; }
    if (block.date === targetDate && block.start === payload.start) return;
    const conflicts = moveConflicts(currentView, currentDrag.blockId, targetDate, targetMinute);
    if (conflicts.length > 0) {
      setStale({
        kind: 'overlap',
        message: t('workbench.overlap.message', { count: conflicts.length }),
        conflicts,
        retry: {
          kind: 'block.move',
          payload: { ...payload, allowOverlap: true },
        },
      });
      return;
    }
    void commit('block.move', payload);
  }, [commit, drag, t]);

  const retryStale = useCallback(async () => {
    if (stale === null || stale.retry === null || stale.retry === undefined) return;
    const retry = stale.retry;
    setStale(null);
    const result = await commit(retry.kind, retry.payload);
    if (result.ok) setNotice(null);
  }, [commit, stale]);

  const dismissStale = useCallback(() => setStale(null), []);

  return WorkbenchView({
    create: h,
    t,
    view,
    mode,
    date,
    display,
    overview,
    taskDraft,
    taskEditingId,
    taskReplacingId,
    replacementOutcome,
    blockDraft,
    progressDraft,
    notice,
    stale,
    drag,
    onMode: changeMode,
    onDisplay: changeDisplay,
    onPrev: () => move(-1),
    onNext: () => move(1),
    onToday: goToday,
    onRefresh: refresh,
    onCompactRefresh: loadOverview,
    onRetry: () => { setNotice(null); setStale(null); void load(mode, date); },
    onOpenDay: nextDate => { setNotice(null); setStale(null); void load('day', nextDate); },
    onTaskDraft: (field, value) => setTaskDraft(current => ({ ...current, [field]: value })),
    onTaskPrerequisites: ids => setTaskDraft(current => ({ ...current, prerequisites: ids })),
    onTaskSubmit: submitTask,
    onAskTask: async task => {
      try {
        if (!activity?.ensureSession) throw new Error(t('daily.sessionUnavailable'));
        await actions.run('ask-task', { task, call, t, ensureSession: activity.ensureSession, openSession: activity.openSession });
      } catch (error) { setNotice(error.message); }
    },
    onStartTask: async task => {
      try {
        await call('timer', 'start', { taskId: task.id, kind:'study', requestId:globalThis.crypto.randomUUID() });
        activity?.openTimer?.();
        setNotice(t('daily.timerStarted'));
      } catch (error) { setNotice(error.message); }
    },
    onTaskEdit: editTask,
    onTaskReplace: replaceTask,
    onTaskCancel: cancelTask,
    onTaskDelete: removeTask,
    onTaskToggleDone: toggleTaskDone,
    onScheduleTask: task => {
      setBlockDraft({ ...emptyBlockDraft(task.scheduledDate ?? date), taskId: task.id });
      setNotice(t('workbench.plan.formOpened'));
    },
    onProgressEdit: openProgress,
    onProgressDraft: (field, value) => setProgressDraft(current => (current === null ? current : { ...current, [field]: value })),
    onProgressSubmit: submitProgress,
    onProgressCancel: closeProgress,
    onBlockAdd: addBlock,
    onBlockEdit: editBlock,
    onBlockDraft: (field, value) => setBlockDraft(current => (current === null ? current : { ...current, [field]: value })),
    onBlockSubmit: submitBlock,
    onBlockCancel: cancelBlock,
    onBlockDelete: removeBlock,
    onBlockDragStart: startBlockDrag,
    onBlockDragEnd: endBlockDrag,
    onBlockDragOver: dragOverBlockDate,
    onBlockDrop: dropBlockOnDate,
    onStaleRetry: retryStale,
    onStaleDismiss: dismissStale,
  });
}

/** Whether the plan assigned this task a date inside the visible day or week. */
function taskInRange(task, data, mode) {
  const date = task.scheduledDate;
  if (typeof date !== 'string') return false;
  if (mode === 'week') return date >= data.startDate && date <= data.endDate;
  return date === data.date;
}

/**
 * Render one state of the workbench.
 * @param {object} props - Render inputs; see the page body for producers.
 * @param {Function} props.create - React element factory.
 * @param {Function} props.t - Translator.
 * @param {object} props.view - `{ phase: 'loading' | 'empty' | 'error' | 'ready', ... }`.
 * @returns {object} Section element.
 */
export function WorkbenchView(props) {
  const { create, t, view, mode, date, taskDraft, taskEditingId, blockDraft, notice } = props;
  const display = DISPLAY_MODES.includes(props.display) ? props.display : 'full';
  const compact = display === 'compact';
  const overview = props.overview ?? { phase: 'loading' };
  const stale = props.stale ?? null;
  const drag = props.drag ?? null;
  const ready = view.phase === 'ready';
  const data = ready ? view.value : null;
  const blocks = data === null
    ? []
    : (mode === 'week' ? data.days.flatMap(day => day.blocks) : data.blocks);
  const tasks = data === null ? [] : data.tasks;
  const planTasks = data === null ? [] : tasks.filter(task => taskInRange(task, data, mode));
  const planTaskIds = new Set(planTasks.map(task => task.id));
  const remainingTasks = tasks.filter(task => !planTaskIds.has(task.id));
  const unscheduledIds = new Set(data === null ? [] : data.unscheduledTaskIds);
  const scheduledTasks = remainingTasks.filter(task => !unscheduledIds.has(task.id));
  const unscheduledTasks = remainingTasks.filter(task => unscheduledIds.has(task.id));
  const summary = data === null
    ? { study: { blockCount: 0, minuteCount: 0, taskCount: 0 }, fixed: { blockCount: 0, minuteCount: 0, taskCount: 0 } }
    : data.summary;

  const prevLabel = mode === 'week' ? t('workbench.prevWeek') : t('workbench.prevDay');
  const nextLabel = mode === 'week' ? t('workbench.nextWeek') : t('workbench.nextDay');
  const todayLabel = mode === 'week' ? t('workbench.thisWeek') : t('workbench.thisDay');
  const rangeLabel = data === null
    ? t('workbench.range.none')
    : mode === 'week'
      ? t('workbench.range.week', { start: data.startDate, end: data.endDate })
      : `${data.date} ${t(WEEKDAY_KEYS[data.weekday - 1])}`;

  return create('section', {
    'data-testid': 'study-workbench',
    'data-page': 'workbench',
    'data-display': display,
    'data-study-page': '',
    style: ROOT_STYLE,
  },
  create('div', { style: contentStyle(compact ? 760 : 1040) },
  create('div', { style: HEADER_STYLE },
    create('div', null,
      create('h1', { style: TITLE_STYLE }, t('workbench.title')),
      create('p', { style: SUBTITLE_STYLE }, t(compact ? 'workbench.compact.subtitle' : 'workbench.subtitle'))),
    create('div', { style: TOOLBAR_STYLE },
      create('button', {
        type: 'button',
        'data-testid': 'workbench-display-full',
        style: compact ? BUTTON_STYLE : BUTTON_ACTIVE_STYLE,
        'aria-pressed': !compact,
        onClick: () => props.onDisplay?.('full'),
      }, t('workbench.display.full')),
      create('button', {
        type: 'button',
        'data-testid': 'workbench-display-compact',
        style: compact ? BUTTON_ACTIVE_STYLE : BUTTON_STYLE,
        'aria-pressed': compact,
        onClick: () => props.onDisplay?.('compact'),
      }, t('workbench.display.compact')),
      compact ? null : create('button', {
        type: 'button',
        'data-testid': 'workbench-mode-day',
        style: mode === 'day' ? BUTTON_ACTIVE_STYLE : BUTTON_STYLE,
        'aria-pressed': mode === 'day',
        onClick: () => props.onMode('day'),
      }, t('workbench.mode.day')),
      compact ? null : create('button', {
        type: 'button',
        'data-testid': 'workbench-mode-week',
        style: mode === 'week' ? BUTTON_ACTIVE_STYLE : BUTTON_STYLE,
        'aria-pressed': mode === 'week',
        onClick: () => props.onMode('week'),
      }, t('workbench.mode.week')),
      create('button', {
        type: 'button',
        'data-testid': 'workbench-refresh',
        style: BUTTON_STYLE,
        disabled: compact ? overview.phase === 'loading' : !ready,
        onClick: compact ? props.onCompactRefresh : props.onRefresh,
      }, t('workbench.refresh')))),
  compact ? null : create('div', { style: { ...TOOLBAR_STYLE, justifyContent: 'space-between' } },
    create('div', { style: TOOLBAR_STYLE },
      create('button', { type: 'button', 'data-testid': 'workbench-prev', style: BUTTON_STYLE, disabled: date === null, onClick: props.onPrev }, prevLabel),
      create('button', { type: 'button', 'data-testid': 'workbench-today', style: BUTTON_STYLE, onClick: props.onToday }, todayLabel),
      create('button', { type: 'button', 'data-testid': 'workbench-next', style: BUTTON_STYLE, disabled: date === null, onClick: props.onNext }, nextLabel)),
    create('span', { 'data-testid': 'workbench-range', style: VALUE_STYLE }, rangeLabel)),
  compact ? null : (notice === null ? null : create('p', { 'data-testid': 'workbench-notice', role: 'status', style: MESSAGE_STYLE }, notice)),
  compact || !props.replacementOutcome ? null : renderReplacementResult(create, t, props.replacementOutcome),
  compact ? null : (stale === null ? null : renderStale(create, t, stale, props)),
  compact ? null : (ready && view.error !== undefined
    ? create('p', { 'data-testid': 'workbench-error-banner', role: 'alert', style: ERROR_STYLE }, t('common.error', { message: view.error }))
    : null),
  compact ? renderCompact(create, t, props, overview) : null,
  compact ? null : renderBody(create, t, view, props.onRetry),
  compact || !ready ? null : renderReady(create, t, props, {
    data, blocks, tasks, planTasks, scheduledTasks, unscheduledTasks, summary, drag,
  })));
}

function renderReplacementResult(create, t, result) {
  return create('section', { style: CARD_STYLE, 'data-testid': 'workbench-replacement-result' },
    create('h2', { style: SECTION_HEADING_STYLE }, t('workbench.task.replace')),
    create('p', { style: MESSAGE_STYLE }, `${result.retiredTask.title} → ${result.task.title}`),
    create('p', { style: NOTE_STYLE }, t('workbench.task.replaceNote')),
    create('ul', { style: LIST_STYLE }, (result.preservedProgress ?? []).map(record =>
      create('li', { key: record.recordId, style: NOTE_STYLE },
        `${record.date} · ${t(PROGRESS_STATUS_KEYS[record.status] ?? record.status)} · ${quantityText(record) ?? ''}${record.note ? ` · ${record.note}` : ''}`))));
}

/**
 * Render the compact display: today's summary and schedule, no editors.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {object} props - View props with the display callbacks.
 * @param {object} overview - `{ phase: 'loading' | 'ready' | 'error', ... }`.
 * @returns {object} Compact body.
 */
function renderCompact(create, t, props, overview) {
  const state = overview ?? { phase: 'loading' };
  const data = state.phase === 'ready' ? state.value : null;
  const dateLabel = data === null
    ? t('workbench.compact.today')
    : `${data.date} ${t(WEEKDAY_KEYS[(data.weekday ?? 1) - 1])}`;
  return create('div', {
    'data-testid': 'workbench-compact',
    style: { display: 'flex', flexDirection: 'column', gap: '14px' },
  },
  create('div', { style: { ...TOOLBAR_STYLE, justifyContent: 'space-between' } },
    create('span', { 'data-testid': 'workbench-compact-date', style: VALUE_STYLE }, dateLabel),
    create('span', { style: NOTE_STYLE }, t('workbench.compact.hint'))),
  state.phase === 'loading'
    ? create('p', { 'data-testid': 'workbench-compact-loading', role: 'status', style: MESSAGE_STYLE }, t('workbench.compact.loading'))
    : null,
  state.phase === 'error'
    ? create('div', { style: CARD_STYLE },
      create('p', { 'data-testid': 'workbench-compact-error', role: 'alert', style: ERROR_STYLE }, t('common.error', { message: state.message })),
      create('div', null, create('button', {
        type: 'button',
        'data-testid': 'workbench-compact-retry',
        style: BUTTON_STYLE,
        onClick: props.onCompactRefresh ?? props.onRetry,
      }, t('workbench.retry'))))
    : null,
  state.phase === 'ready' ? renderCompactSummary(create, t, state.value.summary) : null,
  state.phase === 'ready' ? renderOutcomeCompletion(create, t, state.value) : null,
  state.phase === 'ready' ? renderCompactPlan(create, t, state.value) : null,
  state.phase === 'ready' ? renderCompactBlocks(create, t, state.value) : null,
  create('button', {
    type: 'button',
    'data-testid': 'workbench-compact-full',
    style: { ...BUTTON_STYLE, alignSelf: 'flex-start' },
    onClick: () => props.onDisplay?.('full'),
  }, t('workbench.compact.openFull')));
}

/**
 * Render the study/fixed totals of the compact display.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {object} summary - Host day summary.
 * @returns {object} Summary card.
 */
function renderCompactSummary(create, t, summary) {
  return create('div', { style: CARD_STYLE },
    create('div', { style: SUMMARY_STYLE },
      create('div', { style: SUMMARY_BLOCK_STYLE },
        create('span', { style: SUMMARY_LABEL_STYLE }, t('workbench.summary.study')),
        create('strong', { 'data-testid': 'workbench-compact-summary-study' }, summaryText(t, summary.study))),
      create('div', { style: SUMMARY_BLOCK_STYLE },
        create('span', { style: SUMMARY_LABEL_STYLE }, t('workbench.summary.fixed')),
        create('strong', { 'data-testid': 'workbench-compact-summary-fixed' }, summaryText(t, summary.fixed)))),
    create('p', { style: NOTE_STYLE }, t('workbench.summary.fixedExcluded')));
}

/**
 * Render the plan's tasks for today inside the compact display.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {object} value - Host day payload.
 * @returns {object | null} Plan card, or null when the plan assigns no dates.
 */
function renderCompactPlan(create, t, value) {
  const tasks = Array.isArray(value.tasks) ? value.tasks : [];
  if (!tasks.some(task => typeof task.scheduledDate === 'string')) return null;
  const planTasks = tasks.filter(task => task.scheduledDate === value.date);
  const progress = value.progress ?? {};
  return create('div', { 'data-testid': 'workbench-compact-plan', style: CARD_STYLE },
    create('div', { style: HEADER_STYLE },
      create('h2', { style: SECTION_HEADING_STYLE }, t('workbench.compact.plan')),
      create('span', { style: NOTE_STYLE }, t('workbench.summary.tasks', { count: planTasks.length }))),
    planTasks.length === 0
      ? create('p', { 'data-testid': 'workbench-compact-plan-empty', style: MESSAGE_STYLE }, t('workbench.compact.planEmpty'))
      : create('ul', { 'data-testid': 'workbench-compact-plan-list', style: LIST_STYLE }, planTasks.map(task => {
        const current = progress[task.id] ?? null;
        return create('li', { key: task.id, 'data-testid': `workbench-compact-plan-${task.id}`, style: COMPACT_ROW_STYLE },
          create('span', { style: { flex: '1 1 auto', minWidth: 0 } }, task.title),
          task.projectTitle === null || task.projectTitle === undefined
            ? null
            : create('span', { style: BADGE_STYLE }, t('workbench.plan.project', { title: task.projectTitle })),
          task.estimatedMinutes === null || task.estimatedMinutes === undefined
            ? null
            : create('span', { style: NOTE_STYLE }, t('workbench.summary.minutes', { count: task.estimatedMinutes })),
          current === null ? null : create('span', { style: BADGE_STYLE }, t(PROGRESS_STATUS_KEYS[current.status] ?? current.status)));
      })),
    planTasks.length === 0
      ? null
      : create('p', { style: NOTE_STYLE }, t('workbench.compact.planNote')));
}

/**
 * Render today's first blocks inside the compact display.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {object} value - Host day payload.
 * @returns {object} Schedule card.
 */
function renderCompactBlocks(create, t, value) {
  const blocks = Array.isArray(value.blocks) ? value.blocks : [];
  const visible = blocks.slice(0, COMPACT_BLOCK_LIMIT);
  const hidden = blocks.length - visible.length;
  return create('div', { style: CARD_STYLE },
    create('div', { style: HEADER_STYLE },
      create('h2', { style: SECTION_HEADING_STYLE }, t('workbench.compact.schedule')),
      create('span', { style: NOTE_STYLE }, t('workbench.summary.blocks', { count: blocks.length }))),
    blocks.length === 0
      ? create('p', { 'data-testid': 'workbench-compact-empty', style: MESSAGE_STYLE }, t('workbench.compact.empty'))
      : create('ul', { 'data-testid': 'workbench-compact-blocks', style: LIST_STYLE }, visible.map(block => {
        const title = block.title ?? block.task?.title ?? t('workbench.block.untitled');
        return create('li', {
          key: block.id,
          'data-testid': `workbench-compact-block-${block.id}`,
          style: COMPACT_ROW_STYLE,
        },
        create('span', { style: COMPACT_TIME_STYLE }, `${block.start}–${block.end}`),
        create('span', { style: { flex: '1 1 auto', minWidth: 0 } }, title),
        create('span', { style: BADGE_STYLE }, t(block.fixed ? 'workbench.block.fixedBadge' : 'workbench.block.studyBadge')));
      })),
    hidden > 0
      ? create('p', { 'data-testid': 'workbench-compact-more', style: NOTE_STYLE }, t('workbench.compact.more', { count: hidden }))
      : null);
}

/**
 * Render the stale-revision or overlap decision. Both keep the current data
 * visible and require one explicit click before anything is written again.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {object} stale - `{ kind, message, conflicts?, retry }`.
 * @param {object} props - View props with the retry/dismiss callbacks.
 * @returns {object} Banner element.
 */
function renderStale(create, t, stale, props) {
  if (stale.kind === 'overlap') {
    const conflicts = Array.isArray(stale.conflicts) ? stale.conflicts : [];
    return create('div', {
      'data-testid': 'workbench-overlap-prompt',
      role: 'alert',
      style: BANNER_STYLE,
    },
    create('strong', null, t('workbench.overlap.title')),
    create('p', { style: MESSAGE_STYLE }, stale.message),
    create('ul', { style: OVERLAP_LIST_STYLE }, conflicts.map((conflict, index) => create('li', {
      key: conflict.id ?? `conflict-${index}`,
      'data-testid': `workbench-overlap-conflict-${conflict.id ?? index}`,
    }, t('workbench.overlap.item', {
      start: conflict.start,
      end: conflict.end,
      title: conflict.title ?? t('workbench.overlap.untitled'),
    })))),
    create('div', { style: TOOLBAR_STYLE },
      create('button', {
        type: 'button',
        'data-testid': 'workbench-overlap-keep',
        style: BUTTON_ACTIVE_STYLE,
        onClick: props.onStaleRetry,
      }, t('workbench.overlap.keep')),
      create('button', {
        type: 'button',
        'data-testid': 'workbench-overlap-cancel',
        style: BUTTON_STYLE,
        onClick: props.onStaleDismiss,
      }, t('workbench.overlap.cancel'))));
  }
  return create('div', {
    'data-testid': 'workbench-stale-banner',
    role: 'alert',
    style: BANNER_STYLE,
  },
  create('p', { style: MESSAGE_STYLE }, stale.message),
  create('div', { style: TOOLBAR_STYLE },
    create('button', {
      type: 'button',
      'data-testid': 'workbench-stale-retry',
      style: BUTTON_ACTIVE_STYLE,
      onClick: props.onStaleRetry,
    }, t('workbench.stale.retry')),
    create('button', {
      type: 'button',
      'data-testid': 'workbench-stale-dismiss',
      style: BUTTON_STYLE,
      onClick: props.onStaleDismiss,
    }, t('workbench.stale.dismiss'))));
}

/**
 * Render the state-specific body.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {object} view - Page state.
 * @param {Function} onRetry - Re-reads the current day or week.
 * @returns {object | null} Body element.
 */
function renderBody(create, t, view, onRetry) {
  if (view.phase === 'loading') {
    return create('p', { 'data-testid': 'study-loading', role: 'status', style: MESSAGE_STYLE }, t('workbench.loading'));
  }
  if (view.phase === 'empty') {
    return create('p', { 'data-testid': 'study-empty', style: MESSAGE_STYLE }, t('workbench.empty'));
  }
  if (view.phase === 'error') {
    return create('div', { style: CARD_STYLE },
      create('p', { 'data-testid': 'study-error', role: 'alert', style: ERROR_STYLE }, t('common.error', { message: view.message })),
      create('div', null, create('button', { type: 'button', 'data-testid': 'workbench-retry', style: BUTTON_STYLE, onClick: onRetry }, t('workbench.retry'))));
  }
  return null;
}

/**
 * Render the loaded day or week.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {object} props - View props.
 * @param {object} derived - Precomputed data groups.
 * @returns {object} Content element.
 */
function renderReady(create, t, props, { data, blocks, tasks, planTasks, scheduledTasks, unscheduledTasks, summary, drag }) {
  const { blockDraft } = props;
  const empty = tasks.length === 0 && blocks.length === 0;
  return create('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
    empty ? create('p', { 'data-testid': 'workbench-empty-hint', style: MESSAGE_STYLE }, t('workbench.empty')) : null,
    renderSummary(create, t, summary),
    data.outcomeCompletion || data.outcomeError ? renderOutcomeCompletion(create, t, data)
      : data.completion === null || data.completion === undefined ? null : renderCompletion(create, t, data.completion),
    create('div', { style: CARD_STYLE },
      create('div', { style: HEADER_STYLE },
        create('h2', { style: SECTION_HEADING_STYLE }, t('workbench.schedule')),
        create('button', { type: 'button', 'data-testid': 'workbench-block-add', style: BUTTON_STYLE, onClick: props.onBlockAdd }, t('workbench.block.add'))),
      props.mode === 'day'
        ? renderDayBlocks(create, t, props, data.blocks, drag)
        : renderWeekDays(create, t, props, data.days, drag),
      blockDraft === null ? null : renderBlockForm(create, t, props)
    ),
    renderTasks(create, t, props, planTasks, scheduledTasks, unscheduledTasks),
    renderTaskForm(create, t, props, tasks));
}

/**
 * Render the task completion summary. Cancelled tasks stay in the plan
 * denominator (so cancelling never raises the rate), a pending record is not
 * complete, and unrecorded is named as unrecorded.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {object} summary - Host completion summary.
 * @returns {object} Card element.
 */
/** Optional outcomes plugin owns all completion rates; task controls remain usable without it. */
export async function withOutcomeCompletion(call, value, mode) {
  try {
    const result = await call('outcomes', mode === 'week' ? 'week' : 'day', { date: value.date ?? value.startDate });
    if (!result.value?.completion) throw new Error('Outcomes returned no completion summary');
    return { ...value, outcomeCompletion: result.value.completion, outcomeError: null };
  } catch (error) {
    return { ...value, outcomeCompletion: null, outcomeError: error.message };
  }
}

function renderOutcomeCompletion(create, t, data) {
  if (data.outcomeError) return create('p', { 'data-testid': 'workbench-outcomes-unavailable', role: 'status', style: NOTE_STYLE }, t('workbench.outcomes.unavailable'));
  const value = data.outcomeCompletion;
  if (!value) return null;
  const display = caliber => `${caliber.completed} / ${caliber.planned} · ${caliber.rate === null ? '—' : `${Math.round(caliber.rate * 100)}%`}`;
  return create('div', { 'data-testid': 'workbench-completion', style: CARD_STYLE },
    create('h2', { style: SECTION_HEADING_STYLE }, t('workbench.completion.title')),
    create('p', { 'data-testid': 'workbench-outcomes-original', style: MESSAGE_STYLE }, `${t('workbench.outcomes.original')} ${display(value.original)}`),
    create('p', { 'data-testid': 'workbench-outcomes-adjusted', style: MESSAGE_STYLE }, `${t('workbench.outcomes.adjusted')} ${display(value.adjusted)}`),
    create('p', { 'data-testid': 'workbench-outcomes-cancelled', style: MESSAGE_STYLE }, `${t('workbench.completion.cancelled', { count: value.cancelled.adjustedCount })} · ${value.cancelled.originalShare === null ? '—' : `${Math.round(value.cancelled.originalShare * 100)}%`}`),
    create('p', { 'data-testid': 'workbench-completion-pending', style: MESSAGE_STYLE }, t('workbench.completion.pending', { count: value.adjusted.pending ?? 0 })),
    create('p', { 'data-testid': 'workbench-completion-unrecorded', style: MESSAGE_STYLE }, t('workbench.completion.unrecorded', { count: value.adjusted.unrecorded ?? 0 })),
    create('p', { style: NOTE_STYLE }, t('workbench.completion.note')));
}

function renderCompletion(create, t, summary) {
  const completion = summary.completion ?? {};
  const percent = completion.rate === null || completion.rate === undefined
    ? t('workbench.completion.noCounted')
    : t('workbench.completion.rate', { percent: Math.round(completion.rate * 100) });
  const rowStyle = { ...META_STYLE, margin: 0 };
  return create('div', { 'data-testid': 'workbench-completion', style: CARD_STYLE },
    create('div', { style: HEADER_STYLE },
      create('h2', { style: SECTION_HEADING_STYLE }, t('workbench.completion.title')),
      create('strong', { 'data-testid': 'workbench-completion-rate' }, percent)),
    create('div', { style: rowStyle },
      create('span', { 'data-testid': 'workbench-completion-counts' }, t('workbench.completion.counts', {
        completed: completion.completedTasks ?? 0,
        counted: completion.countedTasks ?? 0,
      })),
      create('span', { 'data-testid': 'workbench-completion-cancelled' }, t('workbench.completion.cancelled', {
        count: completion.cancelledTasks ?? 0,
      })),
      create('span', { 'data-testid': 'workbench-completion-pending' }, t('workbench.completion.pending', {
        count: completion.pendingTasks ?? 0,
      })),
      create('span', { 'data-testid': 'workbench-completion-unrecorded' }, t('workbench.completion.unrecorded', {
        count: completion.unrecordedTasks ?? 0,
      }))),
    create('p', { 'data-testid': 'workbench-completion-note', style: NOTE_STYLE }, t('workbench.completion.note')));
}

/**
 * Render the study/fixed summary. Fixed course time never enters the study
 * numbers; the note states that rule on screen.
 */
function renderSummary(create, t, summary) {
  return create('div', { style: CARD_STYLE },
    create('div', { style: SUMMARY_STYLE },
      create('div', { style: SUMMARY_BLOCK_STYLE },
        create('span', { style: SUMMARY_LABEL_STYLE }, t('workbench.summary.study')),
        create('strong', { 'data-testid': 'workbench-summary-study' }, summaryText(t, summary.study))),
      create('div', { style: SUMMARY_BLOCK_STYLE },
        create('span', { style: SUMMARY_LABEL_STYLE }, t('workbench.summary.fixed')),
        create('strong', { 'data-testid': 'workbench-summary-fixed' }, summaryText(t, summary.fixed)))),
    create('p', { style: NOTE_STYLE }, t('workbench.summary.fixedExcluded')));
}

/** One bucket of the summary as display text. */
function summaryText(t, bucket) {
  return `${t('workbench.summary.blocks', { count: bucket.blockCount })} · `
    + `${t('workbench.summary.minutes', { count: bucket.minuteCount })} · `
    + t('workbench.summary.tasks', { count: bucket.taskCount });
}

/** Render one day's time blocks plus the drag drop strips while a block is held. */
function renderDayBlocks(create, t, props, blocks, drag) {
  const list = blocks.length === 0
    ? create('p', { 'data-testid': 'workbench-empty-blocks', style: MESSAGE_STYLE }, t('workbench.noBlocks'))
    : create('ul', { 'data-testid': 'workbench-day-blocks', style: LIST_STYLE }, blocks.map(block => renderBlockRow(create, t, props, block)));
  if (drag === null || drag === undefined) return list;
  const hints = [
    { key: 'prev', date: addDays(props.view.value.date, -1), jump: -1 },
    { key: 'next', date: addDays(props.view.value.date, 1), jump: 1 },
  ];
  return create('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    list,
    renderTimeTargets(create, t, props, props.view.value.date, drag),
    create('div', { style: { ...FIELDS_STYLE, gap: '8px' } }, hints.map(hint => {
      const conflicts = drag.targetDate === hint.date ? drag.conflicts ?? [] : [];
      return create('div', {
        key: hint.key,
        'data-testid': `workbench-drop-${hint.key}`,
        style: DROP_ZONE_STYLE,
        onDragOver: event => {
          event.preventDefault();
          props.onBlockDragOver?.(hint.date);
        },
        onDrop: event => {
          event.preventDefault();
          props.onBlockDrop?.(hint.date);
        },
      },
      create('span', null, t(`workbench.drop.${hint.key}`, { date: hint.date })),
      conflicts.length === 0
        ? null
        : create('span', {
          'data-testid': `workbench-overlap-hint-${hint.date}`,
          style: NOTE_STYLE,
        }, t('workbench.overlap.hint', { count: conflicts.length })));
    })));
}

/** Explicit clock targets keep mouse drops deterministic and visible. */
function renderTimeTargets(create, t, props, date, drag) {
  if (!drag) return null;
  return create('div', { style: FIELDS_STYLE, 'aria-label': t('workbench.drop.time') },
    Array.from({ length: 48 }, (_, index) => {
      const minute = index * 30;
      const active = drag.targetDate === date && drag.targetMinute === minute;
      return create('div', { key: minute, 'data-testid': `workbench-drop-${date}-${minute}`,
        style: { ...DROP_ZONE_STYLE, flex: '0 0 64px', ...(active ? { background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)', borderColor: 'var(--dsw-alias-brand-primary)' } : {}) },
        onDragOver: event => { event.preventDefault(); event.stopPropagation?.(); props.onBlockDragOver?.(date, minute); },
        onDrop: event => { event.preventDefault(); event.stopPropagation?.(); props.onBlockDrop?.(date, minute); },
      }, clockText(minute), active && (drag.conflicts?.length ?? 0) > 0 ? ` · ${t('workbench.overlap.title')}` : '');
    }));
}

/** Render the seven day sections of the week view. */
function renderWeekDays(create, t, props, days, drag) {
  return create('div', { 'data-testid': 'workbench-week-days', style: DAY_GRID_STYLE }, days.map(day => {
    const active = drag !== null && drag !== undefined && drag.targetDate === day.date;
    const conflicts = active ? drag.conflicts ?? [] : [];
    return create('section', {
      key: day.date,
      'data-testid': `workbench-day-${day.date}`,
      style: active ? DAY_ACTIVE_STYLE : DAY_CARD_STYLE,
      onDragOver: event => {
        event.preventDefault();
        props.onBlockDragOver?.(day.date);
      },
      onDrop: event => {
        event.preventDefault();
        props.onBlockDrop?.(day.date);
      },
    },
    create('div', { style: DAY_HEADER_STYLE },
      create('h3', { style: SECTION_HEADING_STYLE }, `${day.date} ${t(WEEKDAY_KEYS[day.weekday - 1])}`),
      create('div', { style: TOOLBAR_STYLE },
        create('span', { style: NOTE_STYLE }, `${t('workbench.summary.study')} ${summaryText(t, day.summary.study)}`),
        create('button', {
          type: 'button',
          'data-testid': `workbench-open-day-${day.date}`,
          style: BUTTON_STYLE,
          onClick: () => props.onOpenDay(day.date),
        }, t('workbench.viewDay')))),
    conflicts.length === 0
      ? null
      : create('p', {
        'data-testid': `workbench-overlap-hint-${day.date}`,
        role: 'status',
        style: NOTE_STYLE,
      }, t('workbench.overlap.hint', { count: conflicts.length })),
    renderTimeTargets(create, t, props, day.date, drag),
    day.blocks.length === 0
      ? create('p', { style: MESSAGE_STYLE }, t('workbench.noBlocks'))
      : create('ul', { style: LIST_STYLE }, day.blocks.map(block => renderBlockRow(create, t, props, block))));
  }));
}

/** Render one block row with its fixed/study badge and edit/delete controls. */
function renderBlockRow(create, t, props, block) {
  const title = block.title ?? block.task?.title ?? t('workbench.block.untitled');
  return create('li', {
    key: block.id,
    'data-testid': `workbench-block-${block.id}`,
    style: ROW_STYLE,
    draggable: true,
    onDragStart: event => {
      event?.dataTransfer?.setData?.('text/plain', block.id);
      props.onBlockDragStart?.(block.id);
    },
    onDragEnd: () => props.onBlockDragEnd?.(),
  },
  create('div', null,
      create('div', { style: BLOCK_MAIN_STYLE },
        create('strong', { 'data-testid': `workbench-block-time-${block.id}`, style: BLOCK_TIME_STYLE }, `${block.start}–${block.end}`),
        create('span', { 'data-testid': `workbench-block-title-${block.id}` }, title),
        create('span', {
          'data-testid': `workbench-block-kind-${block.id}`,
          style: BADGE_STYLE,
        }, t(block.fixed ? 'workbench.block.fixedBadge' : 'workbench.block.studyBadge')),
        block.pending ? create('span', { style: PENDING_STYLE }, t('workbench.pending')) : null),
      create('div', { style: META_STYLE },
        block.task === null || block.task === undefined ? null : create('span', null, block.task.subject ?? t('workbench.block.noSubject')),
        block.task !== null && block.task !== undefined && block.task.deleted
          ? create('span', { 'data-testid': `workbench-block-deleted-task-${block.id}` }, t('workbench.task.deleted'))
          : null,
        block.note === null || block.note === undefined ? null : create('span', null, block.note))),
    create('div', { style: TOOLBAR_STYLE },
      create('button', {
        type: 'button',
        'data-testid': `workbench-block-edit-${block.id}`,
        style: BUTTON_STYLE,
        onClick: () => props.onBlockEdit(block),
      }, t('workbench.block.edit')),
      create('button', {
        type: 'button',
        'data-testid': `workbench-block-delete-${block.id}`,
        style: BUTTON_STYLE,
        onClick: () => props.onBlockDelete(block),
      }, t('workbench.block.delete'))));
}

/** Render the task list: the plan's dated tasks first, then the time-block groups. */
function renderTasks(create, t, props, planTasks, scheduledTasks, unscheduledTasks) {
  const total = planTasks.length + scheduledTasks.length + unscheduledTasks.length;
  const planAware = planTasks.length > 0
    || (props.view.value.tasks ?? []).some(task => typeof task.scheduledDate === 'string');
  // With a plan, "unscheduled" means "no time block in this range", not "no
  // date"; the plan date is already shown on its row.
  const restHeading = planAware ? t('workbench.otherTasks') : t('workbench.unscheduled');
  return create('div', { style: CARD_STYLE },
    create('div', { style: HEADER_STYLE },
      create('h2', { style: SECTION_HEADING_STYLE }, t('workbench.tasks')),
      create('span', { style: NOTE_STYLE }, t('workbench.summary.tasks', { count: total }))),
    planAware ? renderPlanTasks(create, t, props, planTasks) : null,
    scheduledTasks.length === 0
      ? (planAware && planTasks.length > 0
        ? null
        : create('p', { 'data-testid': 'workbench-no-scheduled-tasks', style: MESSAGE_STYLE }, t('workbench.noScheduledTasks')))
      : create('div', null,
        create('h3', { style: SUBHEADING_STYLE }, t('workbench.scheduled')),
        create('ul', { 'data-testid': 'workbench-scheduled-tasks', style: LIST_STYLE }, scheduledTasks.map(task => renderTaskRow(create, t, props, task)))),
    unscheduledTasks.length === 0
      ? null
      : create('div', null,
        create('h3', { style: SUBHEADING_STYLE }, restHeading),
        create('ul', { 'data-testid': 'workbench-unscheduled-tasks', style: LIST_STYLE }, unscheduledTasks.map(task => renderTaskRow(create, t, props, task)))));
}

/** Render the plan's tasks for the visible day or week, with their dates. */
function renderPlanTasks(create, t, props, planTasks) {
  const week = props.mode === 'week';
  return create('div', { 'data-testid': 'workbench-plan', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
    create('h3', { style: SUBHEADING_STYLE }, t(week ? 'workbench.plan.week' : 'workbench.plan.day')),
    create('p', { style: NOTE_STYLE }, t('workbench.plan.note')),
    planTasks.length === 0
      ? create('p', { 'data-testid': 'workbench-plan-empty', style: MESSAGE_STYLE }, t(week ? 'workbench.plan.emptyWeek' : 'workbench.plan.emptyDay'))
      : create('ul', { 'data-testid': 'workbench-plan-tasks', style: LIST_STYLE }, planTasks.map(task => renderTaskRow(create, t, props, task, { plan: true }))));
}

/** Render one task row with its progress, fields, and edit/delete controls. */
function renderTaskRow(create, t, props, task, options = {}) {
  const current = progressOf(props.view.value, task.id);
  const done = current !== null && current.status === 'done' && current.confirmed !== false;
  const quantity = quantityText(current);
  const placed = allBlocks(props.view).filter(block => block.taskId === task.id && !block.fixed);
  const prerequisiteText = task.prerequisites.length === 0
    ? t('workbench.task.none')
    : task.prerequisites.map(item => item.title ?? item.id).join('、');
  const editing = props.progressDraft !== null && props.progressDraft !== undefined
    && props.progressDraft.taskId === task.id;
  return create('li', { key: task.id, 'data-testid': `workbench-task-${task.id}`, style: { ...ROW_STYLE, flexWrap: 'wrap' } },
    create('div', { style: { flex: '1 1 320px' } },
      create('div', { style: BLOCK_MAIN_STYLE },
        create('label', { style: TODO_CHECK_STYLE },
          create('input', {
            type: 'checkbox',
            'data-testid': `workbench-task-done-${task.id}`,
            checked: done,
            onChange: event => props.onTaskToggleDone?.(task, event.target.checked),
          }),
          create('span', null, t('workbench.task.doneCheckbox'))),
        create('strong', null, task.title),
        current === null ? null : create('span', {
          'data-testid': `workbench-task-progress-${task.id}`,
          style: BADGE_STYLE,
        }, t(PROGRESS_STATUS_KEYS[current.status] ?? current.status)),
        current !== null && current.confirmed === false
          ? create('span', { 'data-testid': `workbench-task-pending-${task.id}`, style: PENDING_STYLE }, t('workbench.progress.pending'))
          : null,
        quantity === null ? null : create('span', {
          'data-testid': `workbench-task-quantity-${task.id}`,
          style: BADGE_STYLE,
        }, quantity),
        task.pending ? create('span', { style: PENDING_STYLE }, t('workbench.pending')) : null),
      create('div', { style: META_STYLE },
        task.subject === null ? null : create('span', { 'data-testid': `workbench-task-subject-${task.id}` }, task.subject),
        task.scheduledDate === null || task.scheduledDate === undefined
          ? null
          : create('span', { 'data-testid': `workbench-task-date-${task.id}` }, t('workbench.task.date', { date: task.scheduledDate })),
        task.projectTitle === null || task.projectTitle === undefined
          ? null
          : create('span', { 'data-testid': `workbench-task-project-${task.id}`, style: BADGE_STYLE }, t('workbench.plan.project', { title: task.projectTitle })),
        placed.length === 0
          ? null
          : create('span', { 'data-testid': `workbench-task-placed-${task.id}` }, t('workbench.task.placed', {
            time: placed.map(block => `${block.date} ${block.start}–${block.end}`).join('、'),
          })),
        task.estimatedMinutes === null
          ? null
          : create('span', { 'data-testid': `workbench-task-estimate-${task.id}` }, t('workbench.summary.minutes', { count: task.estimatedMinutes })),
        create('span', { 'data-testid': `workbench-task-prerequisites-${task.id}` }, `${t('workbench.task.prerequisites')} ${prerequisiteText}`),
        current === null ? null : create('span', null, t('workbench.progress.lastRecorded', { date: current.date })),
        current === null || current.note === null ? null : create('span', null, current.note)),
      task.materialRef === null ? null : create('p', { style: NOTE_STYLE }, `${t('workbench.task.material')} ${task.materialRef}`),
      !task.replacesTaskId ? null : create('p', { style: NOTE_STYLE }, t('workbench.task.replaces', { id: task.replacesTaskId })),
      task.replacesTaskId && task.materialVerification === 'unverified' ? create('p', { style: NOTE_STYLE }, t('workbench.task.unverified')) : null,
      task.completionCriteria === null ? null : create('p', { style: NOTE_STYLE }, `${t('workbench.task.criteria')} ${task.completionCriteria}`),
      editing ? renderProgressForm(create, t, props, task) : null),
    create('div', { style: TOOLBAR_STYLE },
      options.plan === true
        ? create('button', {
          type: 'button',
          style: BUTTON_ACTIVE_STYLE,
          'data-testid': `workbench-plan-schedule-${task.id}`,
          onClick: () => props.onScheduleTask?.(task),
        }, t('workbench.plan.schedule'))
        : null,
      create('button', {type:'button',style:BUTTON_STYLE,'data-testid':`workbench-ask-${task.id}`,onClick:()=>props.onAskTask?.(task)}, t('daily.ask')),
      create('button', {type:'button',style:BUTTON_STYLE,'data-testid':`workbench-start-${task.id}`,onClick:()=>props.onStartTask?.(task)}, t('daily.start')),
      create('button', {
        type: 'button',
        'data-testid': `workbench-task-progress-edit-${task.id}`,
        style: BUTTON_STYLE,
        onClick: () => props.onProgressEdit?.(task),
      }, t('workbench.progress.edit')),
      create('button', {
        type: 'button',
        'data-testid': `workbench-task-edit-${task.id}`,
        style: BUTTON_STYLE,
        onClick: () => props.onTaskEdit(task),
      }, t('workbench.task.edit')),
      create('button', { type: 'button', style: BUTTON_STYLE,
        'data-testid': `workbench-task-replace-${task.id}`, onClick: () => props.onTaskReplace?.(task),
      }, t('workbench.task.replace')),
      create('button', {
        type: 'button',
        'data-testid': `workbench-task-delete-${task.id}`,
        style: BUTTON_STYLE,
        onClick: () => props.onTaskDelete(task),
      }, t('workbench.task.delete'))));
}

/** One record's quantity as `done / total`, or `null` when no quantity was recorded. */
function quantityText(current) {
  if (current === null) return null;
  const done = current.quantityDone === null || current.quantityDone === undefined ? '?' : current.quantityDone;
  if (current.quantityTotal === null || current.quantityTotal === undefined) {
    return current.quantityDone === null || current.quantityDone === undefined ? null : String(current.quantityDone);
  }
  return `${done} / ${current.quantityTotal}`;
}

/** Render the inline progress editor for one task. */
function renderProgressForm(create, t, props, task) {
  const draft = props.progressDraft;
  return create('form', {
    'data-testid': `workbench-progress-form-${task.id}`,
    style: { ...CARD_STYLE, flexBasis: '100%', marginTop: '8px' },
    onSubmit: props.onProgressSubmit,
  },
  create('h4', { style: SUBHEADING_STYLE }, t('workbench.progress.edit')),
  create('div', { style: FIELDS_STYLE },
    field(create, t('workbench.progress.status'), create('select', {
      name: 'status',
      value: draft.status,
      style: INPUT_STYLE,
      onChange: event => props.onProgressDraft?.('status', event.target.value),
    }, PROGRESS_STATUSES.map(status => create('option', { key: status, value: status }, t(PROGRESS_STATUS_KEYS[status]))))),
    field(create, t('workbench.progress.quantityDone'), create('input', {
      name: 'quantityDone',
      type: 'number',
      min: 0,
      step: 1,
      value: draft.quantityDone,
      style: INPUT_STYLE,
      onChange: event => props.onProgressDraft?.('quantityDone', event.target.value),
    })),
    field(create, t('workbench.progress.quantityTotal'), create('input', {
      name: 'quantityTotal',
      type: 'number',
      min: 0,
      step: 1,
      value: draft.quantityTotal,
      style: INPUT_STYLE,
      onChange: event => props.onProgressDraft?.('quantityTotal', event.target.value),
    }))),
  field(create, t('workbench.progress.note'), create('input', {
    name: 'note',
    value: draft.note,
    style: INPUT_STYLE,
    onChange: event => props.onProgressDraft?.('note', event.target.value),
  })),
  create('div', { style: TOOLBAR_STYLE },
    create('button', { type: 'submit', style: BUTTON_PRIMARY_STYLE }, t('workbench.progress.save')),
    create('button', {
      type: 'button',
      'data-testid': 'workbench-progress-cancel',
      style: BUTTON_STYLE,
      onClick: props.onProgressCancel,
    }, t('workbench.progress.cancel'))));
}

/** Render the create/edit task form. */
function renderTaskForm(create, t, props, tasks) {
  const { taskDraft, taskEditingId } = props;
  const candidates = tasks.filter(task => task.id !== taskEditingId);
  return create('form', {
    'data-testid': 'workbench-task-form',
    style: CARD_STYLE,
    onSubmit: props.onTaskSubmit,
  },
  create('h2', { style: SECTION_HEADING_STYLE }, t(props.taskReplacingId ? 'workbench.task.replace' : taskEditingId === null ? 'workbench.task.add' : 'workbench.task.edit')),
  props.taskReplacingId ? create('p', { style: NOTE_STYLE }, t('workbench.task.replacePreview', { title: tasks.find(task => task.id === props.taskReplacingId)?.title ?? props.taskReplacingId })) : null,
  create('div', { style: FIELDS_STYLE },
    field(create, t('workbench.task.title'), create('input', {
      name: 'title',
      required: true,
      value: taskDraft.title,
      placeholder: t('workbench.task.titlePlaceholder'),
      style: INPUT_STYLE,
      onChange: event => props.onTaskDraft('title', event.target.value),
    })),
    field(create, t('workbench.task.subject'), create('input', {
      name: 'subject',
      value: taskDraft.subject,
      placeholder: t('workbench.task.subjectPlaceholder'),
      style: INPUT_STYLE,
      onChange: event => props.onTaskDraft('subject', event.target.value),
    })),
    field(create, t('workbench.task.estimate'), create('input', {
      name: 'estimatedMinutes',
      type: 'number',
      min: 0,
      step: 1,
      value: taskDraft.estimatedMinutes,
      style: INPUT_STYLE,
      onChange: event => props.onTaskDraft('estimatedMinutes', event.target.value),
    }))),
  field(create, t('workbench.task.material'), create('input', {
    name: 'materialRef',
    readOnly: taskEditingId !== null && !props.taskReplacingId,
    value: taskDraft.materialRef,
    placeholder: t('workbench.task.materialPlaceholder'),
    style: INPUT_STYLE,
    onChange: event => props.onTaskDraft('materialRef', event.target.value),
  })),
  field(create, t('workbench.task.criteria'), create('textarea', {
    name: 'completionCriteria',
    rows: 2,
    value: taskDraft.completionCriteria,
    placeholder: t('workbench.task.criteriaPlaceholder'),
    style: INPUT_STYLE,
    onChange: event => props.onTaskDraft('completionCriteria', event.target.value),
  })),
  field(create, t('workbench.task.prerequisites'), create('select', {
    name: 'prerequisites',
    multiple: true,
    value: taskDraft.prerequisites,
    style: { ...INPUT_STYLE, minHeight: '64px' },
    onChange: event => props.onTaskPrerequisites(Array.from(event.target.selectedOptions, option => option.value)),
  }, candidates.map(task => create('option', { key: task.id, value: task.id }, task.title)))),
  create('div', { style: TOOLBAR_STYLE },
    create('button', { type: 'submit', style: BUTTON_PRIMARY_STYLE }, t('workbench.task.save')),
    taskEditingId === null ? null : create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onTaskCancel }, t('workbench.task.cancel'))));
}

/** Render the create/edit block form when the page asked for one. */
function renderBlockForm(create, t, props) {
  const { blockDraft } = props;
  return create('form', {
    'data-testid': 'workbench-block-form',
    style: { ...CARD_STYLE, marginTop: '6px' },
    onSubmit: props.onBlockSubmit,
  },
  create('h3', { style: SECTION_HEADING_STYLE }, t(blockDraft.id === null ? 'workbench.block.add' : 'workbench.block.edit')),
  create('div', { style: FIELDS_STYLE },
    field(create, t('workbench.block.date'), create('input', {
      name: 'date',
      type: 'date',
      required: true,
      value: blockDraft.date,
      style: INPUT_STYLE,
      onChange: event => props.onBlockDraft('date', event.target.value),
    })),
    field(create, t('workbench.block.start'), create('input', {
      name: 'start',
      type: 'time',
      required: true,
      value: blockDraft.start,
      style: INPUT_STYLE,
      onChange: event => props.onBlockDraft('start', event.target.value),
    })),
    field(create, t('workbench.block.end'), create('input', {
      name: 'end',
      type: 'time',
      required: true,
      value: blockDraft.end,
      style: INPUT_STYLE,
      onChange: event => props.onBlockDraft('end', event.target.value),
    }))),
  create('div', { style: FIELDS_STYLE },
    field(create, t('workbench.block.task'), create('select', {
      name: 'taskId',
      value: blockDraft.taskId,
      style: INPUT_STYLE,
      onChange: event => props.onBlockDraft('taskId', event.target.value),
    },
    create('option', { value: '' }, t('workbench.block.none')),
    props.view.value.tasks.map(task => create('option', { key: task.id, value: task.id }, task.title)))),
    field(create, t('workbench.block.title'), create('input', {
      name: 'title',
      value: blockDraft.title,
      placeholder: t('workbench.block.titlePlaceholder'),
      style: INPUT_STYLE,
      onChange: event => props.onBlockDraft('title', event.target.value),
    }))),
  create('label', { style: FIELD_STYLE },
    create('span', null, t('workbench.block.fixed')),
    create('input', {
      name: 'fixed',
      type: 'checkbox',
      checked: blockDraft.fixed,
      onChange: event => props.onBlockDraft('fixed', event.target.checked),
    })),
  field(create, t('workbench.block.note'), create('input', {
    name: 'note',
    value: blockDraft.note,
    style: INPUT_STYLE,
    onChange: event => props.onBlockDraft('note', event.target.value),
  })),
  create('div', { style: TOOLBAR_STYLE },
    create('button', { type: 'submit', style: BUTTON_PRIMARY_STYLE }, t('workbench.block.save')),
    create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onBlockCancel }, t('workbench.block.cancel'))));
}

/** Wrap one labelled control. */
function field(create, label, control) {
  return create('label', { style: FIELD_STYLE },
    create('span', null, label),
    control);
}

// ---------------------------------------------------------------------------
// Optimistic state transforms (pure, exported for the Node tests)
// ---------------------------------------------------------------------------

/** All blocks of a ready day or week view. */
function allBlocks(view) {
  return Array.isArray(view.value.days)
    ? view.value.days.flatMap(day => day.blocks)
    : view.value.blocks;
}

/** Stable ordering for optimistically added or moved blocks. */
function sortBlocks(blocks) {
  return [...blocks].sort((left, right) => left.date.localeCompare(right.date)
    || left.startMinute - right.startMinute
    || left.endMinute - right.endMinute
    || left.id.localeCompare(right.id));
}

/** Group blocks back into a day or week and recompute its summaries. */
function rebuildBlocks(view, blocks) {
  const sorted = sortBlocks(blocks);
  if (Array.isArray(view.value.days)) {
    const byDate = new Map(view.value.days.map(day => [day.date, []]));
    for (const block of sorted) {
      const bucket = byDate.get(block.date);
      if (bucket !== undefined) bucket.push(block);
    }
    const days = view.value.days.map(day => {
      const dayBlocks = byDate.get(day.date) ?? [];
      return { ...day, blocks: dayBlocks, summary: summarizeBlocks(dayBlocks) };
    });
    const weekBlocks = days.flatMap(day => day.blocks);
    return {
      ...view,
      value: {
        ...view.value,
        days,
        summary: summarizeBlocks(weekBlocks),
        unscheduledTaskIds: unscheduledIds(view.value.tasks, weekBlocks),
      },
    };
  }
  const dayBlocks = sorted.filter(block => block.date === view.value.date);
  return {
    ...view,
    value: {
      ...view.value,
      blocks: dayBlocks,
      summary: summarizeBlocks(dayBlocks),
      unscheduledTaskIds: unscheduledIds(view.value.tasks, dayBlocks),
    },
  };
}

/** Show one task immediately in the task list and the unscheduled group. */
export function optimisticTaskCreate(view, task) {
  if (view.phase !== 'ready') return view;
  return {
    ...view,
    value: {
      ...view.value,
      tasks: [...view.value.tasks, task],
      unscheduledTaskIds: [...view.value.unscheduledTaskIds, task.id],
    },
  };
}

/** Patch one task, its blocks' task labels, and the prerequisite titles. */
export function optimisticTaskUpdate(view, taskId, patch) {
  if (view.phase !== 'ready') return view;
  const tasks = view.value.tasks.map(task => (task.id === taskId ? { ...task, ...patch, id: taskId } : task));
  const blocks = allBlocks(view).map(block => {
    if (block.taskId !== taskId || block.task === null || block.task === undefined) return block;
    return {
      ...block,
      task: {
        ...block.task,
        title: patch.title ?? block.task.title,
        subject: patch.subject === undefined ? block.task.subject : patch.subject,
      },
    };
  });
  return rebuildBlocks({ ...view, value: { ...view.value, tasks } }, blocks);
}

/** Remove one task, keep its blocks, and mark those blocks' task as deleted. */
export function optimisticTaskDelete(view, taskId) {
  if (view.phase !== 'ready') return view;
  const tasks = view.value.tasks.filter(task => task.id !== taskId);
  const blocks = allBlocks(view).map(block => (
    block.taskId === taskId && block.task !== null && block.task !== undefined
      ? { ...block, task: { ...block.task, deleted: true } }
      : block
  ));
  const withTasks = {
    ...view,
    value: {
      ...view.value,
      tasks,
      unscheduledTaskIds: view.value.unscheduledTaskIds.filter(id => id !== taskId),
    },
  };
  return rebuildBlocks(withTasks, blocks);
}

/** Show one block immediately and refresh the day/week summary. */
export function optimisticBlockCreate(view, block) {
  if (view.phase !== 'ready') return view;
  return rebuildBlocks(view, [...allBlocks(view), block]);
}

/** Patch one block immediately; a changed date moves it to the right day. */
export function optimisticBlockUpdate(view, blockId, patch) {
  if (view.phase !== 'ready') return view;
  const blocks = allBlocks(view).map(block => (block.id === blockId ? { ...block, ...patch, id: blockId } : block));
  return rebuildBlocks(view, blocks);
}

/** Remove one block immediately and refresh the day/week summary. */
export function optimisticBlockDelete(view, blockId) {
  if (view.phase !== 'ready') return view;
  return rebuildBlocks(view, allBlocks(view).filter(block => block.id !== blockId));
}

/**
 * The latest progress record of one task. A missing map entry means
 * "unrecorded", not "not started"; the view renders no status badge for it.
 * @param {object} value - Ready day or week value.
 * @param {string} taskId - Task id.
 * @returns {object | null} Latest record or null.
 */
export function progressOf(value, taskId) {
  const map = value === null || value === undefined ? null : value.progress;
  if (map === null || map === undefined) return null;
  return map[taskId] ?? null;
}

/**
 * Client-side copy of the host completion rule: cancelled tasks stay in the
 * plan denominator (cancelling never raises the rate), a pending record is not
 * complete, and unrecorded stays unrecorded. The rate is `null` only when the
 * plan has no tasks at all.
 * @param {Array<object>} tasks - Active tasks.
 * @param {Record<string, object>} [progressMap] - Latest record per task id.
 * @returns {object} Counts plus the completion summary.
 */
export function summarizeProgress(tasks, progressMap = {}) {
  const counts = {
    unrecorded: 0,
    notStarted: 0,
    inProgress: 0,
    partial: 0,
    done: 0,
    cancelled: 0,
    pendingConfirmation: 0,
  };
  let completed = 0;
  for (const task of tasks) {
    const current = progressMap[task.id] ?? null;
    if (current === null) {
      counts.unrecorded += 1;
      continue;
    }
    if (current.status === 'not_started') counts.notStarted += 1;
    else if (current.status === 'in_progress') counts.inProgress += 1;
    else if (current.status === 'partial') counts.partial += 1;
    else if (current.status === 'done') counts.done += 1;
    else if (current.status === 'cancelled') counts.cancelled += 1;
    if (current.confirmed === false) counts.pendingConfirmation += 1;
    if (current.status === 'done' && current.confirmed !== false) completed += 1;
  }
  const taskCount = tasks.length;
  return {
    taskCount,
    counts,
    completion: {
      countedTasks: taskCount,
      plannedTasks: taskCount,
      completedTasks: completed,
      cancelledTasks: counts.cancelled,
      pendingTasks: counts.pendingConfirmation,
      unrecordedTasks: counts.unrecorded,
      rate: taskCount === 0 ? null : Math.round((completed / taskCount) * 10000) / 10000,
    },
  };
}

/** Show one recorded progress immediately, with its pending flag and the new completion. */
export function optimisticProgressRecord(view, record) {
  if (view.phase !== 'ready') return view;
  const progress = {
    ...(view.value.progress ?? {}),
    [record.taskId]: { ...record, pending: true },
  };
  return {
    ...view,
    value: {
      ...view.value,
      progress,
      completion: summarizeProgress(view.value.tasks, progress),
    },
  };
}

/** Find one block in a ready day or week view. */
function blockById(view, blockId) {
  if (view === null || view === undefined || view.phase !== 'ready') return null;
  return allBlocks(view).find(block => block.id === blockId) ?? null;
}

/**
 * Blocks the dragged block would overlap on its target day. A drop on the
 * block's own day is not a move, so it reports no conflict; the caller skips
 * that no-op. Touching ranges are not conflicts.
 * @param {object} view - Ready day or week view.
 * @param {string} blockId - Dragged block id.
 * @param {string} targetDate - Target `YYYY-MM-DD`.
 * @returns {Array<object>} Conflicting blocks.
 */
export function moveConflicts(view, blockId, targetDate, targetMinute) {
  if (view === null || view === undefined || view.phase !== 'ready') return [];
  const block = blockById(view, blockId);
  if (block === null) return [];
  const start = targetMinute ?? block.startMinute;
  const end = start + block.minutes;
  return allBlocks(view).filter(other => other.id !== blockId
    && other.date === targetDate
    && other.startMinute < end
    && start < other.endMinute);
}

function clockText(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function movePayload(block, date, minute = block.startMinute) {
  const end = minute + block.minutes;
  if (!Number.isSafeInteger(minute) || minute < 0 || end > 1440) return null;
  return { id: block.id, date, start: clockText(minute), end: clockText(end) };
}

/** Classify a failed write into the stale, overlap, or ordinary bucket. */
export function classifyWriteFailure(error) {
  if (error === null || typeof error !== 'object' || error.code !== 'conflict') return 'failed';
  if (error.details?.reason === 'overlap') return 'overlap';
  if (Number.isSafeInteger(error.details?.revision)) return 'stale';
  return 'failed';
}

/**
 * Run one revision-guarded write: show the optimistic state, send the
 * revision the view was read at, classify the failure, and either keep a
 * retry for a stale revision, ask before keeping an overlap, or roll back with
 * the service message. A second call while one write is in flight is ignored,
 * so a double click cannot send two writes.
 * @param {object} options - Runner inputs.
 * @param {Function} options.getView - Returns the current page view.
 * @param {Function} options.setView - Applies a view (value or updater).
 * @param {Function} options.setStale - Sets the stale/overlap decision.
 * @param {Function} options.setNotice - Sets the ordinary page notice.
 * @param {Function} options.call - Study route caller.
 * @param {Function} options.load - Re-reads the current day or week.
 * @param {Function} options.t - Translator.
 * @param {{ current: boolean }} [options.busy] - In-flight guard shared by the page.
 * @param {string} options.kind - Write kind understood by `build`.
 * @param {object} options.payload - Write payload.
 * @param {Function} options.build - `(kind, payload, snapshot) => { method, body, optimistic, refreshMode, refreshDate }`.
 * @param {Function} [options.describe] - Turns a rejection into display text.
 * @returns {Promise<object>} Outcome; `{ ok: false, skipped }` when ignored.
 */
export async function runGuardedWrite({
  studyRefresh,
  getView,
  setView,
  setStale,
  setNotice,
  call,
  load,
  t,
  busy,
  kind,
  payload,
  build,
  describe = error => (error instanceof Error ? error.message : String(error)),
}) {
  if (busy?.current === true) return { ok: false, skipped: 'busy' };
  const snapshot = getView();
  if (snapshot === null || snapshot === undefined || snapshot.phase !== 'ready') {
    return { ok: false, skipped: 'not_ready' };
  }
  const built = build(kind, payload, snapshot);
  if (built === null || built === undefined) return { ok: false, skipped: 'unavailable' };
  if (busy !== undefined) busy.current = true;
  setStale(null);
  setView(built.optimistic ?? snapshot);
  try {
    let envelope;
    try {
      const request = {
        requestId: requestId(),
        ...(Number.isSafeInteger(snapshot.revision) ? { expectedRevision: snapshot.revision } : {}),
        ...built.body,
      };
      envelope = await call('tasks', built.method, request);
    } catch (error) {
      const failure = classifyWriteFailure(error);
      if (failure === 'stale') {
        setView(snapshot);
        try {
          await load(built.refreshMode, built.refreshDate, { silent: true });
        } catch {
          // A failed reload does not turn the stale notice into a success; the
          // retry stays available and the next attempt sends a fresh revision.
        }
        const revision = Number.isSafeInteger(error.details?.revision) ? error.details.revision : snapshot.revision;
        setStale({
          kind: 'stale',
          message: t('workbench.stale.message', { revision }),
          retry: { kind, payload },
        });
        return { ok: false, reason: 'stale', error };
      }
      if (failure === 'overlap') {
        setView(snapshot);
        const conflicts = Array.isArray(error.details?.conflicts) ? error.details.conflicts : [];
        setStale({
          kind: 'overlap',
          message: t('workbench.overlap.message', { count: conflicts.length }),
          conflicts,
          retry: { kind, payload: { ...payload, allowOverlap: true } },
        });
        return { ok: false, reason: 'overlap', error };
      }
      setView({ ...snapshot, error: describeError(t, error) });
      setNotice(t('workbench.saveFailed', { message: describeError(t, error) }));
      return { ok: false, reason: 'failed', error };
    }
    try {
      await load(built.refreshMode, built.refreshDate, { silent: true });
    } catch (error) {
      setView({ ...(built.optimistic ?? snapshot), error: describeError(t, error) });
    }
    studyRefresh?.notifyStudyDataChanged(`tasks.${built.method}`);
    return { ok: true, value: envelope.value, revision: envelope.revision };
  } finally {
    if (busy !== undefined) busy.current = false;
  }
}

/**
 * Build the service call and the optimistic state for one write kind. The
 * service method is fixed per kind and the payload keeps the page's field
 * names; a missing entity returns null so the caller can skip instead of
 * sending a write for a row that is no longer on screen.
 * @param {string} kind - `task.*`, `block.*`, or `progress.record`.
 * @param {object} payload - Page payload.
 * @param {object} view - Ready day or week view.
 * @param {'day' | 'week'} mode - Current view mode.
 * @param {string | null} date - Current page date.
 * @returns {object | null} Write description.
 */
export function buildWrite(kind, payload, view, mode, date) {
  if (view === null || view === undefined || view.phase !== 'ready') return null;
  const now = new Date().toISOString();
  const refreshMode = mode;
  let refreshDate = date;

  if (kind === 'task.create') {
    const task = {
      id: temporaryId('task'),
      title: payload.title,
      subject: payload.subject ?? null,
      materialRef: payload.materialRef ?? null,
      completionCriteria: payload.completionCriteria ?? null,
      estimatedMinutes: payload.estimatedMinutes ?? null,
      prerequisiteIds: payload.prerequisites ?? [],
      prerequisites: resolvePrerequisites(view.value.tasks, payload.prerequisites ?? []),
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      pending: true,
    };
    return {
      method: 'createTask', body: payload, optimistic: optimisticTaskCreate(view, task), refreshMode, refreshDate,
    };
  }
  if (kind === 'task.update') {
    const existing = view.value.tasks.find(task => task.id === payload.id);
    if (existing === undefined) return null;
    const prerequisiteIds = payload.prerequisites ?? existing.prerequisiteIds;
    const patch = {
      ...payload,
      prerequisiteIds,
      prerequisites: resolvePrerequisites(view.value.tasks, prerequisiteIds),
      deletedAt: null,
      createdAt: existing.createdAt,
      updatedAt: now,
      pending: true,
    };
    return {
      method: 'updateTask', body: payload, optimistic: optimisticTaskUpdate(view, payload.id, patch), refreshMode, refreshDate,
    };
  }
  if (kind === 'task.replace') {
    if (!view.value.tasks.some(task => task.id === payload.id)) return null;
    return { method: 'replaceTask', body: payload, optimistic: view, refreshMode, refreshDate };
  }
  if (kind === 'task.delete') {
    if (!view.value.tasks.some(task => task.id === payload.id)) return null;
    return {
      method: 'deleteTask', body: { id: payload.id }, optimistic: optimisticTaskDelete(view, payload.id), refreshMode, refreshDate,
    };
  }
  if (kind === 'block.create') {
    const startMinute = parseClock(payload.start);
    const endMinute = parseClock(payload.end, { allow24: true });
    if (startMinute === null || endMinute === null || endMinute <= startMinute) return null;
    const task = payload.taskId === null || payload.taskId === undefined
      ? null
      : view.value.tasks.find(candidate => candidate.id === payload.taskId);
    const block = {
      id: temporaryId('block'),
      date: payload.date,
      start: payload.start,
      end: payload.end,
      startMinute,
      endMinute,
      minutes: endMinute - startMinute,
      fixed: payload.fixed === true,
      taskId: payload.taskId ?? null,
      title: payload.title ?? null,
      note: payload.note ?? null,
      task: task === null || task === undefined
        ? (payload.taskId === null || payload.taskId === undefined ? null : { id: payload.taskId, title: null, subject: null, deleted: true })
        : { id: task.id, title: task.title, subject: task.subject, deleted: false },
      createdAt: now,
      updatedAt: now,
      pending: true,
    };
    return {
      method: 'createBlock', body: payload, optimistic: optimisticBlockCreate(view, block), refreshMode, refreshDate: payload.date ?? refreshDate,
    };
  }
  if (kind === 'block.update') {
    const block = blockById(view, payload.id);
    if (block === null) return null;
    const start = payload.start ?? block.start;
    const end = payload.end ?? block.end;
    const startMinute = parseClock(start);
    const endMinute = parseClock(end, { allow24: true });
    if (startMinute === null || endMinute === null || endMinute <= startMinute) return null;
    const taskId = payload.taskId === undefined ? block.taskId : payload.taskId;
    const task = taskId === null ? null : view.value.tasks.find(candidate => candidate.id === taskId);
    const patch = {
      ...payload,
      start,
      end,
      startMinute,
      endMinute,
      minutes: endMinute - startMinute,
      fixed: payload.fixed === undefined ? block.fixed : payload.fixed,
      taskId,
      title: payload.title === undefined ? block.title : payload.title,
      note: payload.note === undefined ? block.note : payload.note,
      task: taskId === null
        ? null
        : (task === undefined
          ? { id: taskId, title: null, subject: null, deleted: true }
          : { id: task.id, title: task.title, subject: task.subject, deleted: false }),
      updatedAt: now,
      pending: true,
    };
    return {
      method: 'updateBlock', body: payload, optimistic: optimisticBlockUpdate(view, payload.id, patch), refreshMode, refreshDate: payload.date ?? refreshDate,
    };
  }
  if (kind === 'block.move') {
    const block = blockById(view, payload.id);
    if (block === null) return null;
    const nextDate = payload.date ?? block.date;
    const startMinute = payload.start === undefined ? block.startMinute : parseClock(payload.start);
    const endMinute = payload.end === undefined ? block.endMinute : parseClock(payload.end, { allow24: true });
    if (startMinute === null || endMinute === null || endMinute <= startMinute) return null;
    const body = { id: payload.id };
    if (payload.date !== undefined) body.date = payload.date;
    if (payload.start !== undefined) body.start = payload.start;
    if (payload.end !== undefined) body.end = payload.end;
    if (payload.allowOverlap === true) body.allowOverlap = true;
    if (payload.reason !== undefined) body.reason = payload.reason;
    const refresh = mode === 'day' ? { mode: 'day', date: nextDate } : { mode: 'week', date: refreshDate };
    return {
      method: 'moveBlock',
      body,
      optimistic: optimisticBlockUpdate(view, payload.id, {
        date: nextDate,
        start: payload.start ?? block.start,
        end: payload.end ?? block.end,
        startMinute,
        endMinute,
        minutes: endMinute - startMinute,
        updatedAt: now,
        pending: true,
      }),
      refreshMode: refresh.mode,
      refreshDate: refresh.date,
    };
  }
  if (kind === 'block.delete') {
    if (blockById(view, payload.id) === null) return null;
    return {
      method: 'deleteBlock', body: { id: payload.id }, optimistic: optimisticBlockDelete(view, payload.id), refreshMode, refreshDate,
    };
  }
  if (kind === 'progress.record') {
    if (!view.value.tasks.some(task => task.id === payload.taskId)) return null;
    const record = {
      taskId: payload.taskId,
      date: payload.date ?? localToday(),
      status: payload.status,
      quantityDone: payload.quantityDone ?? null,
      quantityTotal: payload.quantityTotal ?? null,
      note: payload.note ?? null,
      confirmed: payload.confirmed ?? true,
    };
    return {
      method: 'recordProgress', body: payload, optimistic: optimisticProgressRecord(view, record), refreshMode, refreshDate,
    };
  }
  return null;
}


/**
 * Run one optimistic write: render `optimistic`, call the service, refresh on
 * success, and put the snapshot back with an error banner on failure.
 * @param {object} options - Write inputs.
 * @param {Function} options.setView - React state setter.
 * @param {object} options.snapshot - View to restore on failure.
 * @param {object} options.optimistic - View to show immediately.
 * @param {Function} options.work - Service write returning a promise.
 * @param {Function} options.refresh - Re-read after a successful write.
 * @param {Function} [options.onError] - Receives the rejection for the page notice.
 * @param {Function} [options.describe] - Turns the rejection into the rollback banner text.
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: unknown }>} Write outcome.
 */
export async function runOptimistic({
  setView,
  snapshot,
  optimistic,
  work,
  refresh,
  onError,
  describe = error => (error instanceof Error ? error.message : String(error)),
}) {
  setView(optimistic);
  let value;
  try {
    value = await work();
  } catch (error) {
    // Only a rejected write restores the snapshot. A failed refresh after a
    // committed write must not claim the write was lost.
    setView({ ...snapshot, error: describe(error) });
    onError?.(error);
    return { ok: false, error };
  }
  try {
    await refresh();
  } catch (error) {
    setView({ ...optimistic, error: describe(error) });
  }
  return { ok: true, value };
}

/** Client-side copy of the host's fixed/study summary rule. */
export function summarizeBlocks(blocks) {
  const studyTaskIds = new Set();
  const fixedTaskIds = new Set();
  let studyBlockCount = 0;
  let studyMinuteCount = 0;
  let fixedBlockCount = 0;
  let fixedMinuteCount = 0;
  for (const block of blocks) {
    if (block.fixed) {
      fixedBlockCount += 1;
      fixedMinuteCount += block.minutes;
      if (block.taskId !== null && block.taskId !== undefined) fixedTaskIds.add(block.taskId);
    } else {
      studyBlockCount += 1;
      studyMinuteCount += block.minutes;
      if (block.taskId !== null && block.taskId !== undefined) studyTaskIds.add(block.taskId);
    }
  }
  return {
    study: { blockCount: studyBlockCount, minuteCount: studyMinuteCount, taskCount: studyTaskIds.size },
    fixed: { blockCount: fixedBlockCount, minuteCount: fixedMinuteCount, taskCount: fixedTaskIds.size },
  };
}

/** Client-side unscheduled-task rule: a task no block in the range references. */
function unscheduledIds(tasks, blocks) {
  const scheduled = new Set(blocks.map(block => block.taskId).filter(taskId => taskId !== null && taskId !== undefined));
  return tasks.filter(task => !scheduled.has(task.id)).map(task => task.id);
}

/** Resolve prerequisite ids to the titles the optimistic row shows. */
function resolvePrerequisites(tasks, ids) {
  return ids.map(id => {
    const task = tasks.find(candidate => candidate.id === id);
    return task === undefined
      ? { id, title: null, deleted: true }
      : { id, title: task.title, deleted: false };
  });
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** Move a `YYYY-MM-DD` date by whole days without touching the local time zone. */
function addDays(date, delta) {
  const [year, month, day] = date.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day) + delta * 86_400_000);
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`;
}

/** The host's local calendar date, used for an optimistic progress record. */
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Parse `HH:mm` to minutes, or null when the text is not a clock time. */
function parseClock(value, { allow24 = false } = {}) {
  if (typeof value !== 'string') return null;
  if (allow24 && value === '24:00') return 1440;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/** Add a fresh request id so a retried write cannot apply twice. */
function requestId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `tasks-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** A temporary id that is replaced by the host id on the next refresh. */
function temporaryId(kind) {
  return `optimistic-${kind}-${requestId()}`;
}

/** Ask before a destructive action; tests and embedded views may not have `confirm`. */
function confirmAction(message) {
  const confirm = globalThis.confirm;
  return typeof confirm === 'function' ? confirm(message) !== false : true;
}

/**
 * Pick the text shown for a failed call: a localized line for transport
 * failures, the host's own message for service failures.
 */
function describeError(t, error) {
  if (error instanceof Error && error.code === 'network') {
    return t === undefined ? 'the study service is unreachable' : t('common.networkError');
  }
  return error instanceof Error ? error.message : String(error);
}
