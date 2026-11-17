import { createElement as h, useState } from 'react';

/** The authenticated export route creates one local file; the app shows its receipt. */
export async function requestStudyExport(selection, transport = globalThis.fetch) {
  const response = await transport('api/study/export.json', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection),
  });
  const envelope = await response.json();
  if (envelope?.ok !== true) throw new Error(envelope?.message ?? `HTTP ${response.status}`);
  return envelope.value;
}

export function ExportSettings({ t }) {
  const [period, setPeriod] = useState('all');
  const [includeFacts, setIncludeFacts] = useState(true);
  const [view, setView] = useState({ phase: 'idle' });
  const submit = async () => {
    setView({ phase: 'saving' });
    try {
      const value = await requestStudyExport({ periods: period === 'all' ? ['day', 'week', 'month'] : [period], includeFacts });
      setView({ phase: 'ready', value });
    } catch (error) { setView({ phase: 'error', message: error.message }); }
  };
  return ExportSettingsView({ create: h, t, period, includeFacts, view, onPeriod: setPeriod, onFacts: setIncludeFacts, onExport: submit });
}

export function ExportSettingsView({ create, t, period, includeFacts, view, onPeriod, onFacts, onExport }) {
  return create('section', { 'data-testid': 'study-export', style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 0', fontSize: '13px' } },
    create('strong', null, t('export.title')),
    create('p', { style: { margin: 0, opacity: 0.7 } }, t('export.description')),
    create('label', null, t('export.period'), ' ', create('select', { value: period, onChange: event => onPeriod(event.target.value) },
      ['all', 'day', 'week', 'month'].map(key => create('option', { key, value: key }, t(`export.${key}`))))),
    create('label', null, create('input', { type: 'checkbox', checked: includeFacts, onChange: event => onFacts(event.target.checked) }), t('export.facts')),
    create('button', { type: 'button', disabled: view.phase === 'saving', onClick: onExport }, t(view.phase === 'saving' ? 'export.saving' : 'export.submit')),
    view.phase === 'ready' ? create('p', { role: 'status', style: { wordBreak: 'break-all' } },
      t('export.saved'), ' ', view.value.path, ` · ${view.value.bytes} B · revision ${view.value.revision}`,
      view.value.availability?.outcomes?.available === false ? ` · ${t('export.unavailable')} (${view.value.availability.outcomes.reason})` : '') : null,
    view.phase === 'error' ? create('p', { role: 'alert' }, view.message) : null);
}
