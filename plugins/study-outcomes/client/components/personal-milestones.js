import { createElement as h, useCallback, useEffect, useState } from 'react';
import {
  BADGE_STYLE, BUTTON_PRIMARY_STYLE, BUTTON_STYLE, CARD_STYLE, ERROR_STYLE, FIELD_STYLE,
  INPUT_STYLE, LIST_STYLE, META_STYLE, NOTE_STYLE, PENDING_STYLE, ROW_STYLE,
  SECTION_HEADING_STYLE,
} from '../../../../packages/study-client/ui.js';

/** Layout-only constants; every colour, border and type value comes from ui.js. */
const FORM_STYLE = { display: 'flex', flexDirection: 'column', gap: '12px' };
const PICKER_STYLE = { maxHeight: '180px', overflowY: 'auto', margin: '8px 0' };
const PICKER_ROW_STYLE = { ...ROW_STYLE, justifyContent: 'flex-start', alignItems: 'center', gap: '8px' };
const BADGE_ROW_STYLE = { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'baseline' };
const MILESTONE_MAIN_STYLE = { flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '4px' };
const EVIDENCE_ROW_STYLE = { ...META_STYLE, margin: 0 };

export function PersonalMilestones({ call, t }) {
  const [view, setView] = useState({ items: [], tasks: [], title: '', selected: [], busy: false, error: null });
  const load = useCallback(async () => {
    const [saved, tasks] = await Promise.all([call('milestones', 'listPersonal', {}), call('tasks', 'listTasks', {})]);
    setView(current => ({ ...current, items: saved.value.items, tasks: tasks.value.tasks, busy: false }));
  }, [call]);
  useEffect(() => { let active = true; load().catch(error => { if (active) setView(current => ({ ...current, error: error.message })); }); return () => { active = false; }; }, [load]);
  const run = async (method, payload) => {
    setView(current => ({ ...current, busy: true, error: null }));
    try {
      await call('milestones', method, payload);
      await load();
      if (method === 'savePersonal') setView(current => ({ ...current, title: '', selected: [] }));
    } catch (error) { setView(current => ({ ...current, busy: false, error: error.message })); }
  };
  return PersonalMilestonesView({ create: h, t, view,
    onTitle: title => setView(current => ({ ...current, title })),
    onToggle: id => setView(current => ({ ...current, selected: current.selected.includes(id) ? current.selected.filter(value => value !== id) : [...current.selected, id] })),
    onSave: () => run('savePersonal', { title: view.title, taskIds: view.selected }),
    onDelete: id => run('deletePersonal', { id }),
  });
}

export function PersonalMilestonesView({ create, t, view, onTitle, onToggle, onSave, onDelete }) {
  return create('section', { 'data-testid': 'personal-milestones', style: CARD_STYLE },
    create('div', null,
      create('h2', { style: SECTION_HEADING_STYLE }, t('outcomes.personal.title')),
      create('p', { style: NOTE_STYLE }, t('outcomes.personal.hint'))),
    view.error ? create('p', { role: 'alert', style: ERROR_STYLE }, view.error) : null,
    create('form', { onSubmit: event => { event.preventDefault(); onSave(); }, style: FORM_STYLE },
      create('label', { style: FIELD_STYLE },
        create('span', null, t('outcomes.personal.name')),
        create('input', { 'aria-label': t('outcomes.personal.name'), placeholder: t('outcomes.personal.name'), value: view.title, maxLength: 200, required: true, style: INPUT_STYLE, onChange: event => onTitle(event.target.value) })),
      create('div', { style: PICKER_STYLE }, view.tasks.map(task => create('label', { key: task.id, style: PICKER_ROW_STYLE },
        create('input', { type: 'checkbox', checked: view.selected.includes(task.id), onChange: () => onToggle(task.id) }), task.title))),
      create('button', { type: 'submit', style: BUTTON_PRIMARY_STYLE, disabled: view.busy || !view.title.trim() || !view.selected.length }, t('outcomes.personal.save'))),
    create('ul', { style: LIST_STYLE }, view.items.map(item => create('li', { key: item.id, 'data-testid': `personal-milestone-${item.id}`, style: ROW_STYLE },
      create('div', { style: MILESTONE_MAIN_STYLE },
        create('div', { style: BADGE_ROW_STYLE },
          create('strong', null, `${item.title} · ${item.completed}/${item.total}`),
          create('span', { style: item.earned ? BADGE_STYLE : PENDING_STYLE }, t(item.earned ? 'outcomes.personal.earned' : 'outcomes.personal.pending')),
          item.earnedAt ? create('span', { style: META_STYLE }, item.earnedAt) : null),
        create('details', null,
          create('summary', null, t('outcomes.personal.evidence')),
          create('ul', { style: LIST_STYLE }, item.evidence.map(ref => create('li', { key: ref.taskId, style: EVIDENCE_ROW_STYLE }, `${ref.taskId} · #${ref.recordId} · ${ref.date}`))))),
      create('button', { type: 'button', style: BUTTON_STYLE, disabled: view.busy, onClick: () => onDelete(item.id) }, t('outcomes.personal.delete'))))));
}
