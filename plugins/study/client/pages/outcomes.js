/**
 * Outcomes page: day, week, and month completion statistics from the
 * student's own records.
 *
 * The page only reads `outcomes.day|week|month`; it never writes and never
 * derives a completion rate on the client. The three calibers are rendered
 * side by side — original plan, adjusted plan, and the explicitly confirmed
 * cancellations — because showing only one denominator is how a day gets
 * faked into "all done" by cancelling the rest.
 *
 * `OutcomesView` is pure: it renders one state from plain props, so the Node
 * tests cover the empty/loading/error/ready states, the three calibers, the
 * per-day rows, the material summary, and the detail list without a browser.
 */
import { createElement as h, useCallback, useEffect, useState } from 'react';

const MODES = ['day', 'week', 'month'];
const MODE_TITLE_KEYS = {
  day: 'outcomes.mode.day',
  week: 'outcomes.mode.week',
  month: 'outcomes.mode.month',
};
const MODE_PREV_KEYS = { day: 'outcomes.prevDay', week: 'outcomes.prevWeek', month: 'outcomes.prevMonth' };
const MODE_NEXT_KEYS = { day: 'outcomes.nextDay', week: 'outcomes.nextWeek', month: 'outcomes.nextMonth' };
const MODE_TODAY_KEYS = { day: 'outcomes.thisDay', week: 'outcomes.thisWeek', month: 'outcomes.thisMonth' };
const WEEKDAY_KEYS = [
  'outcomes.weekday.mon',
  'outcomes.weekday.tue',
  'outcomes.weekday.wed',
  'outcomes.weekday.thu',
  'outcomes.weekday.fri',
  'outcomes.weekday.sat',
  'outcomes.weekday.sun',
];
const STATUS_KEYS = {
  unrecorded: 'outcomes.status.unrecorded',
  not_started: 'outcomes.status.notStarted',
  in_progress: 'outcomes.status.inProgress',
  partial: 'outcomes.status.partial',
  done: 'outcomes.status.done',
  cancelled: 'outcomes.status.cancelled',
};
const STATE_KEYS = {
  empty: 'outcomes.empty',
  no_evidence: 'outcomes.state.noEvidence',
  unplanned_only: 'outcomes.state.unplannedOnly',
};

const ROOT_STYLE = { padding: '28px 32px 48px', maxWidth: '1040px', display: 'flex', flexDirection: 'column', gap: '18px' };
const HEADER_STYLE = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' };
const TITLE_STYLE = { margin: 0, fontSize: '20px', fontWeight: 600, letterSpacing: '0.01em' };
const SUBTITLE_STYLE = { margin: '6px 0 0', fontSize: '13px', lineHeight: 1.6, opacity: 0.68, maxWidth: '64ch' };
const TOOLBAR_STYLE = { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' };
const BUTTON_STYLE = {
  appearance: 'none', border: '1px solid rgba(127, 127, 127, 0.45)', borderRadius: '6px',
  background: 'transparent', color: 'inherit', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
};
const BUTTON_ACTIVE_STYLE = { ...BUTTON_STYLE, borderColor: 'currentColor', fontWeight: 600 };
const CARD_STYLE = { border: '1px solid rgba(127, 127, 127, 0.28)', borderRadius: '10px', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '10px' };
const RATE_GRID_STYLE = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' };
const RATE_CARD_STYLE = { ...CARD_STYLE, gap: '6px' };
const RATE_LABEL_STYLE = { margin: 0, fontSize: '12px', opacity: 0.66, textTransform: 'uppercase', letterSpacing: '0.04em' };
const RATE_VALUE_STYLE = { margin: 0, fontSize: '28px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' };
const RATE_DETAIL_STYLE = { display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px', opacity: 0.78 };
const NOTE_STYLE = { margin: 0, fontSize: '12px', lineHeight: 1.6, opacity: 0.66 };
const MESSAGE_STYLE = { margin: 0, fontSize: '13px', lineHeight: 1.6, opacity: 0.82 };
const ERROR_STYLE = { ...MESSAGE_STYLE, color: '#c2410c' };
const BANNER_STYLE = { ...CARD_STYLE, borderStyle: 'dashed', gap: '4px' };
const SECTION_HEADING_STYLE = { margin: 0, fontSize: '15px', fontWeight: 600 };
const LIST_STYLE = { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' };
const ROW_STYLE = {
  display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap',
  padding: '8px 0', borderTop: '1px solid rgba(127, 127, 127, 0.18)',
};
const META_STYLE = { display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12px', opacity: 0.7, margin: '2px 0 0' };
const BADGE_STYLE = { border: '1px solid rgba(127, 127, 127, 0.4)', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', opacity: 0.85 };
const BADGE_ACTIVE_STYLE = { ...BADGE_STYLE, borderColor: 'currentColor' };
const DAYS_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' };
const DAY_ROW_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(96px, 120px) repeat(4, minmax(72px, 1fr))', gap: '8px', padding: '5px 0', borderTop: '1px solid rgba(127, 127, 127, 0.14)' };
const CELL_STYLE = { textAlign: 'right' };
const HEAD_CELL_STYLE = { ...CELL_STYLE, opacity: 0.62 };

/** One discovered page: contract consumed by `client/plugin.js`. */
export default {
  key: 'outcomes',
  order: 25,
  label: 'outcomes.panel',
  Page: OutcomesPage,
};

/**
 * Page body: owns the selected period and loads the matching statistics.
 * @param {{ t: Function, call: Function }} props - Locale seat and study route caller.
 * @returns {object} Page element.
 */
function OutcomesPage({ t, call }) {
  const [mode, setMode] = useState('day');
  const [anchor, setAnchor] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [view, setView] = useState({ phase: 'loading' });
  const [review, setReview] = useState({ phase: 'idle' });
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [reviewToken, setReviewToken] = useState(0);

  useEffect(() => {
    let active = true;
    setView(current => (current.phase === 'ready' ? { ...current, loading: true } : { phase: 'loading' }));
    const payload = anchor === null ? {} : { date: anchor };
    call('outcomes', mode, payload).then(envelope => {
      if (!active) return;
      setView({ phase: 'ready', value: envelope.value, revision: envelope.revision });
    }).catch(error => {
      if (!active) return;
      setView({ phase: 'error', message: describeError(t, error) });
    });
    return () => { active = false; };
  }, [anchor, call, mode, refreshToken, t]);

  const weekFrom = mode === 'week' && view.phase === 'ready' ? view.value.from : null;

  useEffect(() => {
    if (weekFrom === null) {
      setReview({ phase: 'idle' });
      return undefined;
    }
    let active = true;
    setReview(current => (current.phase === 'ready' ? { ...current, loading: true } : { phase: 'loading' }));
    call('review', 'list', { kind: 'week', date: weekFrom }).then(envelope => {
      if (!active) return;
      const report = envelope.value.items[0] ?? null;
      setReview({ phase: 'ready', report, period: envelope.value.period, loading: false, generating: false, message: null });
    }).catch(error => {
      if (!active) return;
      setReview({ phase: 'error', message: describeError(t, error) });
    });
    return () => { active = false; };
  }, [call, weekFrom, refreshToken, reviewToken, t]);

  const changeMode = useCallback(nextMode => {
    if (!MODES.includes(nextMode)) return;
    setReviewExpanded(false);
    setMode(nextMode);
  }, []);

  const generateReview = useCallback(() => {
    if (weekFrom === null) return;
    setReview(current => ({ ...current, phase: 'ready', generating: true, message: null }));
    call('review', 'week', { date: weekFrom }).then(envelope => {
      setReview({ phase: 'ready', report: envelope.value, period: envelope.value.period, generating: false, message: null });
    }).catch(error => {
      setReview(current => ({ ...current, generating: false, message: describeError(t, error) }));
    });
  }, [call, t, weekFrom]);

  const currentFrom = view.phase === 'ready' ? view.value.from : null;
  const shift = useCallback(direction => {
    if (currentFrom === null) return;
    setAnchor(shiftAnchor(currentFrom, mode, direction));
  }, [currentFrom, mode]);

  return OutcomesView({
    create: h,
    t,
    view,
    mode,
    onMode: changeMode,
    onPrev: () => shift(-1),
    onNext: () => shift(1),
    onToday: () => {
      setAnchor(null);
      setRefreshToken(token => token + 1);
    },
    onRefresh: () => setRefreshToken(token => token + 1),
    onRetry: () => setRefreshToken(token => token + 1),
    review,
    reviewExpanded,
    onGenerateReview: generateReview,
    onToggleReview: () => setReviewExpanded(expanded => !expanded),
    onRetryReview: () => setReviewToken(token => token + 1),
  });
}

/**
 * Move a period anchor by one day/week/month.
 * @param {string} date - `YYYY-MM-DD` anchor (the period's first day).
 * @param {'day'|'week'|'month'} mode - Period kind.
 * @param {number} direction - `-1` back, `1` forward.
 * @returns {string} Shifted anchor.
 */
export function shiftAnchor(date, mode, direction) {
  const [year, month, day] = date.split('-').map(Number);
  if (mode === 'month') {
    const moved = new Date(Date.UTC(year, month - 1 + direction, 1));
    return utcDate(moved);
  }
  const days = mode === 'week' ? 7 : 1;
  return utcDate(new Date(Date.UTC(year, month - 1, day) + direction * days * 86_400_000));
}

/** Format a UTC date as `YYYY-MM-DD`. */
function utcDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Render one state of the outcomes page.
 * @param {object} props - Render inputs.
 * @param {Function} props.create - React element factory.
 * @param {Function} props.t - Translator.
 * @param {object} props.view - `{ phase: 'loading' | 'error' | 'ready', ... }`.
 * @param {'day'|'week'|'month'} props.mode - Selected period.
 * @param {Function} props.onMode - Mode switch.
 * @param {Function} props.onPrev - Previous period.
 * @param {Function} props.onNext - Next period.
 * @param {Function} props.onToday - Jump to today.
 * @param {Function} props.onRefresh - Re-read the period.
 * @param {Function} props.onRetry - Re-read after an error.
 * @param {object} [props.review] - Weekly analysis state; absent on old callers.
 * @param {boolean} [props.reviewExpanded] - Whether the full Markdown is open.
 * @param {Function} [props.onGenerateReview] - Generate/refresh the weekly report.
 * @param {Function} [props.onToggleReview] - Expand or collapse the report.
 * @param {Function} [props.onRetryReview] - Re-read the report after an error.
 * @returns {object} Section element.
 */
export function OutcomesView(props) {
  const { create, t, view, mode } = props;
  const ready = view.phase === 'ready';
  const value = ready ? view.value : null;
  return create('section', {
    'data-testid': 'study-outcomes',
    'data-page': 'outcomes',
    style: ROOT_STYLE,
  },
  create('div', { style: HEADER_STYLE },
    create('div', null,
      create('h1', { style: TITLE_STYLE }, t('outcomes.title')),
      create('p', { style: SUBTITLE_STYLE }, t('outcomes.subtitle'))),
    create('div', { style: TOOLBAR_STYLE },
      MODES.map(item => create('button', {
        key: item,
        type: 'button',
        'data-testid': `outcomes-mode-${item}`,
        style: item === mode ? BUTTON_ACTIVE_STYLE : BUTTON_STYLE,
        'aria-pressed': item === mode,
        onClick: () => props.onMode(item),
      }, t(MODE_TITLE_KEYS[item]))),
      create('button', {
        type: 'button',
        'data-testid': 'outcomes-refresh',
        style: BUTTON_STYLE,
        disabled: !ready,
        onClick: props.onRefresh,
      }, t('outcomes.refresh')))),
  create('div', { style: { ...TOOLBAR_STYLE, justifyContent: 'space-between' } },
    create('div', { style: TOOLBAR_STYLE },
      create('button', {
        type: 'button', 'data-testid': 'outcomes-prev', style: BUTTON_STYLE, disabled: !ready, onClick: props.onPrev,
      }, t(MODE_PREV_KEYS[mode])),
      create('button', {
        type: 'button', 'data-testid': 'outcomes-today', style: BUTTON_STYLE, onClick: props.onToday,
      }, t(MODE_TODAY_KEYS[mode])),
      create('button', {
        type: 'button', 'data-testid': 'outcomes-next', style: BUTTON_STYLE, disabled: !ready, onClick: props.onNext,
      }, t(MODE_NEXT_KEYS[mode]))),
    create('span', { 'data-testid': 'outcomes-range', style: { fontSize: '13px', opacity: 0.78 } },
      rangeText(create, t, view, mode))),
  noticeBanner(create, t, value),
  renderBody(create, t, view, props),
  ready && value.empty !== true ? renderReady(create, t, value) : null,
  mode === 'week' && ready ? renderReviewCard(create, t, props) : null,
  ready ? create('p', { 'data-testid': 'outcomes-rule', style: NOTE_STYLE }, t('outcomes.note')) : null);
}

/** The localized range label for the selected period. */
function rangeText(create, t, view, mode) {
  if (view.phase !== 'ready') return t('outcomes.range.none');
  const value = view.value;
  if (mode === 'day') {
    const weekday = value.days[0]?.weekday ?? 1;
    return t('outcomes.range.day', { date: value.from, weekday: t(WEEKDAY_KEYS[weekday - 1]) });
  }
  return t(mode === 'week' ? 'outcomes.range.week' : 'outcomes.range.month', { start: value.from, end: value.to });
}

/** Render the empty or data-insufficiency notice above the cards. */
function noticeBanner(create, t, value) {
  if (value === null || value.state === 'ready') return null;
  if (value.state === 'empty') {
    return create('div', { 'data-testid': 'outcomes-empty', style: BANNER_STYLE },
      create('p', { style: MESSAGE_STYLE }, t('outcomes.empty')),
      create('p', { style: NOTE_STYLE }, t('outcomes.emptyHint')));
  }
  const count = value.state === 'unplanned_only'
    ? value.counts.unplanned
    : value.items.filter(entry => entry.original || entry.adjusted).length;
  return create('div', { 'data-testid': `outcomes-state-${value.state}`, style: BANNER_STYLE },
    create('p', { style: MESSAGE_STYLE }, t(STATE_KEYS[value.state], { count })));
}

/** Render the loading or error state; the ready state has its own content. */
function renderBody(create, t, view, props) {
  if (view.phase === 'loading') {
    return create('p', { 'data-testid': 'study-loading', role: 'status', style: MESSAGE_STYLE }, t('common.loading'));
  }
  if (view.phase === 'error') {
    return create('div', { style: CARD_STYLE },
      create('p', { 'data-testid': 'study-error', role: 'alert', style: ERROR_STYLE }, t('common.error', { message: view.message })),
      create('button', { type: 'button', 'data-testid': 'outcomes-retry', style: BUTTON_STYLE, onClick: props.onRetry }, t('outcomes.retry')));
  }
  return null;
}

/** Render the week-mode "this week's learning analysis" card. */
function renderReviewCard(create, t, props) {
  const review = props.review;
  if (review === undefined || review === null || review.phase === 'idle') return null;
  const report = review.phase === 'ready' ? review.report : null;
  const period = report?.period ?? review.period ?? null;
  const header = create('div', { style: HEADER_STYLE },
    create('div', null,
      create('h2', { style: SECTION_HEADING_STYLE }, t('outcomes.review.title')),
      create('p', { style: NOTE_STYLE }, t('outcomes.review.subtitle'))),
    create('span', { style: NOTE_STYLE },
      `${t('outcomes.review.source')}${period === null ? '' : ` · ${t('outcomes.review.period', { period })}`}`));
  const body = [];
  if (review.phase === 'loading') {
    body.push(create('p', { 'data-testid': 'outcomes-review-loading', role: 'status', style: MESSAGE_STYLE }, t('common.loading')));
  } else if (review.phase === 'error') {
    body.push(create('p', { 'data-testid': 'outcomes-review-error', role: 'alert', style: ERROR_STYLE },
      t('common.error', { message: review.message ?? '' })));
    body.push(create('button', {
      type: 'button', 'data-testid': 'outcomes-review-retry', style: BUTTON_STYLE, onClick: props.onRetryReview,
    }, t('outcomes.review.retry')));
  } else if (report === null) {
    body.push(create('p', { 'data-testid': 'outcomes-review-empty', style: MESSAGE_STYLE }, t('outcomes.review.empty')));
    body.push(create('p', { style: NOTE_STYLE }, t('outcomes.review.emptyHint')));
    if (review.message !== undefined && review.message !== null) {
      body.push(create('p', { 'data-testid': 'outcomes-review-error', role: 'alert', style: ERROR_STYLE },
        t('common.error', { message: review.message })));
    }
    body.push(create('button', {
      type: 'button',
      'data-testid': 'outcomes-review-generate',
      style: BUTTON_STYLE,
      disabled: review.generating === true,
      onClick: props.onGenerateReview,
    }, t(review.generating === true ? 'outcomes.review.generating' : 'outcomes.review.generate')));
  } else {
    const bullets = Array.isArray(report.bullets) ? report.bullets.slice(0, 3) : [];
    if (bullets.length > 0) {
      body.push(create('ul', { 'data-testid': 'outcomes-review-bullets', style: LIST_STYLE },
        bullets.map((bullet, index) => create('li', { key: index, style: { ...MESSAGE_STYLE, paddingLeft: '2px' } }, bullet))));
    }
    if (review.message !== undefined && review.message !== null) {
      body.push(create('p', { 'data-testid': 'outcomes-review-error', role: 'alert', style: ERROR_STYLE },
        t('common.error', { message: review.message })));
    }
    body.push(create('div', { style: TOOLBAR_STYLE },
      create('button', {
        type: 'button',
        'data-testid': 'outcomes-review-refresh',
        style: BUTTON_STYLE,
        disabled: review.generating === true,
        onClick: props.onGenerateReview,
      }, t(review.generating === true ? 'outcomes.review.generating' : 'outcomes.review.refresh')),
      create('button', {
        type: 'button',
        'data-testid': 'outcomes-review-toggle',
        style: BUTTON_STYLE,
        onClick: props.onToggleReview,
      }, t(props.reviewExpanded ? 'outcomes.review.collapse' : 'outcomes.review.expand'))));
    if (props.reviewExpanded) {
      body.push(create('pre', {
        'data-testid': 'outcomes-review-report',
        style: { ...NOTE_STYLE, whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0, fontSize: '13px', lineHeight: 1.7 },
      }, report.reportMd ?? ''));
    }
  }
  return create('div', { 'data-testid': 'outcomes-review', style: CARD_STYLE }, header, ...body);
}

/** Render the loaded statistics: rates, materials, day rows, and details. */
function renderReady(create, t, value) {
  return create('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
    create('div', { style: RATE_GRID_STYLE },
      rateCard(create, t, {
        testId: 'outcomes-rate-original',
        title: t('outcomes.rate.original'),
        summary: value.completion.original,
        detail: t('outcomes.rate.counts', {
          completed: value.completion.original.completed,
          planned: value.completion.original.planned,
        }),
        extra: [
          value.completion.original.unrecorded === 0
            ? null
            : t('outcomes.rate.unrecorded', { count: value.completion.original.unrecorded }),
          value.completion.original.pending === 0
            ? null
            : t('outcomes.rate.pending', { count: value.completion.original.pending }),
        ],
      }),
      rateCard(create, t, {
        testId: 'outcomes-rate-adjusted',
        title: t('outcomes.rate.adjusted'),
        summary: value.completion.adjusted,
        detail: t('outcomes.rate.counts', {
          completed: value.completion.adjusted.completed,
          planned: value.completion.adjusted.planned,
        }),
        extra: [
          value.completion.adjusted.unrecorded === 0
            ? null
            : t('outcomes.rate.unrecorded', { count: value.completion.adjusted.unrecorded }),
          value.completion.adjusted.pending === 0
            ? null
            : t('outcomes.rate.pending', { count: value.completion.adjusted.pending }),
        ],
      }),
      rateCard(create, t, {
        testId: 'outcomes-rate-cancelled',
        title: t('outcomes.rate.cancelled'),
        summary: {
          rate: value.completion.cancelled.originalShare,
          completed: value.completion.cancelled.originalCount,
          planned: value.completion.original.planned,
        },
        detail: t('outcomes.cancelled.counts', {
          cancelled: value.completion.cancelled.originalCount,
          planned: value.completion.original.planned,
        }),
        extra: [t('outcomes.cancelled.note')],
      })),
    create('div', { style: { ...TOOLBAR_STYLE, fontSize: '12px', opacity: 0.8 } },
      create('span', { 'data-testid': 'outcomes-counts-records' }, t('outcomes.counts.records', { count: value.counts.recorded })),
      value.counts.unplanned === 0
        ? null
        : create('span', { 'data-testid': 'outcomes-counts-unplanned' }, t('outcomes.counts.unplanned', { count: value.counts.unplanned }))),
    renderMaterials(create, t, value.materials),
    value.days.length > 1 ? renderDays(create, t, value.days) : null,
    renderItems(create, t, value.items));
}

/** One rate card; a null rate is named, never rendered as 0%. */
function rateCard(create, t, { testId, title, summary, detail, extra }) {
  return create('div', { 'data-testid': testId, style: RATE_CARD_STYLE },
    create('p', { style: RATE_LABEL_STYLE }, title),
    create('p', { style: RATE_VALUE_STYLE }, rateText(t, summary.rate)),
    create('p', { 'data-testid': `${testId}-counts`, style: NOTE_STYLE }, detail),
    create('div', { style: RATE_DETAIL_STYLE }, extra.filter(entry => entry !== null).map((entry, index) => create('span', { key: index }, entry))));
}

/** Format a 0..1 rate as a percent, or the locale's "nothing counted" text. */
function rateText(t, rate) {
  if (rate === null || rate === undefined) return t('outcomes.rate.none');
  return t('outcomes.rate.value', { percent: Math.round(rate * 100) });
}

/** Render the material advancement summary; task text references are separate. */
function renderMaterials(create, t, materials) {
  return create('div', { 'data-testid': 'outcomes-materials', style: CARD_STYLE },
    create('div', { style: HEADER_STYLE },
      create('h2', { style: SECTION_HEADING_STYLE }, t('outcomes.materials.title')),
      create('span', { 'data-testid': 'outcomes-materials-count', style: NOTE_STYLE }, t('outcomes.materials.advanced', {
        items: materials.advancedItemCount,
        materials: materials.distinctMaterialCount,
      }))),
    materials.items.length === 0
      ? create('p', { 'data-testid': 'outcomes-materials-none', style: MESSAGE_STYLE }, t('outcomes.materials.none'))
      : create('ul', { 'data-testid': 'outcomes-material-list', style: LIST_STYLE }, materials.items.map(entry => create('li', {
        key: entry.materialId,
        'data-testid': `outcomes-material-${entry.materialId}`,
        style: ROW_STYLE,
      },
      create('span', null, entry.deleted ? `${entry.title ?? entry.materialId} · ${t('outcomes.deleted')}` : entry.title ?? entry.materialId),
      create('span', { style: NOTE_STYLE }, t('outcomes.materials.item', {
        count: entry.itemIds.length,
      }))))),
    materials.taskReferenceCount === 0
      ? null
      : create('div', null,
        create('p', { style: NOTE_STYLE }, t('outcomes.materials.taskRefs')),
        create('ul', { 'data-testid': 'outcomes-task-refs', style: LIST_STYLE }, materials.taskReferences.map(entry => create('li', {
          key: entry.taskId,
          style: ROW_STYLE,
        }, create('span', null, entry.title ?? entry.taskId), create('span', { style: NOTE_STYLE }, entry.materialRef))))));
}

/** Render the per-day plan/record table for a week or month. */
function renderDays(create, t, days) {
  return create('div', { 'data-testid': 'outcomes-days', style: CARD_STYLE },
    create('h2', { style: SECTION_HEADING_STYLE }, t('outcomes.days.title')),
    create('div', { style: { ...DAY_ROW_STYLE, borderTop: 'none', fontWeight: 600 } },
      create('span', null, t('outcomes.days.date')),
      create('span', { style: HEAD_CELL_STYLE }, t('outcomes.days.original')),
      create('span', { style: HEAD_CELL_STYLE }, t('outcomes.days.adjusted')),
      create('span', { style: HEAD_CELL_STYLE }, t('outcomes.days.records')),
      create('span', { style: HEAD_CELL_STYLE }, t('outcomes.days.materials'))),
    create('div', { style: DAYS_STYLE }, days.map(day => create('div', {
      key: day.date,
      'data-testid': `outcomes-day-${day.date}`,
      style: DAY_ROW_STYLE,
    },
    create('span', null, `${day.date} ${t(WEEKDAY_KEYS[day.weekday - 1])}`),
    create('span', { style: CELL_STYLE }, `${day.originalCompleted} / ${day.originalPlanned}`),
    create('span', { style: CELL_STYLE }, `${day.adjustedCompleted} / ${day.adjustedPlanned}`),
    create('span', { style: CELL_STYLE }, String(day.records)),
    create('span', { style: CELL_STYLE }, String(day.materialAdvances))))),
    create('p', { style: NOTE_STYLE }, t('outcomes.days.note')));
}

/** Render every unit, including unplanned records, so the totals can be cross-checked. */
function renderItems(create, t, items) {
  return create('div', { 'data-testid': 'outcomes-items', style: CARD_STYLE },
    create('div', { style: HEADER_STYLE },
      create('h2', { style: SECTION_HEADING_STYLE }, t('outcomes.items.title')),
      create('span', { style: NOTE_STYLE }, String(items.length))),
    items.length === 0
      ? create('p', { 'data-testid': 'outcomes-items-empty', style: MESSAGE_STYLE }, t('outcomes.items.empty'))
      : create('ul', { 'data-testid': 'outcomes-item-list', style: LIST_STYLE },
        items.map((entry, index) => renderItemRow(create, t, entry, index))));
}

/** Render one task/plan unit with its status, source badges, and latest record. */
function renderItemRow(create, t, entry, index) {
  const badges = [
    create('strong', { key: 'title' }, entry.title ?? entry.ref),
    create('span', { key: 'kind', style: BADGE_STYLE }, t(entry.kind === 'task' ? 'outcomes.kind.task' : 'outcomes.kind.plan')),
    create('span', {
      key: 'status',
      'data-testid': `outcomes-item-status-${index}`,
      style: BADGE_ACTIVE_STYLE,
    }, t(STATUS_KEYS[entry.status] ?? entry.status)),
    entry.pending ? create('span', { key: 'pending', style: BADGE_STYLE }, t('outcomes.status.pending')) : null,
    entry.original
      ? create('span', { key: 'original', 'data-testid': `outcomes-item-original-${index}`, style: BADGE_STYLE }, t('outcomes.items.originalBadge'))
      : null,
    entry.adjusted || entry.original
      ? null
      : create('span', { key: 'unplanned', 'data-testid': `outcomes-item-unplanned-${index}`, style: BADGE_STYLE }, t('outcomes.items.unplannedBadge')),
    entry.deleted ? create('span', { key: 'deleted', style: BADGE_STYLE }, t('outcomes.deleted')) : null,
  ];
  const meta = [
    entry.originalDate !== null && entry.originalDate !== entry.adjustedDate
      ? create('span', { key: 'originalPlanned' }, t('outcomes.items.plannedOnOriginal', { date: entry.originalDate }))
      : null,
    entry.adjustedDate !== null
      ? create('span', { key: 'planned' }, t('outcomes.items.plannedOn', { date: entry.adjustedDate }))
      : (entry.originalDate !== null
        ? create('span', { key: 'planned' }, t('outcomes.items.plannedOn', { date: entry.originalDate }))
        : null),
    entry.recordDate !== null
      ? create('span', { key: 'recorded' }, t('outcomes.items.recordedOn', { date: entry.recordDate }))
      : null,
    entry.materialTitle !== null ? create('span', { key: 'material' }, entry.materialTitle) : null,
    entry.materialRef !== null ? create('span', { key: 'materialRef' }, entry.materialRef) : null,
    entry.quantityDone === null
      ? null
      : create('span', { key: 'quantity' }, t('outcomes.items.quantity', {
        done: entry.quantityDone,
        total: entry.quantityTotal === null ? '?' : entry.quantityTotal,
      })),
    entry.note === null ? null : create('span', { key: 'note' }, entry.note),
  ];
  return create('li', {
    key: entry.key,
    'data-testid': `outcomes-item-${index}`,
    'data-kind': entry.kind,
    style: ROW_STYLE,
  },
  create('div', { style: { flex: '1 1 320px' } },
    create('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'baseline' } }, badges),
    create('div', { style: META_STYLE }, meta)));
}

/** Pick display text for a failed call: localized transport text, otherwise the host's message. */
function describeError(t, error) {
  if (error instanceof Error && error.code === 'network') return t('common.networkError');
  return error instanceof Error ? error.message : String(error);
}
