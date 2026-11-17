/**
 * StudyBuddy pet client entry.
 *
 * The bundle registers one locale namespace, one stylesheet, the root
 * `shell.overlay` pet, and a Settings → General row. The pet reacts to DSH
 * session activity through the standard `useSessionStatus` hook and optionally
 * to the StudyBuddy timer through `studyClient`; both degradations are silent.
 */
import { PetOverlay } from './pet.js';
import { PetSettings } from './settings.js';
import { createPlugin } from './apply.js';

const plugin = createPlugin({ PetOverlay, PetSettings });

/** Client services this plugin waits for before applying. */
export const inject = plugin.inject;

/**
 * Install the pet contribution.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Client root context.
 */
export function apply(ctx) {
  plugin.apply(ctx);
}
