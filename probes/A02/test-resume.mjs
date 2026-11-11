/** Read persisted plugin state and an earlier conversation from a restarted Host. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const evidence = fileURLToPath(new URL('../../docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02/', import.meta.url));
const require = createRequire(join(source, 'package.json'));
const { chromium } = require(join(source, 'node_modules/.pnpm/node_modules/playwright'));
const desktop = process.argv.includes('--desktop');
const prefix = desktop ? 'desktop-' : '';
const info = JSON.parse(await readFile(join(evidence, `${desktop ? 'desktop' : 'resume'}-running.json`), 'utf8'));
const before = JSON.parse(await readFile(join(evidence, prefix + 'ui-result.json'), 'utf8'));
const browser = desktop ? await chromium.connectOverCDP(info.origin) : await chromium.launch({ channel: 'msedge', headless: true });
const page = desktop ? browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/')) : await browser.newPage({ locale: 'zh-CN' });
const report = { root: info.root, passed: false };
try {
  if (!desktop) await page.goto(await readFile(join(info.root, 'browser-url.txt'), 'utf8'));
  const dismiss = page.getByRole('button', { name: '继续', exact: true });
  if (await dismiss.count()) await dismiss.click();
  await page.getByRole('button', { name: 'A02 学习探针', exact: true }).click();
  await page.getByRole('button', { name: '读取共享值' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="a02-result"]')?.textContent.includes('agent-saved'));
  report.pluginState = JSON.parse(await page.getByTestId('a02-result').innerText());
  assert.deepEqual(report.pluginState, before.checks.agentWrite);
  await page.getByRole('button', { name: '返回原有对话' }).click();
  await page.getByText('A02 fixture: call a02_probe to', { exact: true }).first().click();
  await page.getByText('A02 adapter stream and tool round trip complete.', { exact: false }).first().waitFor({ timeout: 15000 });
  report.historicalAssistantRestored = true;
  report.historicalPromptRestored = (await page.locator('body').innerText()).includes('A02 fixture: call a02_probe to write agent-saved');
  assert.ok(report.historicalPromptRestored);
  await page.getByRole('button', { name: 'A02 学习探针', exact: true }).click();
  report.selectedSession = await page.getByTestId('a02-session').innerText();
  assert.equal(report.selectedSession, before.checks.selectedSession);
  await page.screenshot({ path: join(evidence, prefix + 'resume-study.png') });
  report.passed = true;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  console.log((await page.locator('body').innerText()).slice(-1800));
} finally {
  await writeFile(join(evidence, prefix + 'resume-ui-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); await browser.close();
}
