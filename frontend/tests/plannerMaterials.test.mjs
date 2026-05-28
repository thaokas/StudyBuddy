import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
          contents: `
            globalThis.__plannerClientCalls = []
            export default {
              post(url, data) {
                globalThis.__plannerClientCalls.push({ url, data })
                return Promise.resolve({ data: { id: 'm1', kind: 'link', name: '资料', summary: '摘要', selected: true } })
              }
            }
          `,
          loader: 'js',
        }))
      },
    }],
  })
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64')
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`)
}

test('planner file parser posts multipart attachment', async () => {
  const { agentApi } = await loadPlannerModule()

  await agentApi.parsePlannerFile(new File(['pdf'], 'outline.pdf', { type: 'application/pdf' }))

  const calls = globalThis.__plannerClientCalls
  assert.equal(calls[0].url, '/agent/planner/materials/file')
  assert.ok(calls[0].data instanceof FormData)
  assert.equal(calls[0].data.get('file').name, 'outline.pdf')
})

test('planner link parser posts url json', async () => {
  const { agentApi } = await loadPlannerModule()

  await agentApi.parsePlannerLink('https://example.com/syllabus')

  const calls = globalThis.__plannerClientCalls
  assert.equal(calls[0].url, '/agent/planner/materials/link')
  assert.deepEqual(calls[0].data, { url: 'https://example.com/syllabus' })
})

test('planner page uses approved timeline material and confirm cards', async () => {
  const source = await readFile(path.join(frontendRoot, 'src/pages/PlanCreate.tsx'), 'utf8')

  assert.match(source, /type: 'materials'/)
  assert.match(source, /'confirm'/)
  assert.match(source, /addTimelineCard\('confirm'\)/)
  assert.match(source, /parsePlannerFile/)
  assert.match(source, /parsePlannerLink/)
  assert.match(source, /exam_subjects/)
  assert.doesNotMatch(source, /bg-green-50 border border-green-300/)
})
