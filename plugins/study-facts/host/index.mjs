/** Facts owns goals, materials, plans, execution and timer data. */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadModuleDefinitions } from '../../../packages/study-model/modules.mjs';
import { migrateFoundation } from '../../../packages/study-model/facts.mjs';
export { loadModuleDefinitions } from '../../../packages/study-model/modules.mjs';
export const name = 'study-facts';
export const inject = ['study', 'tools'];
const Schema = createRequire(new URL('../../../source/deepseek-harness/apps/cli/package.json', import.meta.url))('@deepseek-ai/schemastery');
export const Config = Schema.object({});
export async function apply(ctx) {
  const ready = ctx.study.composition();
  try {
    const definitions = await loadModuleDefinitions(fileURLToPath(new URL('./modules/', import.meta.url)));
    for (const definition of definitions) {
      const dispose = await ctx.study.module(definition);
      ctx.effect(() => dispose, `study-facts: ${definition.id} module`);
    }
    const tasks = definitions.find(module => module.id === 'tasks');
    if (!ctx.study.kernel.database.get("SELECT name FROM sqlite_master WHERE name = 'study_task_progress'")) {
      for (const statement of tasks.schema) ctx.study.kernel.database.exec(statement);
    }
    await migrateFoundation(ctx.study.kernel.database);
    for (const definition of definitions) await definition.apply(ctx, ctx.study.kernel);
    ctx.provide('studyFactsReady', Object.freeze({ ready: true }));
  } finally { ready(); }
}
