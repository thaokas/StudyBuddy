import { createStudyCall } from './lib/api.js';
import { createStudyRefresh } from './lib/refresh.js';
import { createStudyNav } from './lib/study-page.js';
import { StudyPanelIcon } from './lib/panel-icon.js';
import { ExportSettings } from './export.js';
import { createActionRegistry } from '../../../packages/study-client/actions.js';
import { mergeMessages, normalizeActions, normalizePages } from '../../../packages/study-client/definitions.js';
import { installStudyStyles } from '../../../packages/study-client/ui.js';

export const NS = 'study-core';

/** Assemble core's own pages and the shared services consumed by other bundles. */
export function createPlugin({ pages, messages, actions }) {
  const dictionary = mergeMessages(messages);
  const pageDefinitions = normalizePages(pages, { dictionary });
  const actionDefinitions = normalizeActions(actions, { dictionary, pageKeys: pageDefinitions.map(page => page.key) });
  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      ctx.effect(() => installStudyStyles(), 'study-core: shared page stylesheet');
      ctx.effect(() => ctx.locale.register(NS, dictionary), 'study-core: client dictionaries');
      const t = ctx.locale.bind(NS);
      const studyClient = { call: createStudyCall() };
      const studyRefresh = createStudyRefresh();
      const studyNav = createStudyNav(ctx);
      const studyUi = { StudyPanelIcon };
      for (const [name, service] of Object.entries({ studyClient, studyRefresh, studyNav, studyUi })) ctx.provide(name, service);
      ctx.effect(() => () => { studyRefresh.dispose(); studyNav.dispose(); }, 'study-core: shared services');
      ctx.effect(() => studyNav.registerPages(pageDefinitions.map(page => page.key)), 'study-core: page keys');
      const registry = createActionRegistry(actionDefinitions);
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item', id: 'study.export', order: 42, locale: NS,
        inject: () => ({ t }),
      }, ExportSettings));
      for (const page of pageDefinitions) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: page.key, locale: NS,
          inject: () => ({ call: studyClient.call, studyRefresh, actions: registry }),
        }, page.Page));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: page.key, order: page.order,
          label: () => t(page.label), locale: NS,
        }, StudyPanelIcon));
      }
    },
  };
}
