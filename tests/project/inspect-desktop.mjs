/** Read-only UI inspection of the owned project desktop, without reading credential field values. */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const project = fileURLToPath(new URL('../../', import.meta.url));
const source = join(project, 'source/deepseek-harness');
const require = createRequire(join(source, 'package.json'));
const { chromium } = require(join(source, 'node_modules/.pnpm/node_modules/playwright'));
const launch = JSON.parse(await readFile(join(project, '.studybuddy/launch.json'), 'utf8'));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${launch.DSH_DESKTOP_RENDERER_DEBUG_PORT}`);
try {
  console.log(browser.contexts().flatMap(context => context.pages()).map(page => page.url()));
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('dsh-app://app/'));
  if (page) {
    if (process.argv.includes('--models')) {
      const dialog = page.getByRole('button', { name: '继续', exact: true });
      if (await dialog.isVisible()) await dialog.click();
      if (!await page.getByRole('button', { name: '关闭', exact: true }).isVisible()) await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '模型', exact: true }).click();
      await page.getByText('StudyBuddy DeepSeek', { exact: true }).waitFor({ timeout: 20000 });
    }
    console.log(await page.locator('body').innerText());
    if (process.argv.includes('--snapshot')) console.log(await page.locator('body').ariaSnapshot());
  }
} finally { await browser.close(); }
