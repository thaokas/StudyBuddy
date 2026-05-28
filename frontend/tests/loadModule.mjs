import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function loadSourceModule(relativePath) {
  const result = await build({
    entryPoints: [path.join(frontendRoot, relativePath)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    jsx: 'automatic',
    write: false,
    logLevel: 'silent',
    alias: {
      '@': path.join(frontendRoot, 'src'),
    },
  })

  const source = result.outputFiles[0].text
  const encoded = Buffer.from(source).toString('base64')
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`)
}

export async function maybeLoadSourceModule(relativePath) {
  try {
    return await loadSourceModule(relativePath)
  } catch {
    return undefined
  }
}
