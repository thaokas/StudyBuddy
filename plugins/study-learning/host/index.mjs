import { StudyError } from '../../../packages/study-contracts/index.mjs';
/** Learning owns tutoring context, evidence, Q&A units and reports. */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadModuleDefinitions } from '../../../packages/study-model/modules.mjs';
export { loadModuleDefinitions, normalizeModuleDefinition, sortModuleDefinitions } from '../../../packages/study-model/modules.mjs';
export const name = 'study-learning';
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
      placeholders.push(ctx.study.register('tutoring', { methods: Object.fromEntries(['open', 'flush', 'close', 'brief', 'context'].map(method => [method, unavailable])), writes: ['open', 'flush', 'close'] })); // study: unavailable tutoring
      placeholders.push(ctx.study.register('learning', { methods: Object.fromEntries(['capture', 'list', 'get', 'stats', 'windowStatus', 'sealWindow', 'summarizeWindow', 'summaries', 'merge', 'split', 'refreshTopics', 'weakTopics', 'methodSignals', 'prune', 'export'].map(method => [method, unavailable])), writes: ['capture', 'sealWindow', 'summarizeWindow', 'merge', 'split', 'refreshTopics', 'prune'] })); // study: unavailable learning
      placeholders.push(ctx.study.register('review', { methods: Object.fromEntries(['week', 'month', 'list', 'save'].map(method => [method, unavailable])), writes: ['week', 'month', 'save'] })); // study: unavailable review
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
      ctx.effect(() => dispose, `study-learning: ${definition.id} module`);
    }
    for (const definition of definitions) await definition.apply(ctx, ctx.study.kernel);
  } finally {
    ready();
  }
}
