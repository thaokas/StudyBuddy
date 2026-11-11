/** Verify storage behavior using a synthetic reference in an isolated provider, never a real Key. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const evidence = fileURLToPath(new URL('../../docs/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02/', import.meta.url));
const require = createRequire(join(source, 'packages/credentials/credentials-local/package.json'));
const { Context } = require('@deepseek-ai/cordis');
const { LocalCredentialProvider } = require(join(source, 'packages/credentials/credentials-local/lib/index.js'));
const { credentialRef } = require('@deepseek-ai/dsh-credentials');
const root = join(source, 'apps/desktop/.desktop-build/a02', `credentials-${Date.now()}`);
await mkdir(root, { recursive: true });
const filename = join(root, 'fake-credentials.yaml');
const ctx = new Context();
const fiber = ctx.plugin(LocalCredentialProvider, { path: filename, watch: false });
await fiber.await();
const ref = credentialRef('A02_FAKE_CREDENTIAL');
const value = 'synthetic-probe-value-no-real-secret';
try {
  await ctx.credentials.set(ref, value);
  assert.equal((await ctx.credentials.resolve(ref)).value, value);
  const plaintextOnDisk = (await readFile(filename, 'utf8')).includes(value);
  assert.equal(plaintextOnDisk, true);
  await ctx.credentials.unset(ref);
  assert.equal((await readFile(filename, 'utf8')).includes(value), false);
  const report = { passed: true, root, syntheticOnly: true, plaintextOnDisk, encryptedAtRest: false,
    windowsAclEnforcedByProvider: false, referenceRemoved: true,
    releaseAction: 'B01/R01 must select protected or session-only storage before accepting real API keys in settings.' };
  await writeFile(join(evidence, 'credentials-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await fiber.dispose(); }
