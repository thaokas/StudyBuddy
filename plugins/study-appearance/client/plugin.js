/**
 * StudyBuddy appearance client entry.
 *
 * The bundle registers one locale namespace, one alias-token override layer,
 * one global stylesheet, the sidebar/hero brand slots, and a General settings
 * row. The DSH appearance preference (light/dark/system) stays authoritative:
 * the plugin only stacks its palette over the active base.
 */
import { BrandMark, BrandName, HeroBrandMark } from './brand.js';
import { AppearanceSettings } from './settings.js';
import { createPlugin } from './apply.js';

const plugin = createPlugin({ BrandMark, BrandName, HeroBrandMark, AppearanceSettings });

/** Client services this plugin waits for before applying. */
export const inject = plugin.inject;

/**
 * Install the appearance contribution.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Client root context.
 */
export function apply(ctx) {
  plugin.apply(ctx);
}
