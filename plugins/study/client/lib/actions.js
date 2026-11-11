/**
 * Action registry: every page renders the buttons declared by
 * `client/actions/*.js` for its own key, so a later task adds a button by
 * adding a file instead of editing the page it appears on.
 *
 * An action without `page` is offered to every page; its `run(context)` gets
 * the caller's `{ call, reload }` face and may return a promise.
 */

/**
 * Create the registry over validated action definitions.
 * @param {Array<{ id: string, page?: string, label: string, run: Function }>} definitions - Normalized actions.
 * @returns {{
 *   forPage: (pageKey: string) => Array<{ id: string, label: string }>,
 *   run: (id: string, context?: object) => Promise<unknown>,
 * }} Registry; `forPage` keeps declaration order.
 */
export function createActionRegistry(definitions) {
  const byId = new Map(definitions.map(definition => [definition.id, definition]));
  return {
    forPage(pageKey) {
      return definitions
        .filter(definition => definition.page === undefined || definition.page === pageKey)
        .map(({ id, label }) => ({ id, label }));
    },
    async run(id, context = {}) {
      const definition = byId.get(id);
      if (definition === undefined) throw new Error(`未知界面动作：${id}`);
      return await definition.run(context);
    },
  };
}
