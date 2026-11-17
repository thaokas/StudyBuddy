/** Independent memory plugin; the core owns storage and service lifetime. */
import { createRequire } from 'node:module';
import * as memory from './modules/memory.mjs';

export const name = 'study-memory';
export const inject = ['study', 'tools'];
const Schema = createRequire(new URL('../../../source/deepseek-harness/apps/cli/package.json', import.meta.url))('@deepseek-ai/schemastery');
export const Config = Schema.object({});

export const readContracts = [
  { owner: 'study-facts', table: 'study_goal', columns: ['id', 'active'], version: 1, purpose: 'resolveActiveGoal' },
  { owner: 'study-facts', table: 'study_planning_link', columns: ['session_id', 'goal_id'], version: 1, optional: true, purpose: 'Scope memory to the goal of the current planning session' },
  { owner: 'study-facts', table: 'study_task', columns: ['id', 'goal_id', 'title', 'subject'], version: 1, optional: true, purpose: 'Resolve tutoring task scope and rank related memories by title/subject' },
  { owner: 'study-learning', table: 'study_tutoring_link', columns: ['session_id', 'task_id'], version: 1, optional: true, purpose: 'Resolve current tutoring session scope' },
  { owner: 'study-learning', tables: ['study_episode', 'study_episode_problem', 'study_signal'], version: 1, optional: true, purpose: 'teaching trait evidence; missing tables yield no evidence' },
];

export async function apply(ctx) {
  const ready = ctx.study.composition();
  try {
    const dispose = await ctx.study.module({
      id: memory.id, deps: memory.deps, schemaVersion: memory.schemaVersion,
      schema: memory.schema, readContracts,
    });
    ctx.effect(() => dispose, 'study-memory: module');
    await memory.apply(ctx, ctx.study.kernel);
  } finally {
    ready();
  }
}
