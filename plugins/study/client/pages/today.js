/**
 * Read-only "today" page: renders the live `kernel.status` payload and the
 * actions declared for the `today` key.
 *
 * The definition (`{ key, order, label, Page }`) is the page contract the
 * build script discovers. `TodayView` is the pure part: it renders one state
 * of the page from `{ view, t, actions, dispatch }`, which lets the Node tests
 * cover every state without a browser.
 */
import { createElement as h, useCallback, useEffect, useState } from 'react';

const HEADER_STYLE = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' };
const TITLE_STYLE = { margin: 0, fontSize: '20px', fontWeight: 600, letterSpacing: '0.01em' };
const SUBTITLE_STYLE = { margin: '6px 0 0', fontSize: '13px', lineHeight: 1.6, opacity: 0.68, maxWidth: '46ch' };
const ACTIONS_STYLE = { display: 'flex', gap: '8px', flexWrap: 'wrap' };
const BUTTON_STYLE = {
  appearance: 'none', border: '1px solid rgba(127, 127, 127, 0.45)', borderRadius: '6px',
  background: 'transparent', color: 'inherit', padding: '5px 12px', fontSize: '13px', cursor: 'pointer',
};
const CARD_STYLE = { border: '1px solid rgba(127, 127, 127, 0.32)', borderRadius: '10px', padding: '8px 18px' };
const ROW_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(110px, 150px) 1fr', gap: '4px 18px', fontSize: '13px', padding: '7px 0' };
const TERM_STYLE = { margin: 0, opacity: 0.62 };
const VALUE_STYLE = { margin: 0, wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12.5px' };
const MESSAGE_STYLE = { margin: 0, fontSize: '13px', lineHeight: 1.6, opacity: 0.82 };
const WARNING_STYLE = { margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-state-error-primary, #c2410c)' };

/** One discovered page: contract consumed by `client/plugin.js`. */
export default {
  key: 'today',
  order: 20,
  label: 'today.panel',
  Page: TodayPage,
};

/**
 * Page body: loads `kernel.status` once and after every action.
 * @param {{ t: Function, call: Function, actions: object }} props
 *   Framework locale seat, the study route caller, and the action registry.
 * @returns {object} Page element.
 */
function TodayPage({ t, call, actions }) {
  const [view, setView] = useState({ phase: 'loading' });

  const reload = useCallback(async () => {
    setView({ phase: 'loading' });
    try {
      const envelope = await call('kernel', 'status');
      const value = envelope.value;
      setView(value === null || value === undefined
        ? { phase: 'empty' }
        : { phase: 'ready', value, revision: envelope.revision });
    } catch (error) {
      setView({ phase: 'error', message: describeError(t, error) });
    }
  }, [call, t]);

  useEffect(() => { void reload(); }, [reload]);

  const dispatch = useCallback((id) => {
    Promise.resolve(actions.run(id, { call, reload, t })).catch(error => {
      setView({ phase: 'error', message: describeError(t, error) });
    });
  }, [actions, call, reload, t]);

  return TodayView({ create: h, t, view, actions: actions.forPage('today'), dispatch });
}

/**
 * Render one state of the today page.
 * @param {{
 *   create: Function,
 *   t: Function,
 *   view: { phase: 'loading' } | { phase: 'empty' } | { phase: 'error', message: string }
 *     | { phase: 'ready', value: object, revision: number },
 *   actions: Array<{ id: string, label: string }>,
 *   dispatch: (id: string) => void,
 * }} props - Render inputs; `create` is the React element factory.
 * @returns {object} Section element.
 */
export function TodayView({ create, t, view, actions, dispatch }) {
  return create('section', { 'data-testid': 'study-today', 'data-page': 'today', style: { padding: '28px 32px 40px', maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '20px' } },
    create('div', { style: HEADER_STYLE },
      create('div', null,
        create('h1', { style: TITLE_STYLE }, t('today.title')),
        create('p', { style: SUBTITLE_STYLE }, t('today.subtitle'))),
      create('div', { style: ACTIONS_STYLE }, actions.map(action => create('button', {
        key: action.id,
        type: 'button',
        style: BUTTON_STYLE,
        disabled: view.phase === 'loading',
        'data-action': action.id,
        onClick: () => dispatch(action.id),
      }, t(action.label))))),
    renderBody(create, t, view));
}

/**
 * Render the state-specific body.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {object} view - Current page state.
 * @returns {object} Body element.
 */
function renderBody(create, t, view) {
  if (view.phase === 'loading') {
    return create('p', { 'data-testid': 'study-loading', role: 'status', style: MESSAGE_STYLE }, t('common.loading'));
  }
  if (view.phase === 'empty') {
    return create('p', { 'data-testid': 'study-empty', style: MESSAGE_STYLE }, t('common.empty'));
  }
  if (view.phase === 'error') {
    return create('p', { 'data-testid': 'study-error', role: 'alert', style: MESSAGE_STYLE }, t('common.error', { message: view.message }));
  }
  return renderStatus(create, t, view);
}

/**
 * Render the status card of a loaded `kernel.status` value.
 * @param {Function} create - Element factory.
 * @param {Function} t - Translator.
 * @param {{ value: object, revision: number }} view - Loaded state.
 * @returns {object} Card element.
 */
function renderStatus(create, t, view) {
  const { value } = view;
  const today = value.today ?? {};
  const database = value.database ?? {};
  const modules = Array.isArray(value.modules) ? value.modules.map(module => module.id) : [];
  const namespaces = Array.isArray(value.namespaces) ? value.namespaces.map(entry => entry?.ns ?? String(entry)) : [];
  const rows = [
    ['today.date', text(today.date), 'study-date'],
    ['today.revision', text(view.revision), 'study-revision'],
    ['today.snapshotAt', today.snapshotAt === null || today.snapshotAt === undefined ? t('today.snapshotMissing') : formatTime(today.snapshotAt), 'study-snapshot'],
    ['today.storage', text(database.file), 'study-storage'],
    ['today.journal', text(database.journalMode), 'study-journal'],
    ['today.size', formatBytes(t, database.sizeBytes), 'study-size'],
    ['today.schema', text(database.coreSchemaVersion), 'study-schema'],
    ['today.modules', modules.length === 0 ? t('today.emptyValue') : `${modules.length} · ${modules.join(', ')}`, 'study-modules'],
    ['today.namespaces', namespaces.length === 0 ? t('today.emptyValue') : `${namespaces.length} · ${namespaces.join(', ')}`, 'study-namespaces'],
    ['today.serverTime', formatTime(value.serverTime), 'study-server-time'],
  ];
  return create('div', null,
    value.blocked === null || value.blocked === undefined
      ? null
      : create('p', { 'data-testid': 'study-blocked', role: 'status', style: WARNING_STYLE }, t('today.blocked', { reason: value.blocked.reason ?? '' })),
    create('dl', { 'data-testid': 'study-status', style: CARD_STYLE }, rows.map(([labelKey, rendered, testId]) => create('div', { key: testId, style: ROW_STYLE },
      create('dt', { style: TERM_STYLE }, t(labelKey)),
      create('dd', { 'data-testid': testId, style: VALUE_STYLE }, rendered)))));
}

/**
 * Turn one server value into display text; absent values show the locale's placeholder.
 * @param {unknown} value - Field value from the status payload.
 * @returns {string} Display text.
 */
function text(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/**
 * Format a byte count with a technical unit (`B`, `KB`, `MB`).
 * @param {Function} t - Translator, used for a missing value.
 * @param {unknown} bytes - Byte count.
 * @returns {string} Display text.
 */
function formatBytes(t, bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return t('today.emptyValue');
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Format an ISO timestamp in the reader's local time.
 * @param {unknown} iso - ISO timestamp from the server.
 * @returns {string} Local time, or the raw value when it cannot be parsed.
 */
function formatTime(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  return instant.toLocaleString();
}

/**
 * Pick the text shown for a failed read: a localized line for transport
 * failures, the host's own message for service failures.
 * @param {Function} t - Translator.
 * @param {unknown} error - Rejection value.
 * @returns {string} Display text.
 */
function describeError(t, error) {
  if (error instanceof Error && error.code === 'network') return t('common.networkError');
  return error instanceof Error ? error.message : String(error);
}
