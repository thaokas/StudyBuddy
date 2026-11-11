/**
 * Remember and restore the last study page the student opened.
 *
 * This preference belongs to the study plugin, not to the page components: the
 * frame's main panel is shared with the native Conversation and the other
 * plugins, so the plugin records only its own page keys and leaves every other
 * selection alone. A restart returns to the study page the student left open,
 * otherwise the Conversation stays the starting view.
 */
import { createStorageArea, removeValue, writeValue } from './storage.js';

/** Storage key of the last study page opened in the main panel. */
export const PAGE_KEY = 'study.layout.page';

/**
 * Read the last study page the student opened.
 * @param {{ getItem: (key: string) => string | null }} storage - Storage area.
 * @returns {string | null} Page key, or null when nothing was saved.
 */
export function readLastPage(storage) {
  const raw = storage?.getItem(PAGE_KEY);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Record the study page whenever it becomes the selected main panel, and clear
 * the record when the conversation becomes the main panel again.
 * @param {object} layout - `ctx.layout` face.
 * @param {string[]} pageKeys - Main-panel keys owned by this plugin.
 * @param {{ setItem: (key: string, value: string) => void, removeItem: (key: string) => void }} storage - Storage area.
 * @returns {() => void} Subscription disposer.
 */
export function rememberLastPage(layout, pageKeys, storage) {
  if (typeof layout?.panelInfo?.subscribe !== 'function') return () => {};
  const keys = new Set(Array.isArray(pageKeys) ? pageKeys : []);
  return layout.panelInfo.subscribe(() => {
    const active = layout.panelInfo.getSnapshot()?.activePanelId ?? null;
    if (active === null) {
      removeValue(storage, PAGE_KEY);
      return;
    }
    if (typeof active === 'string' && keys.has(active)) writeValue(storage, PAGE_KEY, active);
  });
}

/**
 * Select the last study page once it is registered.
 *
 * The plugin's page registrations resolve asynchronously against the frame's
 * `main` declaration, so this waits for the entry instead of assuming it exists.
 * A stale page key (an uninstalled page) is left alone and the Conversation
 * stays the starting view.
 * @param {object} ctx - Client context carrying `slots`.
 * @param {object} layout - `ctx.layout` face.
 * @param {string[]} pageKeys - Main-panel keys owned by this plugin.
 * @param {{ getItem: (key: string) => string | null }} storage - Storage area.
 * @returns {() => void} Subscription disposer.
 */
export function restoreLastStudyPage(ctx, layout, pageKeys, storage) {
  const keys = new Set(Array.isArray(pageKeys) ? pageKeys : []);
  const saved = readLastPage(storage);
  if (saved === null || !keys.has(saved)) return () => {};
  if (typeof layout?.selectPanel !== 'function' || typeof ctx?.slots?.subscribe !== 'function') return () => {};
  let restored = false;
  const attempt = () => {
    if (restored) return;
    const entries = ctx.slots.entries('main') ?? [];
    if (!entries.some(entry => entry.options?.key === saved)) return;
    restored = true;
    try {
      layout.selectPanel(saved);
    } catch (error) {
      restored = false;
      console.warn(`[study] the last page "${saved}" was not restored (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  const unsubscribe = ctx.slots.subscribe('main', attempt);
  attempt();
  return unsubscribe;
}

/**
 * Install the last-page preference on the layout service.
 *
 * The layout service is taken through an in-place `ctx.inject`, so a client
 * without it simply keeps the Conversation as the entry and does not fail the
 * plugin load.
 * @param {object} ctx - Client plugin context (`slots`, `locale`, `effect`, `inject`).
 * @param {{ pageKeys?: string[] }} [options] - Main-panel keys this plugin registers.
 * @returns {void}
 */
export function installStudyPageRestore(ctx, options = {}) {
  if (typeof ctx?.inject !== 'function') return;
  const pageKeys = Array.isArray(options.pageKeys) ? options.pageKeys : [];
  ctx.inject(['layout'], (scope) => {
    const layout = scope.layout;
    if (typeof layout?.selectPanel !== 'function') return;
    const storage = createStorageArea();
    scope.effect(() => rememberLastPage(layout, pageKeys, storage), 'study: remember the last page');
    scope.effect(() => restoreLastStudyPage(scope, layout, pageKeys, storage), 'study: restore the last page');
  });
}
