/**
 * T03 layout probe client bundle.
 *
 * Hand-authored in the same `window.__ModuleLoader__.load` form as
 * `probes/A02/client.js`; not production UI.
 *
 * Two surfaces share one fake study workbench:
 * - Route 1: a tab type registered through `ctx.sidebarRightTabs`, its body
 *   under the keyed `sidebar.right.pane.tab` seat. Opening it puts the study
 *   area in the frame's right column next to the native conversation.
 * - Route 2: when `dock-base` is installed, the same content is registered as
 *   a workbench side panel and editor view through `ctx.workbench`.
 *
 * The content is deliberately fake: a task list, a progress bar and a quick
 * note. The probe measures its own rendered width for the evidence report.
 */
window.__ModuleLoader__.load({
  id: '@studybuddy/layout-probe',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'layoutProbe';
    const TAB_ID = '@studybuddy/layout-probe';
    const TAB_KIND = 'layoutprobe';

    const zh = {
      guideTitle: '学习工作台（探针）',
      guideDescription: '把任务与进度放在对话旁边（T03 布局探针）',
      tab: '学习工作台',
      probeTag: 'T03 布局探针 · 非正式实现',
      today: '2026-11-10 周一',
      todayTasks: '今日任务',
      addTask: '添加任务',
      newTask: '新任务',
      quickNote: '记一笔…',
      progress: '本周进度',
      progressValue: '3 / 8 个时间块',
      focus: '专注计时',
      focusIdle: '未开始 · 25:00',
      width: '当前宽度',
      dockPlugin: 'Study layout probe',
      dockTitle: '学习工作台',
      dockOpenFloat: '在浮窗打开学习区',
      dockOpenEditor: '在 dock 编辑器区打开学习区',
      dockNote: 'dock 侧栏上限 300px；编辑器区在 dock 模式下隐藏。',
      done: '已完成',
      start: '开始',
    };
    const en = {
      guideTitle: 'Study workbench (probe)',
      guideDescription: 'Tasks and progress beside the conversation (T03 layout probe)',
      tab: 'Study workbench',
      probeTag: 'T03 layout probe · disposable',
      today: 'Mon, 2026-11-10',
      todayTasks: "Today's tasks",
      addTask: 'Add task',
      newTask: 'New task',
      quickNote: 'Quick note…',
      progress: 'This week',
      progressValue: '3 / 8 blocks',
      focus: 'Focus timer',
      focusIdle: 'Idle · 25:00',
      width: 'Rendered width',
      dockPlugin: 'Study layout probe',
      dockTitle: 'Study workbench',
      dockOpenFloat: 'Open study area in a floating window',
      dockOpenEditor: 'Open study area in the dock editor area',
      dockNote: 'The dock side panel is capped at 300px; the editor area is hidden in dock mode.',
      done: 'Done',
      start: 'Start',
    };

    const CARD = {
      border: '1px solid var(--dsw-alias-border-l2, #e3e5e8)',
      borderRadius: 10,
      padding: 12,
      background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
    };

    const INITIAL_TASKS = [
      { id: 't1', subject: '数学', title: '极限习题 30 分钟', done: true },
      { id: 't2', subject: '英语', title: '单词复习 20 分钟', done: false },
      { id: 't3', subject: '物理', title: '错题整理', done: false },
    ];

    /**
     * The fake study workbench shared by both routes.
     * @param {{ t: Function, compact?: boolean, widthSource?: object }} props - copy and layout hints.
     */
    function StudySurface({ t, compact, widthSource }) {
      const [tasks, setTasks] = React.useState(INITIAL_TASKS);
      const [note, setNote] = React.useState('');
      const [added, setAdded] = React.useState(0);
      const done = tasks.filter(task => task.done).length;
      const toggle = (id) => setTasks(current => current.map(task => (
        task.id === id ? { ...task, done: !task.done } : task
      )));
      const add = () => {
        const next = added + 1;
        setAdded(next);
        setTasks(current => [...current, {
          id: `new-${next}`,
          subject: t('newTask'),
          title: `${t('newTask')} ${next}`,
          done: false,
        }]);
      };
      return h('div', {
        style: {
          height: '100%',
          overflow: 'auto',
          boxSizing: 'border-box',
          padding: compact ? 12 : 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          background: 'var(--dsw-alias-bg-base, #fafbfc)',
        },
      },
      h('header', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
        h('h1', { style: { fontSize: compact ? 16 : 20, margin: 0 } }, t('tab')),
        h('span', {
          style: {
            fontSize: 11,
            color: 'var(--dsw-alias-label-secondary, #6b7280)',
            border: '1px solid var(--dsw-alias-border-l2, #e3e5e8)',
            borderRadius: 999,
            padding: '2px 8px',
          },
        }, t('probeTag')),
      ),
      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, t('today')),
      widthSource ? h('div', { 'data-testid': 'layout-probe-width', style: { fontSize: 12 } },
        `${t('width')}: ${widthSource}px`) : null,
      h('section', { style: CARD },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('h2', { style: { fontSize: 13, margin: 0, flex: 1 } }, t('todayTasks')),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
            `${done}/${tasks.length} ${t('done')}`),
        ),
        h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
          tasks.map(task => h('li', {
            key: task.id,
            style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
          },
          h('input', {
            type: 'checkbox',
            checked: task.done,
            'aria-label': task.title,
            onChange: () => toggle(task.id),
          }),
          h('span', {
            style: {
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary, #6b7280)',
              minWidth: compact ? 28 : 36,
            },
          }, task.subject),
          h('span', { style: task.done ? { textDecoration: 'line-through', opacity: 0.6 } : undefined }, task.title),
          )),
        ),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
          h('input', {
            'data-testid': 'layout-probe-note',
            placeholder: t('quickNote'),
            value: note,
            onChange: event => setNote(event.target.value),
            style: { flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #d9dde3)' },
          }),
          h('button', {
            'data-testid': 'layout-probe-add',
            onClick: add,
            style: { padding: '5px 10px', borderRadius: 6, cursor: 'pointer' },
          }, t('addTask')),
        ),
      ),
      h('section', { style: CARD },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 } },
          h('strong', null, t('progress')),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, t('progressValue')),
        ),
        h('div', {
          style: { height: 6, borderRadius: 999, background: 'var(--dsw-alias-fill-l3, #e8eaee)', overflow: 'hidden' },
          role: 'progressbar',
          'aria-valuenow': 38,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
        }, h('div', { style: { width: '38%', height: '100%', background: 'var(--dsw-alias-brand-primary, #4f6ef2)' } })),
      ),
      h('section', { style: { ...CARD, display: 'flex', alignItems: 'center', gap: 10 } },
        h('strong', { style: { fontSize: 12 } }, t('focus')),
        h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #6b7280)', flex: 1 } }, t('focusIdle')),
        h('button', { style: { padding: '5px 12px', borderRadius: 6, cursor: 'pointer' } }, t('start')),
      ),
      h('output', { 'data-testid': 'layout-probe-count', style: { fontSize: 12 } }, String(added)),
      compact ? h('p', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #6b7280)', margin: 0 } }, t('dockNote')) : null,
      );
    }

    /**
     * Right-Sidebar tab body (route 1).
     * @param {object} props - slot props; only `useTabInfo` is guaranteed.
     */
    function ProbeTab(props) {
      const ref = React.useRef(null);
      const [width, setWidth] = React.useState(0);
      React.useEffect(() => {
        const element = ref.current;
        if (element === null) return undefined;
        const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
        measure();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        observer?.observe(element);
        return () => observer?.disconnect();
      }, []);
      // useTabInfo is part of the body props contract; reading it here keeps
      // the tab identity in the DOM for the evidence script.
      const tab = typeof props.useTabInfo === 'function' ? props.useTabInfo().tab : undefined;
      return h('div', {
        ref,
        'data-testid': 'layout-probe-panel',
        'data-layout-probe-tab': tab?.id ?? 'unknown',
        style: { height: '100%' },
      }, h(StudySurface, { t: props.t, widthSource: width }));
    }

    /**
     * Workbench side panel (route 2); offers the floating-window action.
     * @param {object} props - dock view props (`ctx`, `viewId`, ...).
     */
    function ProbeSidePanel(props) {
      const workbenchOf = () => props.ctx.workbench ?? props.ctx.get('workbench');
      const openFloating = () => {
        workbenchOf().openView('layout-probe-float', { title: '学习工作台' }, { floating: true });
      };
      const openDocked = () => {
        workbenchOf().openView('layout-probe-study', { title: '学习工作台' });
      };
      return h('div', { 'data-testid': 'layout-probe-dock-panel', style: { height: '100%' } },
        h(StudySurface, { t: props.t, compact: true }),
        h('div', { style: { padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 6 } },
          h('button', {
            'data-testid': 'layout-probe-open-float',
            onClick: openFloating,
            style: { width: '100%', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' },
          }, props.t('dockOpenFloat')),
          h('button', {
            'data-testid': 'layout-probe-open-docked',
            onClick: openDocked,
            style: { width: '100%', padding: '6px 10px', borderRadius: 6, cursor: 'pointer' },
          }, props.t('dockOpenEditor')),
        ),
      );
    }

    /**
     * Workbench editor view (route 2), auto-registered but hidden in dock mode.
     * @param {object} props - dock view props.
     */
    function ProbeEditorView(props) {
      return h('div', { 'data-testid': 'layout-probe-dock-view', style: { height: '100%' } },
        h(StudySurface, { t: props.t }),
      );
    }

    /**
     * Register the route 1 tab type and body, then the route 2 workbench
     * surface when `ctx.workbench` is available.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'layout-probe: dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => t('tab'),
        keepMounted: true,
        guide: [{
          id: 'study',
          order: 30,
          title: () => t('guideTitle'),
          description: () => t('guideDescription'),
        }],
      }), 'layout-probe: sidebar tab type');

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
      }, ProbeTab)), 'layout-probe: sidebar tab body');

      // Route 2: only active when the third-party dock workbench loaded.
      ctx.inject(['workbench'], scope => {
        const workbench = scope.workbench;
        const view = (component) => (props) => h(component, { ...props, t });
        scope.effect(() => workbench.registerPlugin({
          id: 'layout-probe',
          title: t('dockPlugin'),
          hasEntry: true,
          order: 10,
        }), 'layout-probe: dock plugin');
        scope.effect(() => workbench.registerActivityBarItem({
          id: 'layout-probe-activity',
          pluginId: 'layout-probe',
          title: t('dockTitle'),
          order: 10,
          icon: {
            path: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16.5H6.5A2.5 2.5 0 0 1 4 17V5.5Zm3 0V17M9 7h6M9 11h6',
            stroke: true,
          },
          paneId: 'layout-probe-pane',
        }), 'layout-probe: dock activity item');
        scope.effect(() => workbench.registerPanel({
          id: 'layout-probe-pane',
          region: 'sideBar',
          title: t('dockTitle'),
          order: 10,
          component: view(ProbeSidePanel),
        }), 'layout-probe: dock side panel');
        scope.effect(() => workbench.registerEditorView({
          id: 'layout-probe-study',
          title: t('dockTitle'),
          order: 10,
          component: view(ProbeEditorView),
        }), 'layout-probe: dock editor view');
        scope.effect(() => workbench.registerEditorView({
          id: 'layout-probe-float',
          title: t('dockTitle'),
          order: 11,
          component: view(ProbeEditorView),
        }), 'layout-probe: dock floating view');
      });
    }

    return { inject: ['slots', 'locale', 'sidebarRightTabs'], apply };
  },
});
