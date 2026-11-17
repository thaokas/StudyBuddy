/**
 * Assembly for the StudyBuddy pet plugin.
 *
 * Keeping assembly separate from the React components lets Node tests drive
 * `apply` with stub slot components and a fake document while the shipped
 * `plugin.js` wires the real pet and settings row.
 *
 * Both registrations share one `createPetStore` handle, so the settings row's
 * visibility switch, the pet's hide action, the size chips, and the dragged
 * position are one snapshot. The optional StudyBuddy timer integration reads
 * `ctx.get('studyClient')` on every poll and silently returns nothing when the
 * service is absent or the call fails.
 */
import { DICTIONARY, NS } from './dictionary.js';
import { installStyleSheet } from './style.js';
import { createPetStore, resolveStorage } from './store.js';
import { readVoicePack } from './voice-pack.js';

/** Slot key of the root overlay the pet floats in. */
export const PET_SLOT = 'shell.overlay';
/** Registration id of the pet inside {@link PET_SLOT}. */
export const PET_ID = 'study.pet';
/** Slot key of the General settings rows. */
export const SETTINGS_SLOT = 'settings.general.item';
/** Registration id of the pet row inside {@link SETTINGS_SLOT}. */
export const SETTINGS_ID = 'study.pet';
/** Row position among the General settings items (after appearance at 35). */
export const SETTINGS_ORDER = 36;
/** Optional StudyBuddy timer poll interval; the brief requires at least 15 s. */
export const TIMER_POLL_MS = 20_000;

/**
 * Build the client plugin contribution.
 * @param {{
 *   PetOverlay: Function,
 *   PetSettings: Function,
 *   dictionary?: object,
 *   documentTarget?: Document,
 *   storeOptions?: object,
 * }} options - Components and injectable edges.
 * @returns {{ inject: string[], apply: (ctx: object) => void }} Client plugin.
 */
export function createPlugin({
  PetOverlay,
  PetSettings,
  dictionary = DICTIONARY,
  documentTarget = globalThis.document,
  storeOptions = {},
}) {
  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      const storage = resolveStorage(storeOptions);
      const store = createPetStore({
        ...storeOptions,
        storage: { local: storage },
      });
      ctx.effect(() => () => store.dispose(), 'study-pet: store');
      ctx.effect(() => ctx.locale.register(NS, dictionary), 'study-pet: dictionaries');
      ctx.effect(() => installStyleSheet(documentTarget), 'study-pet: stylesheet');

      const actions = {
        setEnabled: value => { store.setEnabled(value); },
        setChatter: value => { store.setChatter(value); },
        setSize: value => { store.setSize(value); },
        setPosition: position => { store.setPosition(position); },
      };

      /**
       * Read the StudyBuddy timer status when the service exists.
       * @returns {Promise<object | null>} `{ session, lastFinished }`, or null when unavailable.
       */
      async function pollTimer() {
        const client = ctx.get('studyClient');
        if (client === null || client === undefined || typeof client.call !== 'function') return null;
        try {
          const envelope = await client.call('timer', 'status');
          const value = envelope?.value;
          if (value === null || typeof value !== 'object') return null;
          return { session: value.session ?? null, lastFinished: value.lastFinished ?? null };
        } catch {
          // The timer integration is optional: a missing or failing study service never surfaces as a pet error.
          return null;
        }
      }

      /** @returns {object | null} Validated stored voice pack, or null. */
      function readVoice() {
        return readVoicePack(storage, { warn: storeOptions.warn });
      }

      ctx.slots.inject(PET_SLOT, () => ctx.slots.register({
        name: PET_SLOT,
        id: PET_ID,
        locale: NS,
        inject: () => ({
          hooks: { pet: store.source, locale: ctx.locale },
          pollTimer,
          readVoice,
          actions,
        }),
      }, PetOverlay));

      ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
        name: SETTINGS_SLOT,
        id: SETTINGS_ID,
        order: SETTINGS_ORDER,
        locale: NS,
        inject: () => ({
          hooks: { pet: store.source },
          ...actions,
        }),
      }, PetSettings));
    },
  };
}
