import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WindowsCredentials } from '../../platform/windows-credentials/index.mjs';

const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const require = createRequire(join(source, 'packages/credentials/credentials-local/package.json'));
const { Context } = require('@deepseek-ai/cordis');
const root = join(source, 'apps/desktop/.desktop-build/project-tests', `credentials-${Date.now()}`);
await mkdir(root, { recursive: true });
const filename = join(root, 'credentials.dpapi');
async function boot() {
  const ctx = new Context();
  const fiber = ctx.plugin(WindowsCredentials, { path: filename });
  await fiber.await();
  return { ctx, dispose: () => fiber.dispose() };
}

test('DSH credential references and records persist encrypted and remain editable after restart', async () => {
  const first = await boot();
  try {
    await first.ctx.credentials.set('PROJECT_TEST_API_KEY', 'synthetic-key-123');
    assert.deepEqual(await first.ctx.credentials.describe('PROJECT_TEST_API_KEY'), { configured: true, source: 'file', writable: true });
    assert.equal((await first.ctx.credentials.resolve('PROJECT_TEST_API_KEY')).value, 'synthetic-key-123');
    assert.ok(!(await readFile(filename, 'utf8')).includes('synthetic-key-123'));
    await first.ctx.credentials.modifyRecord('llm-pi-ai/example', async () => ({ kind: 'api-key', key: 'synthetic-record-key' }));
  } finally { await first.dispose(); }
  const second = await boot();
  try {
    assert.equal((await second.ctx.credentials.resolve('PROJECT_TEST_API_KEY')).value, 'synthetic-key-123');
    assert.equal((await second.ctx.credentials.readRecord('llm-pi-ai/example')).key, 'synthetic-record-key');
    await second.ctx.credentials.unset('PROJECT_TEST_API_KEY');
    await second.ctx.credentials.deleteRecord('llm-pi-ai/example');
    assert.equal(await second.ctx.credentials.resolve('PROJECT_TEST_API_KEY'), undefined);
    assert.deepEqual(await second.ctx.credentials.listRecords(), []);
  } finally { await second.dispose(); }
});

test('independent writers retain each other’s changes', async () => {
  const a = await boot(), b = await boot();
  try {
    await Promise.all([a.ctx.credentials.set('PROJECT_TEST_A', 'first'), b.ctx.credentials.set('PROJECT_TEST_B', 'second')]);
    assert.equal((await a.ctx.credentials.resolve('PROJECT_TEST_B')).value, 'second');
    assert.equal((await b.ctx.credentials.resolve('PROJECT_TEST_A')).value, 'first');
  } finally { await a.dispose(); await b.dispose(); }
});

test('a credential save waits for a long record refresh held by another writer', async () => {
  const a = await boot(), b = await boot();
  const entered = Promise.withResolvers();
  try {
    const refresh = a.ctx.credentials.modifyRecord('llm-pi-ai/slow', async () => {
      entered.resolve();
      await new Promise(resolve => setTimeout(resolve, 2500));
      return { kind: 'api-key', key: 'synthetic-refreshed' };
    });
    await entered.promise;
    await Promise.all([refresh, b.ctx.credentials.set('PROJECT_TEST_DURING_REFRESH', 'retained')]);
    assert.equal((await a.ctx.credentials.resolve('PROJECT_TEST_DURING_REFRESH')).value, 'retained');
  } finally { await a.dispose(); await b.dispose(); }
});
