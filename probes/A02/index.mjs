/** A02 only: one shared deterministic store reached by authenticated Fetch and an Agent tool. */
import { createRequire } from 'node:module';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const require = createRequire(join(source, 'apps/cli/package.json'));
const { defineTool } = require(join(source, 'packages/core/tools/lib/index.js'));
export const inject = ['tools', 'connection'];

/** Mount probe service, transport, and tool with the plugin's lifecycle. */
export async function apply(ctx) {
  const filename = join(process.env.DSH_HOME, 'a02-probe', 'value.json');
  await mkdir(dirname(filename), { recursive: true });
  let state;
  try { state = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { value: '', revision: 0, writer: 'initial' }; }
  let tail = Promise.resolve();
  const service = {
    read: () => ({ ...state }),
    write(value, writer) {
      if (typeof value !== 'string' || value.length > 256) throw new Error('Expected a string of at most 256 characters');
      const operation = tail.then(async () => {
        const next = { value, revision: state.revision + 1, writer };
        await writeFile(`${filename}.tmp`, JSON.stringify(next) + '\n');
        await rename(`${filename}.tmp`, filename);
        state = next;
        return service.read();
      });
      tail = operation.catch(() => {}); // A failed write must not prevent a subsequent probe write.
      return operation;
    },
  };
  ctx.provide('a02Probe', service);
  ctx.effect(() => () => tail);
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/a02.value', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.method === 'GET') return Response.json(service.read());
      let body;
      try { body = await request.json(); }
      catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
      if (typeof body?.value !== 'string' || body.value.length > 256) return Response.json({ error: 'Invalid value' }, { status: 400 });
      return Response.json(await service.write(body.value, 'ui'));
    },
  }));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'a02_probe', description: 'A02 disposable probe. Read or write the same value shown on the A02 study page. No learning business logic.',
    parameters: { value: { type: 'string', description: 'Omit to read; supply to write (maximum 256 characters).' } },
    output: {
      schema: { type: 'object', properties: { value: { type: 'string', required: true }, revision: { type: 'number', required: true }, writer: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      return args.value === undefined ? service.read() : service.write(args.value, 'agent');
    },
    presentCall: () => ({ card: 'generic', title: 'A02 probe' }),
  })));
}
