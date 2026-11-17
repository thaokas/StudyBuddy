/**
 * React-free assembly for the StudyBuddy appearance plugin.
 *
 * Keeping the assembly separate from the artwork imports lets Node tests drive
 * `apply` with stub slot components and a fake document while the shipped
 * `plugin.js` wires the real React components and bundled buddy image.
 */
import { createAppearanceStore } from './appearance-store.js';
import { DICTIONARY, NS } from './dictionary.js';
import { installStyleSheet } from './style.js';
import { SOURCE, tokenLayer } from './theme.js';

/** Slot key of the General settings rows the appearance control renders into. */
export const SETTINGS_SLOT = 'settings.general.item';
/** Registration id of the appearance row inside {@link SETTINGS_SLOT}. */
export const SETTINGS_ID = 'study.appearance';
/** Row position among the General settings items (before reply reminders at 40). */
export const SETTINGS_ORDER = 35;

/**
 * Stack the token layer for the current store snapshot.
 * @param {object} store - Appearance store.
 * @returns {Record<string, { light: string, dark: string }>} Token override layer.
 */
function currentTokenLayer(store) {
  const { lightPack, darkPack, enabled } = store.snapshot;
  return tokenLayer(lightPack, darkPack, enabled);
}

/**
 * Build the client plugin contribution.
 * @param {{
 *   BrandMark: Function,
 *   BrandName: Function,
 *   HeroBrandMark: Function,
 *   AppearanceSettings: Function,
 *   dictionary?: object,
 *   documentTarget?: Document,
 *   storeOptions?: object,
 * }} options - Components and injectable edges.
 * @returns {{ inject: string[], apply: (ctx: object) => void }} Client plugin.
 */
export function createPlugin({
  BrandMark,
  BrandName,
  HeroBrandMark,
  AppearanceSettings,
  dictionary = DICTIONARY,
  documentTarget = globalThis.document,
  storeOptions,
}) {
  return {
    inject: ['slots', 'theme', 'locale'],
    apply(ctx) {
      const store = createAppearanceStore(storeOptions);
      ctx.effect(() => () => store.dispose(), 'study-appearance: store');
      ctx.effect(() => ctx.locale.register(NS, dictionary), 'study-appearance: dictionaries');

      ctx.effect(() => {
        let dispose = ctx.theme.overrideTokens(SOURCE, currentTokenLayer(store));
        const off = store.source.subscribe(() => {
          dispose();
          dispose = ctx.theme.overrideTokens(SOURCE, currentTokenLayer(store));
        });
        return () => {
          off();
          dispose();
        };
      }, 'study-appearance: theme tokens');

      ctx.effect(() => installStyleSheet(documentTarget, store), 'study-appearance: stylesheet');

      ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register(
        { name: 'sidebar.brand.mark', priority: -1 },
        BrandMark,
      ));
      ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
        { name: 'sidebar.brand.name', priority: -1 },
        BrandName,
      ));
      ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register(
        { name: 'conversation.hero.brand.mark', priority: -1 },
        HeroBrandMark,
      ));
      ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
        name: SETTINGS_SLOT,
        id: SETTINGS_ID,
        order: SETTINGS_ORDER,
        locale: NS,
        inject: () => ({
          hooks: { appearance: store.source },
          setEnabled: store.setEnabled,
          setLightPack: store.setLightPack,
          setDarkPack: store.setDarkPack,
        }),
      }, AppearanceSettings));
    },
  };
}
