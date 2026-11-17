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
import { createPlanCreation } from './lib/plan-creation.js';

/** Dictionary namespace and slot locale shared by every study page. */
export const NS = 'study-facts';

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
      // The study database stores only Workspace ids; the live DSH Workspace
      // list resolves titles and paths for every study page.
      const workspaceList = {
        getSnapshot: () => null,
        subscribe: () => () => {},
      };
      ctx.inject?.(['uiWorkspace', 'workspaces', 'sessions', 'layout'], scope => {
        workspaceList.getSnapshot = () => scope.workspaces.list.getSnapshot();
        workspaceList.subscribe = listener => scope.workspaces.list.subscribe(listener);
        activity.openSession = id => scope.uiWorkspace.openSession(id);
        activity.openTimer = () => scope.layout.selectPanel('timer');
        activity.ensureSession = async () => {
          const rows = scope.sessions.list.getSnapshot().byId ?? {};
          const current = Object.values(rows).find(row => (row.retainedBy?.mainView ?? 0) > 0);
          if (current) return current.id;
          const workspaces = scope.workspaces.list.getSnapshot().items ?? [];
          const workspace = workspaces[0] ?? await scope.workspaces.initializeDefault();
          if (!workspace) throw new Error(t('daily.sessionUnavailable'));
          const id = await scope.uiWorkspace.connectWorkspace(workspace.workspaceId);
          scope.uiWorkspace.openSession(id);
          return id;
        };
        // "Plan with the assistant": create a blank conversation, store the form
        // snapshot for its first step, then open it with an opening message.
        // The planning route owns the instructions; this only sequences creation
        // before opening so the first requested step can never miss them.
        activity.startPlanCreation = createPlanCreation({
          uiWorkspace: scope.uiWorkspace,
          workspaces: scope.workspaces,
          sessions: scope.sessions,
          getConversation: () => scope.get('conversation'),
          call,
          t,
        });
      });
      for (const page of pageDefinitions) {
        // The registrations wait for the owning slot declarations and leave
        // with this plugin, so a disabled host row removes the entries.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: page.key,
          locale: NS,
          inject: () => ({ call, studyRefresh, actions: registry, activity, workspaceList }),
        }, page.Page));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: page.key,
          order: page.order,
          label: () => t(page.label),
          locale: NS,
        }, ctx.studyUi.StudyPanelIcon));
      }
    },
  };
}
