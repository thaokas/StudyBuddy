import { installCompletionNotify } from './notify.js';
import { installFollowupReminders } from './pages/reminders.js';
import { createActionRegistry } from '../../../packages/study-client/actions.js';
import { mergeMessages, normalizePages } from '../../../packages/study-client/definitions.js';

export const NS = 'study-reminders';

/** Register this bundle's page using the core's shared services. */
export function createPlugin({ pages, messages }) {
  const dictionary = mergeMessages(messages);
  const definitions = normalizePages(pages, { dictionary });
  return {
    inject: ['slots', 'locale', 'studyClient', 'studyNav', 'studyUi'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionary), 'study-reminders: dictionaries');
      const t = ctx.locale.bind(NS);
      installCompletionNotify(ctx, { namespace: NS });
      installFollowupReminders(ctx, { namespace: NS, call: ctx.studyClient.call });
      const actions = createActionRegistry([]);
      ctx.effect(() => ctx.studyNav.registerPages(definitions.map(page => page.key)), 'study-reminders: page keys');
      for (const page of definitions) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: page.key, locale: NS,
          inject: () => ({ call: ctx.studyClient.call, actions }),
        }, page.Page));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: page.key, order: page.order,
          label: () => t(page.label), locale: NS,
        }, ctx.studyUi.StudyPanelIcon));
      }
    },
  };
}
