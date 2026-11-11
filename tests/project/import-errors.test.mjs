import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('malformed imported credentials fail without quoting the secret line', async () => {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const root = join(project, 'source/deepseek-harness/apps/desktop/.desktop-build/project-tests', `import-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const filename = join(root, 'malformed.yaml');
  const secret = 'synthetic-secret-that-must-not-be-logged';
  await writeFile(filename, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${secret}\n`);
  const result = spawnSync(process.execPath, [join(project, 'scripts/start-studybuddy.mjs'), '--prepare-only'], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, STUDYBUDDY_DATA_DIR: join(root, 'data'), STUDYBUDDY_IMPORT_CREDENTIALS: filename },
  });
  assert.notEqual(result.status, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  assert.match(result.stderr, /invalid document/);
});
