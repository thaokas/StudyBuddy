import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readSource(relativePath) {
  return readFile(path.join(frontendRoot, relativePath), 'utf8')
}

test('shared application shell stays compact in portrait and widens in landscape', async () => {
  const source = await readSource('src/components/Layout.tsx')

  assert.match(source, /max-w-md landscape:max-w-6xl/)
  assert.match(source, /px-4 pt-4 pb-24 landscape:px-6 landscape:pt-6/)
  assert.match(source, /max-w-md landscape:max-w-6xl mx-auto bg-white/)
})

test('landscape screens use available width for primary content collections', async () => {
  const [home, plans, tasks] = await Promise.all([
    readSource('src/pages/Home.tsx'),
    readSource('src/pages/Plans.tsx'),
    readSource('src/pages/Tasks.tsx'),
  ])

  assert.match(home, /landscape:grid landscape:grid-cols-2/)
  assert.match(plans, /landscape:grid landscape:grid-cols-2/)
  assert.match(tasks, /landscape:grid landscape:grid-cols-2/)
})

test('plan creation chat uses dynamic viewport height and a readable landscape width', async () => {
  const source = await readSource('src/pages/PlanCreate.tsx')

  assert.match(source, /h-\[calc\(100dvh-8rem\)\]/)
  assert.match(source, /landscape:h-\[calc\(100dvh-7rem\)\]/)
  assert.match(source, /landscape:max-w-4xl landscape:mx-auto/)
})
