/** Cancel an actual streaming turn from the shipped composer against the local adapter fixture. */
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
const info = JSON.parse(await readFile(join(evidence, `${desktop ? 'desktop' : 'local'}-running.json`), 'utf8'));
const browser = desktop ? await chromium.connectOverCDP(info.origin) : await chromium.launch({ channel: 'msedge', headless: true });
const page = desktop ? browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/')) : await browser.newPage({ locale: 'zh-CN' });
const report = { root: info.root, passed: false };
try {
  if (!desktop) await page.goto(await readFile(join(info.root, 'browser-url.txt'), 'utf8'));
  const dismiss = page.getByRole('button', { name: '继续', exact: true });
  if (await dismiss.count()) await dismiss.click();
  const closeSettings = page.getByRole('button', { name: '关闭', exact: true });
  if (await closeSettings.isVisible()) await closeSettings.click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill('A02 stream cancellation fixture.');
  await editor.press('Enter');
  const stop = page.getByRole('button', { name: '停止生成', exact: true });
  await stop.waitFor({ timeout: 30000 });
  await page.getByText('A02 adapter stream', { exact: false }).last().waitFor({ timeout: 15000 });
  report.partialTextObserved = true;
  if (await closeSettings.isVisible()) await closeSettings.click();
  await stop.click();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 15000 });
  const body = await page.locator('body').innerText();
  assert.match(body, /已取消|已停止|已中断|中断|停止/);
  report.cancelledUi = body.slice(-900);
  await page.screenshot({ path: join(evidence, prefix + 'cancelled.png') });
  report.passed = true;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  console.log((await page.locator('body').innerText()).slice(-1800));
} finally {
  await writeFile(join(evidence, prefix + 'cancel-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  await browser.close();
}
