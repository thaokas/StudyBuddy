/** Test fixture: the production profile loads these as six business plugin rows. */
import * as core from '../../plugins/study-core/host/index.mjs';
import * as facts from '../../plugins/study-facts/host/index.mjs';
import * as reminders from '../../plugins/study-reminders/host/index.mjs';
import * as learning from '../../plugins/study-learning/host/index.mjs';
import * as memory from '../../plugins/study-memory/host/index.mjs';
import * as outcomes from '../../plugins/study-outcomes/host/index.mjs';
export const name = 'study-composition-test';
export const inject = ['tools'];
import { resolveDataDir } from '../../plugins/study-core/host/index.mjs';
export { resolveDataDir };
export { loadModuleDefinitions, normalizeModuleDefinition, sortModuleDefinitions } from '../../plugins/study-outcomes/host/index.mjs';
export async function apply(ctx, config) {
  resolveDataDir(config);
  await ctx.plugin(core, config);
  await ctx.plugin(facts, {});
  await ctx.plugin(learning, {});
  await ctx.plugin(reminders, {});
  await ctx.plugin(memory, {});
  await ctx.plugin(outcomes, {});
  // Legacy fixtures begin after the first read; production leaves this lazy.
  await ctx.get('study').call('kernel', 'status', {});
}
