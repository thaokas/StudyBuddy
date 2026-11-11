/**
 * Q&A log page: browse the captured units, read one unit's problems, turns,
 * and signals, and correct a boundary by merging units or splitting at a turn.
 *
 * Reads go through `learning.list/get/summaries/windowStatus`; the two writes
 * go through `learning.merge/split`. The route caller owns the request id, so a
 * retried write cannot apply twice. `QuestionsView` is pure: it renders one
 * state from plain props, which is what the Node tests exercise.
 */
import { createElement as h, useCallback, useEffect, useState } from 'react';

const RANGES = [7, 30];
const RESOLUTIONS = ['understood', 'unresolved', 'unknown'];
const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_KEYS = {
  open: 'questions.status.open',
  closed: 'questions.status.closed',
  enriched: 'questions.status.enriched',
  merged: 'questions.status.merged',
  sealed: 'questions.status.sealed',
  summarized: 'questions.status.summarized',
  failed: 'questions.status.failed',
};
const ROLE_KEYS = {
  ask: 'questions.role.ask',
  clarify: 'questions.role.clarify',
  confirm: 'questions.role.confirm',
};
const SIGNAL_KEYS = {
  understood: 'questions.signal.understood',
  confused: 'questions.signal.confused',
  self_solved: 'questions.signal.selfSolved',
  gave_up: 'questions.signal.gaveUp',
  reask: 'questions.signal.reask',
};
const NOTE_KEYS = {
  backfill_limit: 'questions.note.backfillLimit',
  overdue: 'questions.note.overdue',
  empty: 'questions.note.empty',
  retrying: 'questions.note.retrying',
};

const ROOT_STYLE = { padding: '28px 32px 48px', maxWidth: '1180px', display: 'flex', flexDirection: 'column', gap: '16px' };
const HEADER_STYLE = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' };
const TITLE_STYLE = { margin: 0, fontSize: '20px', fontWeight: 600, letterSpacing: '0.01em' };
const SUBTITLE_STYLE = { margin: '6px 0 0', fontSize: '13px', lineHeight: 1.6, opacity: 0.68, maxWidth: '70ch' };
const TOOLBAR_STYLE = { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' };
const BUTTON_STYLE = {
  appearance: 'none', border: '1px solid rgba(127, 127, 127, 0.45)', borderRadius: '6px',
  background: 'transparent', color: 'inherit', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
};
const BUTTON_ACTIVE_STYLE = { ...BUTTON_STYLE, borderColor: 'currentColor', fontWeight: 600 };
const INPUT_STYLE = { padding: '6px 8px', fontSize: '13px', fontFamily: 'inherit' };
const LIST_STYLE = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '4px' };
const ROW_STYLE = {
  display: 'flex', gap: '8px', alignItems: 'flex-start',
  padding: '10px 0', borderTop: '1px solid rgba(127, 127, 127, 0.18)',
};
const ROW_BUTTON_STYLE = {
  appearance: 'none', border: 'none', background: 'transparent', color: 'inherit',
  padding: 0, margin: 0, font: 'inherit', textAlign: 'left', cursor: 'pointer', flex: 1,
};
const META_STYLE = { display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12px', opacity: 0.7, margin: '2px 0 0' };
const TEXT_STYLE = { margin: '4px 0 0', fontSize: '13.5px', lineHeight: 1.6, wordBreak: 'break-word' };
const BADGE_STYLE = { border: '1px solid rgba(127, 127, 127, 0.4)', borderRadius: '999px', padding: '1px 8px', fontSize: '11px' };
const MESSAGE_STYLE = { margin: 0, fontSize: '13px', lineHeight: 1.6, opacity: 0.8 };
const ERROR_STYLE = { ...MESSAGE_STYLE, color: '#c2410c' };
const NOTE_STYLE = { margin: 0, fontSize: '12px', lineHeight: 1.6, opacity: 0.66 };
const CARD_STYLE = { border: '1px solid rgba(127, 127, 127, 0.28)', borderRadius: '10px', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' };
const COLUMNS_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '18px', alignItems: 'start' };
const SUMMARY_ROW_STYLE = { display: 'flex', gap: '10px', fontSize: '12.5px', lineHeight: 1.6 };
const SECTION_TITLE_STYLE = { margin: 0, fontSize: '14px', fontWeight: 600 };

/** One discovered page: contract consumed by `client/plugin.js`. */
export default {
  key: 'questions',
  order: 70,
  label: 'questions.panel',
  Page: QuestionsPage,
};

/**
 * Page body: owns the filters, the selected unit, and the merge selection.
 * @param {{ t: Function, call: Function }} props - Locale seat and study route caller.
 * @returns {object} Page element.
 */
function QuestionsPage({ t, call }) {
  const [range, setRange] = useState(7);
  const [subject, setSubject] = useState('');
  const [resolution, setResolution] = useState('');
  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [selection, setSelection] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [view, setView] = useState({ phase: 'loading' });
  const [detail, setDetail] = useState(null);
  const [summary, setSummary] = useState({ phase: 'loading' });
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let active = true;
    setView(current => (current.phase === 'ready' ? { ...current, loading: true } : { phase: 'loading' }));
    const payload = { from: new Date(Date.now() - range * DAY_MS).toISOString(), limit: 50 };
    if (subject !== '') payload.subject = subject;
    if (resolution !== '') payload.resolution = resolution;
    if (query !== '') payload.query = query;
    call('learning', 'list', payload).then(envelope => {
      if (!active) return;
      setView({ phase: 'ready', value: envelope.value });
      const found = envelope.value.items
        .map(item => item.subject)
        .filter(item => typeof item === 'string' && item !== '');
      if (found.length > 0) {
        setSubjects(current => [...new Set([...current, ...found])].sort());
      }
    }).catch(error => {
      if (active) setView({ phase: 'error', message: describeError(t, error) });
    });
    return () => { active = false; };
  }, [call, query, range, refreshToken, resolution, subject, t]);

  useEffect(() => {
    let active = true;
    setSummary({ phase: 'loading' });
    Promise.all([
      call('learning', 'summaries', { from: new Date(Date.now() - range * DAY_MS).toISOString(), limit: 30 }),
      call('learning', 'windowStatus', {}),
    ]).then(([summaries, status]) => {
      if (!active) return;
      setSummary({ phase: 'ready', value: { ...summaries.value, window: status.value } });
    }).catch(error => {
      if (active) setSummary({ phase: 'error', message: describeError(t, error) });
    });
    return () => { active = false; };
  }, [call, range, refreshToken, t]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return undefined;
    }
    let active = true;
    setDetail({ phase: 'loading' });
    call('learning', 'get', { id: selected }).then(envelope => {
      if (active) setDetail({ phase: 'ready', value: envelope.value });
    }).catch(error => {
      if (active) setDetail({ phase: 'error', message: describeError(t, error) });
    });
    return () => { active = false; };
  }, [call, refreshToken, selected, t]);

  const toggleSelect = useCallback(id => {
    setSelection(current => (current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id]));
  }, []);

  const merge = useCallback(async () => {
    if (selection.length < 2 || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const envelope = await call('learning', 'merge', { episodeIds: selection });
      setSelection([]);
      setSelected(envelope.value.targetId);
      setNotice({ kind: 'ok', message: t('questions.merged', { count: envelope.value.problemCount }) });
      setRefreshToken(token => token + 1);
    } catch (error) {
      setNotice({ kind: 'error', message: t('common.error', { message: describeError(t, error) }) });
    } finally {
      setBusy(false);
    }
  }, [busy, call, selection, t]);

  const split = useCallback(async turnId => {
    if (selected === null || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const envelope = await call('learning', 'split', { episodeId: selected, atTurnId: turnId });
      setSelected(envelope.value.newEpisodeId);
      setNotice({
        kind: 'ok',
        message: t('questions.split', {
          turns: envelope.value.movedTurns,
          problems: envelope.value.movedProblems,
        }),
      });
      setRefreshToken(token => token + 1);
    } catch (error) {
      setNotice({ kind: 'error', message: t('common.error', { message: describeError(t, error) }) });
    } finally {
      setBusy(false);
    }
  }, [busy, call, selected, t]);

  return QuestionsView({
    create: h,
    t,
    view,
    detail,
    summary,
    filters: { range, subject, resolution, query },
    queryDraft,
    subjects,
    selection,
    notice,
    busy,
    onRange: setRange,
    onSubject: setSubject,
    onResolution: setResolution,
    onQueryDraft: setQueryDraft,
    onQuerySubmit: () => setQuery(queryDraft.trim()),
    onRefresh: () => setRefreshToken(token => token + 1),
    onRetry: () => setRefreshToken(token => token + 1),
    onSelect: setSelected,
    onCloseDetail: () => setSelected(null),
    onToggleSelect: toggleSelect,
    onMerge: merge,
    onSplit: split,
  });
}

/**
 * Render one state of the questions page.
 * @param {object} props - Render inputs and callbacks.
 * @param {Function} props.create - React element factory.
 * @param {Function} props.t - Translator.
 * @param {object} props.view - List state.
 * @param {object | null} props.detail - Selected unit state.
 * @param {object} props.summary - Summaries and window status state.
 * @param {{ range: number, subject: string, resolution: string, query: string }} props.filters - Applied filters.
 * @param {string} props.queryDraft - Keyword input text.
 * @param {string[]} props.subjects - Known subjects.
 * @param {string[]} props.selection - Units selected for merging.
 * @param {{ kind: 'ok' | 'error', message: string } | null} props.notice - Operation result line.
 * @param {boolean} props.busy - A write is running.
 * @returns {object} Section element.
 */
export function QuestionsView(props) {
  const { create, t, view, detail, summary, selection } = props;
  const items = view.phase === 'ready' ? view.value.items : [];
  return create('section', {
    'data-testid': 'study-questions',
    'data-page': 'questions',
    style: ROOT_STYLE,
  },
  create('div', { style: HEADER_STYLE },
    create('div', null,
      create('h1', { style: TITLE_STYLE }, t('questions.title')),
      create('p', { style: SUBTITLE_STYLE }, t('questions.subtitle'))),
    create('div', { style: TOOLBAR_STYLE },
      create('button', {
        type: 'button',
        'data-testid': 'questions-refresh',
        style: BUTTON_STYLE,
        disabled: props.busy,
        onClick: props.onRefresh,
      }, t('questions.refresh')))),
  renderWindow(create, t, summary),
  renderFilters(create, t, props),
  props.notice === null ? null : create('p', {
    role: props.notice.kind === 'error' ? 'alert' : 'status',
    'data-testid': 'questions-notice',
    style: props.notice.kind === 'error' ? ERROR_STYLE : MESSAGE_STYLE,
  }, props.notice.message),
  selection.length === 0 ? null : renderMergeBar(create, t, selection, props),
  create('div', { style: COLUMNS_STYLE },
    create('div', null,
      view.phase === 'loading' ? create('p', { role: 'status', style: MESSAGE_STYLE }, t('questions.loading')) : null,
      view.phase === 'error'
        ? create('div', null,
          create('p', { role: 'alert', style: ERROR_STYLE }, t('common.error', { message: view.message })),
          create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onRetry }, t('questions.retry')))
        : null,
      view.phase === 'ready' && items.length === 0
        ? create('div', null,
          create('p', { 'data-testid': 'questions-empty', style: MESSAGE_STYLE }, t('questions.empty')),
          create('p', { style: NOTE_STYLE }, t('questions.emptyHint')))
        : null,
      view.phase === 'ready'
        ? create('p', { 'data-testid': 'questions-count', style: NOTE_STYLE }, t('questions.count', { count: view.value.total }))
        : null,
      view.phase === 'ready'
        ? create('ul', { style: LIST_STYLE }, items.map(item => renderRow(create, t, item, props)))
        : null),
    renderDetail(create, t, detail, props)),
);
}

/** Day summaries, subject threads, and the current window state. */
function renderWindow(create, t, summary) {
  if (summary.phase === 'loading') return null;
  if (summary.phase === 'error') {
    return create('p', { role: 'alert', style: ERROR_STYLE }, t('common.error', { message: summary.message }));
  }
  const value = summary.value;
  const status = value.window ?? null;
  const current = status?.window ?? null;
  const pending = status?.pending ?? { seal: 0, summarize: 0 };
  return create('div', { style: CARD_STYLE, 'data-testid': 'questions-window' },
    create('div', { style: TOOLBAR_STYLE },
      create('strong', { style: SECTION_TITLE_STYLE }, t('questions.window.title')),
      create('span', { style: NOTE_STYLE }, current === null
        ? t('questions.window.none')
        : t('questions.window.current', { day: current.day, status: statusLabel(t, current.status) })),
      pending.seal + pending.summarize === 0
        ? null
        : create('span', { style: NOTE_STYLE }, t('questions.window.pending', { seal: pending.seal, summarize: pending.summarize })),
      current?.note === null || current?.note === undefined
        ? null
        : create('span', { style: NOTE_STYLE }, noteLabel(t, current.note))),
    create('strong', { style: SECTION_TITLE_STYLE }, t('questions.summaries.title')),
    value.items.length === 0
      ? create('p', { style: NOTE_STYLE }, t('questions.summaries.empty'))
      : create('ul', { style: LIST_STYLE }, value.items.slice(0, 3).map(item => create('li', {
        key: item.summaryId,
        'data-testid': `questions-summary-${item.day}`,
        style: SUMMARY_ROW_STYLE,
      },
      create('span', { style: { opacity: 0.66, fontVariantNumeric: 'tabular-nums' } }, item.day),
      create('span', null, item.text)))),
    create('strong', { style: SECTION_TITLE_STYLE }, t('questions.threads.title')),
    value.threads.length === 0
      ? create('p', { style: NOTE_STYLE }, t('questions.summaries.empty'))
      : create('div', { style: TOOLBAR_STYLE }, value.threads.map(thread => create('span', {
        key: thread.topicId,
        style: BADGE_STYLE,
        'data-testid': `questions-thread-${thread.topicId}`,
      }, threadLabel(t, thread)))));
}

/** Range, subject, outcome, and keyword filters. */
function renderFilters(create, t, props) {
  const { filters } = props;
  return create('div', { style: TOOLBAR_STYLE, 'data-testid': 'questions-filters' },
    RANGES.map(days => create('button', {
      key: days,
      type: 'button',
      'data-testid': `questions-range-${days}`,
      style: filters.range === days ? BUTTON_ACTIVE_STYLE : BUTTON_STYLE,
      'aria-pressed': filters.range === days,
      onClick: () => props.onRange(days),
    }, t(days === 7 ? 'questions.range.seven' : 'questions.range.thirty'))),
    create('label', { style: TOOLBAR_STYLE },
      create('span', { style: NOTE_STYLE }, t('questions.subject')),
      create('select', {
        value: filters.subject,
        style: INPUT_STYLE,
        'aria-label': t('questions.subject'),
        onChange: event => props.onSubject(event.target.value),
      },
      create('option', { value: '' }, t('questions.subject.all')),
      props.subjects.map(subject => create('option', { key: subject, value: subject }, subject)))),
    create('label', { style: TOOLBAR_STYLE },
      create('span', { style: NOTE_STYLE }, t('questions.resolution')),
      create('select', {
        value: filters.resolution,
        style: INPUT_STYLE,
        'aria-label': t('questions.resolution'),
        onChange: event => props.onResolution(event.target.value),
      },
      create('option', { value: '' }, t('questions.resolution.all')),
      RESOLUTIONS.map(resolution => create('option', { key: resolution, value: resolution },
        t(`questions.resolution.${resolution}`))))),
    create('form', {
      style: TOOLBAR_STYLE,
      onSubmit: event => {
        event.preventDefault();
        props.onQuerySubmit();
      },
    },
    create('input', {
      type: 'search',
      value: props.queryDraft,
      placeholder: t('questions.queryPlaceholder'),
      'aria-label': t('questions.query'),
      style: INPUT_STYLE,
      onChange: event => props.onQueryDraft(event.target.value),
    }),
    create('button', { type: 'submit', style: BUTTON_STYLE }, t('questions.search'))));
}

/** Merge action for the ticked units. */
function renderMergeBar(create, t, selection, props) {
  const ready = selection.length >= 2 && !props.busy;
  return create('div', { style: TOOLBAR_STYLE, 'data-testid': 'questions-merge-bar' },
    create('span', { style: MESSAGE_STYLE }, t('questions.selected', { count: selection.length })),
    create('button', {
      type: 'button',
      'data-testid': 'questions-merge',
      style: BUTTON_STYLE,
      disabled: !ready,
      onClick: props.onMerge,
    }, t('questions.merge')),
    selection.length < 2 ? create('span', { style: NOTE_STYLE }, t('questions.mergeHint')) : null);
}

/** One unit row with its checkbox, metadata, and first problem. */
function renderRow(create, t, item, props) {
  const first = item.problems[0];
  const reasks = item.problems.reduce((sum, problem) => sum + problem.reaskCount, 0);
  return create('li', { key: item.id, 'data-testid': `questions-row-${item.id}`, style: ROW_STYLE },
    create('input', {
      type: 'checkbox',
      checked: props.selection.includes(item.id),
      disabled: item.status === 'merged',
      'aria-label': t('questions.mergeHint'),
      onChange: () => props.onToggleSelect(item.id),
    }),
    create('button', {
      type: 'button',
      style: ROW_BUTTON_STYLE,
      'data-testid': `questions-open-${item.id}`,
      onClick: () => props.onSelect(item.id),
    },
    create('div', { style: META_STYLE },
      create('span', null, formatTime(item.openedAt)),
      create('span', null, item.subject === null ? t('questions.unknownSubject') : item.subject),
      item.status === 'merged' ? create('span', { style: BADGE_STYLE }, statusLabel(t, item.status)) : null,
      create('span', { style: BADGE_STYLE }, resolutionLabel(t, item.resolution)),
      reasks === 0 ? null : create('span', { style: BADGE_STYLE }, t('questions.reasked', { count: reasks })),
      create('span', null, t('questions.problemCount', { count: item.problemCount }))),
    create('p', { style: TEXT_STYLE }, first?.text === null || first?.text === undefined
      ? t('questions.noProblems')
      : clip(first.text, 140))));
}

/** Selected unit: problems, turns with split buttons, and signals. */
function renderDetail(create, t, detail, props) {
  if (detail === null) {
    return create('aside', { style: CARD_STYLE, 'data-testid': 'questions-detail-empty' },
      create('p', { style: MESSAGE_STYLE }, t('questions.selectHint')));
  }
  if (detail.phase === 'loading') {
    return create('aside', { style: CARD_STYLE, 'data-testid': 'questions-detail' },
      create('p', { role: 'status', style: MESSAGE_STYLE }, t('questions.loading')));
  }
  if (detail.phase === 'error') {
    return create('aside', { style: CARD_STYLE, 'data-testid': 'questions-detail' },
      create('p', { role: 'alert', style: ERROR_STYLE }, t('common.error', { message: detail.message })),
      create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onRetry }, t('questions.retry')));
  }
  const value = detail.value;
  const pruned = value.turns.length > 0
    && value.turns.every(turn => turn.text === null)
    && value.turns.some(turn => turn.textPrunedAt !== null && turn.textPrunedAt !== undefined);
  return create('aside', { style: CARD_STYLE, 'data-testid': 'questions-detail' },
    create('div', { style: TOOLBAR_STYLE },
      create('h2', { style: SECTION_TITLE_STYLE }, t('questions.detail')),
      create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onCloseDetail }, t('questions.close'))),
    create('div', { style: META_STYLE },
      create('span', null, formatTime(value.episode.openedAt)),
      create('span', null, value.episode.subject === null ? t('questions.unknownSubject') : value.episode.subject),
      create('span', null, statusLabel(t, value.episode.status)),
      create('span', { style: BADGE_STYLE }, resolutionLabel(t, value.episode.resolution)),
      create('span', null, t('questions.problemCount', { count: value.episode.problemCount })),
      create('span', null, t('questions.turnCount', { count: value.turns.length }))),
    pruned
      ? create('p', { 'data-testid': 'questions-pruned-notice', style: NOTE_STYLE }, t('questions.prunedNotice'))
      : null,
    create('h3', { style: SECTION_TITLE_STYLE }, t('questions.problems')),
    value.problems.length === 0
      ? create('p', { style: NOTE_STYLE }, t('questions.noProblems'))
      : create('ul', { style: LIST_STYLE }, value.problems.map(problem => create('li', {
        key: problem.id,
        style: { padding: '6px 0', borderTop: '1px solid rgba(127, 127, 127, 0.14)' },
      },
      create('p', { style: TEXT_STYLE }, problem.text === null
        ? t(pruned ? 'questions.prunedTurn' : 'questions.noProblems')
        : problem.text),
      problem.reaskCount === 0
        ? null
        : create('span', { style: BADGE_STYLE }, t('questions.reasked', { count: problem.reaskCount }))))),
    create('h3', { style: SECTION_TITLE_STYLE }, t('questions.turns')),
    create('ol', { style: { ...LIST_STYLE, paddingLeft: '18px', listStyle: 'decimal' } }, value.turns.map(turn => create('li', {
      key: turn.id,
      'data-testid': `questions-turn-${turn.id}`,
      style: { padding: '6px 0', borderTop: '1px solid rgba(127, 127, 127, 0.14)' },
    },
    create('div', { style: META_STYLE },
      create('span', null, roleLabel(t, turn.role)),
      create('span', null, formatTime(turn.at)),
      turn.ambiguous ? create('span', { style: BADGE_STYLE }, '~') : null),
    create('p', { style: TEXT_STYLE }, turn.text === null
      ? t(turn.textPrunedAt === null || turn.textPrunedAt === undefined ? 'questions.noProblems' : 'questions.prunedTurn')
      : turn.text),
    turn.position > 0
      ? create('button', {
        type: 'button',
        style: BUTTON_STYLE,
        disabled: props.busy,
        'data-testid': `questions-split-${turn.id}`,
        onClick: () => props.onSplit(turn.id),
      }, t('questions.splitHere'))
      : null))),
    create('h3', { style: SECTION_TITLE_STYLE }, t('questions.signals')),
    value.signals.length === 0
      ? create('p', { style: NOTE_STYLE }, t('questions.noSignals'))
      : create('ul', { style: LIST_STYLE }, value.signals.map(signal => create('li', {
        key: signal.id,
        style: { ...META_STYLE, opacity: 0.85 },
      },
      create('span', null, signalLabel(t, signal.kind)),
      create('span', null, formatTime(signal.at))))));
}

/** Localized unit/invalid status fallback. */
function statusLabel(t, status) {
  const key = STATUS_KEYS[status];
  return key === undefined ? String(status) : t(key);
}

function resolutionLabel(t, resolution) {
  if (resolution === 'understood' || resolution === 'unresolved' || resolution === 'unknown') {
    return t(`questions.resolution.${resolution}`);
  }
  return t('questions.resolution.unknown');
}

function roleLabel(t, role) {
  const key = ROLE_KEYS[role];
  return key === undefined ? String(role) : t(key);
}

function signalLabel(t, kind) {
  const key = SIGNAL_KEYS[kind];
  return key === undefined ? t('questions.signal.other') : t(key);
}

function noteLabel(t, note) {
  const key = NOTE_KEYS[note];
  return key === undefined ? String(note) : t(key);
}

function threadLabel(t, thread) {
  const data = thread.data;
  if (data === null || typeof data !== 'object' || typeof data.subject !== 'string') return thread.topicId;
  return t('questions.thread', {
    subject: data.subject,
    episodes: Number(data.episodes ?? 0),
    problems: Number(data.problems ?? 0),
  });
}

/** Local wall-clock `YYYY-MM-DD HH:mm`; an unparseable value is shown as-is. */
function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Pick display text for a failed call: localized transport text, otherwise the
 * host's own actionable message.
 * @param {Function} t - Translator.
 * @param {unknown} error - Rejection value.
 * @returns {string} Display text.
 */
function describeError(t, error) {
  if (error instanceof Error && error.code === 'network') return t('common.networkError');
  return error instanceof Error ? error.message : String(error);
}
