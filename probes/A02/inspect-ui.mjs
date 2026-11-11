/** Repository-local test automation fallback: Browser plugin navigation is unavailable in this session. */
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const evidence = fileURLToPath(new URL('../../docs/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02/', import.meta.url));
const require = createRequire(join(source, 'package.json'));
const { chromium } = require(join(source, 'node_modules/.pnpm/node_modules/playwright'));
const info = JSON.parse(await readFile(join(evidence, 'local-running.json'), 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ locale: 'zh-CN' });
page.on('pageerror', error => console.log('PAGEERROR', error.message));
await page.goto(await readFile(join(info.root, 'browser-url.txt'), 'utf8'));
await page.waitForTimeout(7000);
console.log(await page.locator('body').innerText());
await page.screenshot({ path: join(evidence, 'initial-ui.png') });
await writeFile(join(evidence, 'initial-dom.html'), await page.content());
await browser.close();
