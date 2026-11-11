/** Select synthetic files through the shipped composer and observe actual upload and prompt requests. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const evidence = fileURLToPath(new URL('../../docs/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02/', import.meta.url));
const require = createRequire(join(source, 'package.json'));
const { chromium } = require(join(source, 'node_modules/.pnpm/node_modules/playwright'));
const desktop = process.argv.includes('--desktop');
const prefix = desktop ? 'desktop-' : '';
const info = JSON.parse(await readFile(join(evidence, `${desktop ? 'desktop' : 'local'}-running.json`), 'utf8'));
const browser = desktop ? await chromium.connectOverCDP(info.origin) : await chromium.launch({ channel: 'msedge', headless: true });
const page = desktop ? browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/')) : await browser.newPage({ locale: 'zh-CN' });
const report = { root: info.root, passed: false, uploads: [] };
page.on('response', response => { if (response.url().includes('/api/session/uploadFileBinary')) report.uploads.push({ status: response.status() }); });
try {
  if (!desktop) await page.goto(await readFile(join(info.root, 'browser-url.txt'), 'utf8'));
  const dismiss = page.getByRole('button', { name: '继续', exact: true });
  if (await dismiss.count()) await dismiss.click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.waitFor();
  await editor.fill('A02 attachment fixture. Confirm receipt only.');
  const image = await page.screenshot({ clip: { x: 0, y: 0, width: 8, height: 8 } });
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'a02.txt', mimeType: 'text/plain', buffer: Buffer.from('A02 synthetic attachment\n') },
    { name: 'a02.png', mimeType: 'image/png', buffer: image },
  ]);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('A02 adapter stream and tool round trip complete.', { exact: false }).last().waitFor({ timeout: 30000 });
  assert.ok(report.uploads.length >= 1);
  assert.ok(report.uploads.every(upload => upload.status === 200));
  const text = await page.locator('body').innerText();
  assert.ok(text.includes('a02.txt'));
  report.fileChipRetained = true;
  await page.screenshot({ path: join(evidence, prefix + 'attachments.png') });
  report.passed = true;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  console.log((await page.locator('body').innerText()).slice(-1800));
} finally {
  await writeFile(join(evidence, prefix + 'attachment-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); await browser.close();
}
