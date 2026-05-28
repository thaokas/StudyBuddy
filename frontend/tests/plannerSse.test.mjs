import assert from 'node:assert/strict'
import { build } from 'esbuild'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadPlannerModule() {
  const result = await build({
    entryPoints: [path.join(frontendRoot, 'src/api/agent.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    plugins: [{
      name: 'stub-api-client',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/client$/ }, () => ({
          path: 'api-client',
          namespace: 'stub',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default {}',
          loader: 'js',
        }))
      },
    }],
  })
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64')
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`)
}

test('planner SSE parses Spring event frames without spaces across stream chunks', async (t) => {
  const { connectPlannerSSE } = await loadPlannerModule()
  const encoder = new TextEncoder()
  const chunks = [
    'event:message\n',
    'data:{"content":"hello from planner"}\n\n',
    'event:done\ndata:{}\n\n',
  ]
  const originalFetch = globalThis.fetch
  const originalLocalStorage = globalThis.localStorage

  globalThis.localStorage = { getItem: () => 'test-token' }
  globalThis.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
  })

  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.localStorage = originalLocalStorage
  })

  const events = []
  let completions = 0
  await new Promise((resolve, reject) => {
    connectPlannerSSE(
      'hello',
      null,
      null,
      (event, data) => events.push([event, data]),
      reject,
      () => {
        completions += 1
        resolve()
      },
    )
  })

  assert.deepEqual(events, [['message', { content: 'hello from planner' }]])
  assert.equal(completions, 1)
})
