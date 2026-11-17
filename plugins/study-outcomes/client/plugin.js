/**
 * StudyBuddy client plugin body: turns the generated page, dictionary and
 * action modules into one Cordis client plugin.
 *
 * The generated barrel (`client/.build/entry.js`) calls `createPlugin` with
 * what it imported and re-exports `inject` / `apply`; the DSH client module
 * system reads those two names off the bundle. Validation runs here, at module
 * evaluation time, so a malformed contribution fails the bundle load loudly
 * instead of rendering a half page.
 */
import { createActionRegistry } from '../../../packages/study-client/actions.js';
import { mergeMessages, normalizeActions, normalizePages } from '../../../packages/study-client/definitions.js';
import { installMilestoneFeedback } from './components/feedback.js';

/** Dictionary namespace and slot locale shared by every study page. */
export const NS = 'study-outcomes';

/**
 * Validate the assembled contributions and build the plugin.
 * @param {{
 *   pages: Array<{ file: string, definition: unknown }>,
 *   messages: Array<{ file: string, dictionary: unknown }>,
 *   actions: Array<{ file: string, definition: unknown }>,
 * }} contributions - Modules the generated barrel imported.
 * @returns {{ inject: string[], apply: (ctx: object) => void }} Client plugin.
 */
export function createPlugin({ pages, messages, actions }) {
  const dictionary = mergeMessages(messages);
  const pageDefinitions = normalizePages(pages, { dictionary });
  const actionDefinitions = normalizeActions(actions, {
    dictionary,
    pageKeys: pageDefinitions.map(page => page.key),
  });

  return {
    inject: ['slots', 'locale', 'studyClient', 'studyRefresh', 'studyNav', 'studyUi'],
    /**
     * Register the dictionaries, the action registry, and every page's main
     * and sidebar entry with the owning plugin.
     * @param {import('@deepseek-ai/cordis').Context} ctx - Client root context.
     */
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionary), 'study: client dictionaries');
      const t = ctx.locale.bind(NS);
      const registry = createActionRegistry(actionDefinitions);
      const call = ctx.studyClient.call;
      const studyRefresh = ctx.studyRefresh;
      ctx.effect(() => ctx.studyNav.registerPages(pageDefinitions.map(page => page.key)), 'study: page keys');
      const activity = {};
      for (const page of pageDefinitions) {
        // The registrations wait for the owning slot declarations and leave
        // with this plugin, so a disabled host row removes the entries.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: page.key,
          locale: NS,
          inject: () => ({ call, studyRefresh, actions: registry, activity }),
        }, page.Page));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: page.key,
          order: page.order,
          label: () => t(page.label),
          locale: NS,
        }, ctx.studyUi.StudyPanelIcon));
      }
      // Milestone feedback contributes a quiet overlay toast/card driven by the
      // local `milestones` read routes; it never calls a model.
      installMilestoneFeedback(ctx, { namespace: NS, call });
    },
  };
}
