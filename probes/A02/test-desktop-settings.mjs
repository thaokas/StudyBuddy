/** Inspect the isolated Desktop's model setting entry and its public bridge without revealing fields. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const evidence = fileURLToPath(new URL('../../docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02/', import.meta.url));
const require = createRequire(join(source, 'package.json'));
const { chromium } = require(join(source, 'node_modules/.pnpm/node_modules/playwright'));
const info = JSON.parse(await readFile(join(evidence, 'desktop-running.json'), 'utf8'));
const browser = await chromium.connectOverCDP(info.origin);
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/'));
const report = { root: info.root, passed: false, credentialValueRead: false };
try {
  // Inspect the Models page opened in the owned A02 test window.
  const models = page.getByText('已检测到环境变量（DEEPSEEK_API_KEY）', { exact: true });
  await models.waitFor({ timeout: 10000 });
  report.modelSettingsEntry = true;
  report.environmentReferenceVisible = true;
  await page.screenshot({ path: join(evidence, 'desktop-model-settings.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  report.applicationUrl = page.url();
  assert.equal(report.applicationUrl, 'dsh-app://app/');
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally { await writeFile(join(evidence, 'desktop-settings-result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); await browser.close(); }
