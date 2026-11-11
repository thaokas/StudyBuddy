/**
 * Kernel module: the read-only `kernel.status` service method plus the
 * `study_status` Agent tool. Both read the same service so the model and the
 * UI never see different facts. This module owns no tables.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Module id; matches the `kernel` service namespace. */
export const id = 'kernel';

/** Kernel depends on no other module. */
export const deps = [];

/** No tables. */
export const schema = [];

/** Schema version for a schema-less module (never recorded). */
export const schemaVersion = 1;

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { defineTool } = requireFromSource(join(sourceDirectory, 'packages/core/tools/lib/index.js'));

/**
 * Register the status method and its tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.study.register('kernel', {
    methods: {
      status: (_payload, api) => api.kernel.status(),
    },
    writes: [],
  }), 'study: kernel namespace');

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'study_status',
    description: '只读：返回 StudyBuddy 学习服务的状态（存储文件、修订号、已加载模块、命名空间、当天快照）。'
      + '用于确认学习数据是否可用、是否因版本不兼容被锁定；不会修改或删除任何学习数据。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      const result = await ctx.study.call('kernel', 'status', {}, { actor: 'agent' });
      if (result.ok !== true) throw new Error(`读取学习服务状态失败（${result.code}）：${result.message}`);
      return result.value;
    },
    presentCall: () => ({ card: 'generic', title: '学习状态' }),
  })), 'study: study_status tool');
}
