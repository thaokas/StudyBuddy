import { StudyError } from '../../../packages/study-contracts/index.mjs';
/** Reminders owns followup state and background checks. */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadModuleDefinitions } from '../../../packages/study-model/modules.mjs';
import { migrateReminderFoundation } from '../../../packages/study-model/facts.mjs';
export { loadModuleDefinitions, normalizeModuleDefinition, sortModuleDefinitions } from '../../../packages/study-model/modules.mjs';
export const name = 'study-reminders';
export const inject = ['study', 'tools'];
const Schema = createRequire(new URL('../../../source/deepseek-harness/apps/cli/package.json', import.meta.url))('@deepseek-ai/schemastery');
export const Config = Schema.object({});
export async function apply(ctx) {
  const ready = ctx.study.composition();
  try {
    // Facts is a required product row; a test profile may deliberately omit it.
    if (!['materials', 'tasks', 'plans', 'planning', 'timer'].every(ns => ctx.study.has(ns))) {
      const placeholders = [];
      const unavailable = () => { throw new StudyError('unavailable', 'StudyBuddy requires study-facts; this feature is unavailable', { plugin: 'study-facts' }); };
      placeholders.push(ctx.study.register('followup', { methods: Object.fromEntries(['due', 'claim', 'answer', 'snooze', 'getSettings', 'updateSettings', 'reviewPreview', 'review', 'reviewStatus', 'runDueCheck', 'runReview', 'recovery'].map(method => [method, unavailable])), writes: ['claim', 'answer', 'snooze', 'updateSettings', 'review', 'runDueCheck', 'runReview'] }));
      ctx.effect(() => () => { for (const dispose of placeholders.splice(0)) dispose(); }, 'study: unavailable namespaces');
      // Cordis starts async plugin rows concurrently. This optional readiness
      // service waits for facts without making a missing test row block boot.
      ctx.inject(['studyFactsReady'], async scope => {
        for (const dispose of placeholders.splice(0)) dispose();
        await apply(scope);
      });
      return;
    }
    const definitions = await loadModuleDefinitions(fileURLToPath(new URL('./modules/', import.meta.url)), {
      available: ['materials', 'tasks', 'plans', 'planning', 'timer'],
    });
    for (const definition of definitions) {
      const dispose = await ctx.study.module(definition);
      ctx.effect(() => dispose, `study-reminders: ${definition.id} module`);
    }
    await migrateReminderFoundation(ctx.study.kernel.database);
    for (const definition of definitions) await definition.apply(ctx, ctx.study.kernel);
  } finally {
    ready();
  }
}
