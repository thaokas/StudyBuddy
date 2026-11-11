/** Hand-authored loader fixture, following the upstream fixture plugins; not production UI. */
window.__ModuleLoader__.load({
  id: '@studybuddy-probe/a02',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    return {
      inject: ['slots', 'locale', 'layout', 'sessions'],
      apply(ctx) {
        const NS = 'a02Probe';
        const en = { panel: 'A02 study probe', title: 'Study page placeholder', value: 'Probe value', save: 'Save shared value', refresh: 'Read shared value', back: 'Return to conversation', session: 'Selected session', disclaimer: 'Disposable extension probe — no learning business logic.' };
        const zh = { panel: 'A02 学习探针', title: '学习页占位', value: '探针值', save: '保存共享值', refresh: '读取共享值', back: '返回原有对话', session: '所选会话', disclaimer: '仅用于扩展验证，不包含学习业务。' };
        ctx.effect(() => ctx.locale.register(NS, { en, zh }));
        const t = ctx.locale.bind(NS);
        function Page() {
          const [value, setValue] = React.useState('');
          const [result, setResult] = React.useState('');
          const [error, setError] = React.useState('');
          const catalog = React.useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot);
          const session = Object.values(catalog.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id ?? null;
          const invoke = async (write) => {
            try {
              const response = await fetch('api/a02.value', write ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) } : {});
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const record = await response.json();
              setResult(JSON.stringify(record)); setValue(record.value); setError('');
            } catch (failure) { setError(String(failure)); }
          };
          return h('section', { style: { padding: 32, maxWidth: 720 }, 'data-testid': 'a02-study-page' },
            h('h1', null, t('title')), h('p', null, t('disclaimer')),
            h('p', { 'data-testid': 'a02-session' }, `${t('session')}: ${JSON.stringify(session)}`),
            h('label', null, t('value'), h('input', { 'aria-label': t('value'), value, maxLength: 256, onChange: e => setValue(e.target.value) })),
            h('p', null, h('button', { onClick: () => invoke(true) }, t('save')), ' ', h('button', { onClick: () => invoke(false) }, t('refresh'))),
            h('output', { 'data-testid': 'a02-result' }, result), h('p', { role: 'alert' }, error),
            h('button', { onClick: () => ctx.layout.selectPanel(null) }, t('back')));
        }
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'a02-study', locale: NS }, Page));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'a02-study', order: -10, label: () => t('panel'), locale: NS }, () => h('span', null, 'A02')));
      },
    };
  },
});
