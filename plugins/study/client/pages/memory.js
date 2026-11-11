/**
 * Memory page: list, add, correct, and delete the student's preferences,
 * short-lived states, and pending observations — plus the teaching profile tab
 * where each trait can be raised, lowered, or reset to its default.
 *
 * All reads and writes go through the study route (POST /api/study/memory/…);
 * the page never opens memory.json. Deletion leaves a host-side tombstone, so a
 * deleted note cannot come back from an old conversation. The profile tab only
 * shows parameters and their evidence count; it never shows evidence ids or
 * confidence, matching what the model actually receives.
 *
 * MemoryView and ProfileView are pure: they render one state from their props,
 * so Node tests cover every state without a browser.
 */
import { createElement as h, useCallback, useEffect, useState } from 'react';

const KINDS = ['preference', 'state', 'observation'];
const TAB_MEMORY = 'memory';
const TAB_PROFILE = 'profile';

/** Dictionary segments for the snake_case trait keys. */
const TRAIT_COPY_KEY = {
  explain_detail: 'explainDetail',
  hint_preference: 'hintPreference',
  pace: 'pace',
  example_first: 'exampleFirst',
  step_granularity: 'stepGranularity',
  check_frequency: 'checkFrequency',
};

const HEADER_STYLE = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' };
const TITLE_STYLE = { margin: 0, fontSize: '20px', fontWeight: 600, letterSpacing: '0.01em' };
const SUBTITLE_STYLE = { margin: '6px 0 0', fontSize: '13px', lineHeight: 1.6, opacity: 0.68, maxWidth: '52ch' };
const TABS_STYLE = { display: 'flex', gap: '6px', borderBottom: '1px solid rgba(127, 127, 127, 0.2)', paddingBottom: '8px' };
const ROW_STYLE = { padding: '12px 0', borderTop: '1px solid rgba(127, 127, 127, 0.2)' };
const META_STYLE = { display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12px', opacity: 0.62 };
const TEXT_STYLE = { margin: '6px 0', fontSize: '14px', lineHeight: 1.6, wordBreak: 'break-word' };
const BUTTON_STYLE = {
  appearance: 'none', border: '1px solid rgba(127, 127, 127, 0.45)', borderRadius: '6px',
  background: 'transparent', color: 'inherit', padding: '4px 10px', fontSize: '13px', cursor: 'pointer',
};
const ACTIVE_TAB_STYLE = { ...BUTTON_STYLE, borderColor: 'currentColor', fontWeight: 600 };
const INPUT_STYLE = { padding: '6px 8px', fontSize: '13px', fontFamily: 'inherit' };
const MESSAGE_STYLE = { margin: 0, fontSize: '13px', lineHeight: 1.6, opacity: 0.8 };
const ERROR_STYLE = { ...MESSAGE_STYLE, color: '#c2410c' };
const EXPIRED_STYLE = { color: '#c2410c' };
const FIELD_STYLE = { display: 'flex', gap: '8px', alignItems: 'flex-start', marginTop: '8px', flexWrap: 'wrap' };
const BADGE_STYLE = { padding: '0 6px', borderRadius: '999px', border: '1px solid rgba(127, 127, 127, 0.45)', fontSize: '11px' };

/** One discovered page: contract consumed by the client entry. */
export default {
  key: 'memory',
  order: 80,
  label: 'memory.panel',
  Page: MemoryPage,
};

/**
 * Page body: owns the editable state, loads the list and the profile, and runs
 * the writes.
 * @param {{ t: Function, call: Function, actions: object }} props
 *   Framework locale seat, the study route caller, and the action registry.
 * @returns {object} Page element.
 */
function MemoryPage({ t, call, actions }) {
  const [tab, setTab] = useState(TAB_MEMORY);
  const [view, setView] = useState({ phase: 'loading' });
  const [profile, setProfile] = useState({ phase: 'idle' });
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState('preference');
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');

  const reload = useCallback(async () => {
    try {
      const envelope = await call('memory', 'recall', { limit: 50, includeExpired: true });
      setView({ phase: 'ready', value: envelope.value });
    } catch (error) {
      setView({ phase: 'error', message: describeError(t, error) });
    }
  }, [call, t]);

  const reloadProfile = useCallback(async () => {
    try {
      const envelope = await call('memory', 'profileGet', {});
      setProfile({ phase: 'ready', value: envelope.value });
    } catch (error) {
      setProfile({ phase: 'error', message: describeError(t, error) });
    }
  }, [call, t]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (tab === TAB_PROFILE && profile.phase === 'idle') void reloadProfile();
  }, [tab, profile.phase, reloadProfile]);

  const run = useCallback(async (work) => {
    try {
      await work();
      await reload();
    } catch (error) {
      setView(current => ({ ...current, error: describeError(t, error) }));
    }
  }, [reload, t]);

  const runProfile = useCallback(async (work) => {
    try {
      await work();
      await reloadProfile();
    } catch (error) {
      setProfile(current => ({ ...current, error: describeError(t, error) }));
    }
  }, [reloadProfile, t]);

  const add = () => run(async () => {
    if (draft.trim().length === 0) throw new Error(t('memory.emptyDraft'));
    await callMemory(call, 'remember', { text: draft, kind: draftKind });
    setDraft('');
  });

  const correct = id => run(async () => {
    await callMemory(call, 'remember', { id, text: editingText });
    setEditingId(null);
    setEditingText('');
  });

  const remove = id => {
    if (!globalThis.confirm?.(t('memory.confirmRemove'))) return;
    void run(async () => { await callMemory(call, 'forget', { id }); });
  };

  const dispatch = useCallback((id) => {
    Promise.resolve(actions.run(id, { call, reload, t })).catch(error => {
      setView(current => ({ ...current, error: describeError(t, error) }));
    });
  }, [actions, call, reload, t]);

  const setLevel = (key, level) => runProfile(async () => {
    await callMemory(call, 'profileSet', { key, level });
  });

  return MemoryView({
    create: h,
    t,
    tab,
    view,
    profile,
    actions: actions.forPage('memory'),
    dispatch,
    draft,
    draftKind,
    editingId,
    editingText,
    onTab: setTab,
    onDraft: setDraft,
    onDraftKind: setDraftKind,
    onEditStart: item => { setEditingId(item.id); setEditingText(item.text); },
    onEditCancel: () => { setEditingId(null); setEditingText(''); },
    onEditText: setEditingText,
    onAdd: add,
    onCorrect: correct,
    onRemove: remove,
    onRetry: () => { void reload(); },
    onProfileRetry: () => { void reloadProfile(); },
    onLevel: setLevel,
  });
}

/**
 * Render one state of the memory page.
 * @param {{
 *   create: Function,
 *   t: Function,
 *   tab: 'memory' | 'profile',
 *   view: { phase: 'loading' } | { phase: 'error', message: string }
 *     | { phase: 'ready', value: { items: object[] }, error?: string },
 *   profile: { phase: string, value?: object, message?: string, error?: string },
 *   actions: Array<{ id: string, label: string }>,
 *   dispatch: (id: string) => void,
 *   draft: string,
 *   draftKind: string,
 *   editingId: string | null,
 *   editingText: string,
 *   onTab: (tab: string) => void,
 *   onDraft: (value: string) => void,
 *   onDraftKind: (value: string) => void,
 *   onEditStart: (item: object) => void,
 *   onEditCancel: () => void,
 *   onEditText: (value: string) => void,
 *   onAdd: () => void,
 *   onCorrect: (id: string) => void,
 *   onRemove: (id: string) => void,
 *   onRetry: () => void,
 *   onProfileRetry: () => void,
 *   onLevel: (key: string, level: number) => void,
 * }} props - Render inputs and callbacks; create is the React element factory.
 * @returns {object} Section element.
 */
export function MemoryView(props) {
  const { create, t, view, actions, dispatch, tab } = props;
  const items = view.phase === 'ready' ? view.value.items : [];
  const active = items.filter(item => !item.expired);
  const expired = items.filter(item => item.expired);

  const renderRow = item => create('li', { key: item.id, style: ROW_STYLE, 'data-testid': 'memory-row-' + item.id },
    create('div', { style: META_STYLE },
      create('strong', null, t('memory.kind.' + item.kind)),
      item.expired ? create('span', { style: EXPIRED_STYLE }, t('memory.expired')) : null,
      create('span', null, t('memory.updated') + ' ' + item.updatedAt.slice(0, 10)),
      create('span', null, t('memory.source') + ' ' + item.source.actor)),
    props.editingId === item.id
      ? create('div', null,
        create('textarea', {
          value: props.editingText,
          rows: 2,
          maxLength: 500,
          style: { ...INPUT_STYLE, width: '100%' },
          'aria-label': t('memory.edit'),
          onChange: event => props.onEditText(event.target.value),
        }),
        create('div', { style: FIELD_STYLE },
          create('button', { type: 'button', style: BUTTON_STYLE, onClick: () => props.onCorrect(item.id) }, t('memory.save')),
          create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onEditCancel }, t('memory.cancel'))))
      : create('p', { style: TEXT_STYLE }, item.text),
    item.expiresAt === null || item.expiresAt === undefined
      ? null
      : create('div', { style: META_STYLE }, t('memory.expires') + ' ' + item.expiresAt.slice(0, 10)),
    props.editingId === item.id ? null : create('div', { style: FIELD_STYLE },
      create('button', { type: 'button', style: BUTTON_STYLE, onClick: () => props.onEditStart(item) }, t('memory.edit')),
      create('button', { type: 'button', style: BUTTON_STYLE, onClick: () => props.onRemove(item.id) }, t('memory.remove'))));

  const tabs = create('div', { role: 'tablist', style: TABS_STYLE },
    [[TAB_MEMORY, 'memory.tab.memory'], [TAB_PROFILE, 'memory.tab.profile']].map(([key, label]) => create('button', {
      key,
      type: 'button',
      role: 'tab',
      'aria-selected': tab === key,
      'data-testid': 'memory-tab-' + key,
      style: tab === key ? ACTIVE_TAB_STYLE : BUTTON_STYLE,
      onClick: () => props.onTab(key),
    }, t(label))));

  const header = create('div', { style: HEADER_STYLE },
    create('div', null,
      create('h1', { style: TITLE_STYLE }, t('memory.title')),
      create('p', { style: SUBTITLE_STYLE }, t('memory.intro'))),
    create('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      actions.map(action => create('button', {
        key: action.id,
        type: 'button',
        style: BUTTON_STYLE,
        onClick: () => dispatch(action.id),
      }, t(action.label))),
      create('button', {
        type: 'button',
        style: BUTTON_STYLE,
        onClick: tab === TAB_MEMORY ? props.onRetry : props.onProfileRetry,
      }, t('today.refresh'))));

  const memoryTab = create('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
    view.phase === 'loading' ? create('p', { role: 'status', style: MESSAGE_STYLE }, t('memory.loading')) : null,
    view.phase === 'error' ? create('p', { role: 'alert', style: ERROR_STYLE }, t('common.error', { message: view.message })) : null,
    view.error === undefined ? null : create('p', { role: 'alert', style: ERROR_STYLE }, t('common.error', { message: view.error })),
    view.phase === 'ready' && active.length === 0 ? create('p', { style: MESSAGE_STYLE }, t('memory.empty')) : null,
    view.phase === 'ready' ? create('p', { style: MESSAGE_STYLE }, t('memory.count', { count: active.length })) : null,
    create('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } }, active.map(renderRow)),
    expired.length === 0 ? null : create('details', null,
      create('summary', { style: { ...MESSAGE_STYLE, cursor: 'pointer' } }, t('memory.showExpired') + ' (' + expired.length + ')'),
      create('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } }, expired.map(renderRow))),
    create('fieldset', { style: { border: 'none', padding: 0, margin: 0 } },
      create('legend', { style: { fontWeight: 600, padding: 0, fontSize: '14px' } }, t('memory.add')),
      create('div', { style: FIELD_STYLE },
        create('select', {
          value: props.draftKind,
          style: INPUT_STYLE,
          'aria-label': t('memory.kind'),
          onChange: event => props.onDraftKind(event.target.value),
        }, KINDS.map(kind => create('option', { key: kind, value: kind }, t('memory.kind.' + kind)))),
        create('textarea', {
          value: props.draft,
          rows: 2,
          maxLength: 500,
          placeholder: t('memory.addPlaceholder'),
          style: { ...INPUT_STYLE, flex: 1 },
          'aria-label': t('memory.add'),
          onChange: event => props.onDraft(event.target.value),
        }),
        create('button', { type: 'button', style: BUTTON_STYLE, onClick: props.onAdd }, t('memory.save')))));

  const profileTab = ProfileView({
    create,
    t,
    profile: props.profile,
    onLevel: props.onLevel,
    onReset: (key, level) => props.onLevel(key, level),
    onRetry: props.onProfileRetry,
  });

  return create('section', { 'data-testid': 'study-memory', 'data-page': 'memory', 'data-tab': tab, style: { padding: '28px 32px 40px', maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '16px' } },
    header,
    tabs,
    tab === TAB_PROFILE ? profileTab : memoryTab);
}

/**
 * Render the profile tab: one row per trait with its behaviour, level, evidence
 * count, and three actions.
 * @param {{
 *   create: Function,
 *   t: Function,
 *   profile: { phase: string, value?: { traits: object[] }, message?: string, error?: string },
 *   onLevel: (key: string, level: number) => void,
 *   onReset: (key: string, level: number) => void,
 *   onRetry: () => void,
 * }} props - Render inputs.
 * @returns {object} Profile section element.
 */
export function ProfileView({ create, t, profile, onLevel, onReset, onRetry }) {
  if (profile.phase === 'idle' || profile.phase === 'loading') {
    return create('p', { role: 'status', style: MESSAGE_STYLE }, t('memory.profile.loading'));
  }
  if (profile.phase === 'error') {
    return create('div', null,
      create('p', { role: 'alert', style: ERROR_STYLE }, t('common.error', { message: profile.message })),
      create('button', { type: 'button', style: BUTTON_STYLE, onClick: onRetry }, t('today.refresh')));
  }

  const traits = Array.isArray(profile.value?.traits) ? profile.value.traits : [];
  const renderTrait = trait => create('li', { key: trait.key, style: ROW_STYLE, 'data-testid': 'memory-trait-' + trait.key },
    create('div', { style: META_STYLE },
      create('strong', null, t('memory.trait.' + traitCopyKey(trait.key))),
      trait.sourceKind === 'user_edit' ? create('span', { style: BADGE_STYLE }, t('memory.profile.manual')) : null),
    create('p', { style: TEXT_STYLE }, t('memory.profile.value.' + traitCopyKey(trait.key) + '.' + levelToken(trait.level))),
    create('div', { style: META_STYLE },
      create('span', null, formatLevel(t, trait)),
      create('span', null, t('memory.profile.evidence', { count: trait.evidenceCount ?? 0 }))),
    create('div', { style: FIELD_STYLE },
      create('button', {
        type: 'button',
        style: BUTTON_STYLE,
        disabled: trait.level <= trait.min + 1e-9,
        onClick: () => onLevel(trait.key, nextLevel(trait, -1)),
      }, t('memory.profile.lower')),
      create('button', {
        type: 'button',
        style: BUTTON_STYLE,
        disabled: trait.level >= trait.max - 1e-9,
        onClick: () => onLevel(trait.key, nextLevel(trait, 1)),
      }, t('memory.profile.higher')),
      create('button', {
        type: 'button',
        style: BUTTON_STYLE,
        onClick: () => onReset(trait.key, trait.defaultLevel),
      }, t('memory.profile.reset'))));

  return create('div', { 'data-testid': 'study-memory-profile', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    create('p', { style: MESSAGE_STYLE }, t('memory.profile.note')),
    profile.error === undefined ? null : create('p', { role: 'alert', style: ERROR_STYLE }, t('common.error', { message: profile.error })),
    create('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } }, traits.map(renderTrait)));
}

/** Add a fresh request id so a retried write cannot apply twice. */
function requestId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : 'memory-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

/**
 * Call one memory write through the page's study-route caller.
 * @param {Function} call - call(namespace, method, payload).
 * @param {string} method - remember, forget, or profileSet.
 * @param {object} payload - Method fields.
 * @returns {Promise<object>} Service value.
 */
async function callMemory(call, method, payload) {
  const envelope = await call('memory', method, { requestId: requestId(), ...payload });
  return envelope.value;
}

/** Move one grid step in the requested direction and stay inside the range. */
function nextLevel(trait, direction) {
  const value = trait.level + direction * trait.step;
  return Number(Math.min(trait.max, Math.max(trait.min, value)).toFixed(6));
}

/** Localized level readout; pace and the two percentage traits read naturally. */
function formatLevel(t, trait) {
  if (trait.key === 'pace') {
    if (trait.level < 0) return t('memory.profile.pace.slower');
    if (trait.level > 0) return t('memory.profile.pace.faster');
    return t('memory.profile.pace.steady');
  }
  if (trait.key === 'hint_preference' || trait.key === 'example_first') {
    return t('memory.profile.percent', { percent: Math.round(trait.level * 100) });
  }
  return t('memory.profile.levelRange', { value: trait.level, max: trait.max });
}

/** Dictionary segment for one trait key. */
function traitCopyKey(key) {
  return TRAIT_COPY_KEY[key] ?? key;
}

/** Stable dictionary token for a numeric level. */
function levelToken(level) {
  if (level < 0) return 'minus1';
  if (level === 0) return 'zero';
  if (level === 0.5) return 'half';
  return ['zero', 'one', 'two', 'three', 'four', 'five'][level] ?? String(level);
}

/**
 * Pick the text shown for a failed call: a localized line for transport
 * failures, the host's own message for service failures.
 * @param {Function} t - Translator.
 * @param {unknown} error - Rejection value.
 * @returns {string} Display text.
 */
function describeError(t, error) {
  if (error instanceof Error && error.code === 'network') return t('common.networkError');
  return error instanceof Error ? error.message : String(error);
}
