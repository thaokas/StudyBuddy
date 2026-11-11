import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { prepareProfile, deploymentPolicy } from '../../scripts/project-config.mjs';

test('first-run defaults retain thinking levels and later native model edits', async () => {
  const root = fileURLToPath(new URL(`../../source/deepseek-harness/apps/desktop/.desktop-build/project-tests/config-${Date.now()}/`, import.meta.url));
  const first = await prepareProfile(root);
  const text = await readFile(first.profilePatch, 'utf8');
  assert.match(text, /studybuddy-deepseek/);
  assert.match(text, /anthropic-messages/);
  assert.match(text, /reasoningEfforts/);
  assert.doesNotMatch(text, /thinking: disabled|maxTokens: 1024/);
  await writeFile(first.profilePatch, text + '\n# Native user customization\n');
  await prepareProfile(root);
  assert.equal(await readFile(first.profilePatch, 'utf8'), text + '\n# Native user customization\n');
  const policy = deploymentPolicy(root);
  for (const id of ['deepseek-account', 'llm-deepseek-account', 'ui-settings-account', 'account-controller']) {
    assert.equal(policy.find(row => row.id === id)?.disabled, true);
  }
  assert.equal(policy.some(row => row.id === 'llm-pi-ai' || row.id === 'llm-deepseek'), false);
  assert.ok(first.home.startsWith(root));
  assert.equal(first.credentialPath, join(first.home, 'credentials.dpapi'));
});
