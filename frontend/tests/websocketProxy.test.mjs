import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('development server proxies websocket reminder traffic to the backend', async () => {
  const viteConfig = await readFile(path.join(frontendRoot, 'vite.config.ts'), 'utf8')

  assert.match(viteConfig, /['"]\/ws['"]\s*:/)
  assert.match(viteConfig, /ws:\s*true/)
})

test('nginx forwards websocket reminder traffic to the backend', async () => {
  const nginxConfig = await readFile(path.join(frontendRoot, 'nginx.conf'), 'utf8')

  assert.match(nginxConfig, /location\s+\/ws/)
  assert.match(nginxConfig, /proxy_set_header\s+Upgrade\s+\$http_upgrade/)
})
