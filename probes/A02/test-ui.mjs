/** Exercise the probe through the real shipped Web profile and a local Messages fixture. */
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
let page;
if (desktop) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap(context => context.pages());
    const welcome = pages.find(candidate => candidate.url().includes('welcome'));
    if (welcome) {
      await welcome.getByRole('button', { name: /^(Add API Key|添加 API Key)$/ }).click();
      await welcome.getByRole('button', { name: /^(Set up later|稍后配置)$/ }).click();
    }
    page = pages.find(candidate => candidate.url().startsWith('dsh-app://app/'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!page) throw new Error('No desktop workspace');
} else page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 950 } });
const result = { started: new Date().toISOString(), root: info.root, checks: {}, passed: false, realProvider: false };
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const save = async name => page.screenshot({ path: join(evidence, prefix + name) });
try {
  if (!desktop) {
    assert.equal((await fetch(info.origin + '/api/a02.value')).status, 401);
    result.checks.unauthenticatedRejected = true;
    await page.goto(await readFile(join(info.root, 'browser-url.txt'), 'utf8'));
  }
  const disclaimer = page.getByRole('button', { name: '继续', exact: true });
  try { await disclaimer.click({ timeout: 10000 }); } catch (error) { if (!error.message.includes('Timeout')) throw error; }
  await page.getByRole('button', { name: 'A02 学习探针', exact: true }).click();
  await page.getByTestId('a02-study-page').waitFor();
  await page.getByRole('textbox', { name: '探针值' }).fill('ui-saved');
  await page.getByRole('button', { name: '保存共享值' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="a02-result"]')?.textContent.includes('ui-saved'));
  result.checks.uiWrite = JSON.parse(await page.getByTestId('a02-result').innerText());
  assert.equal(result.checks.uiWrite.writer, 'ui');
  await save('study-page.png');
  await page.getByRole('button', { name: '返回原有对话' }).click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill('A02 fixture: call a02_probe to write agent-saved and report completion.');
  await editor.press('Enter');
  for (let n = 0; n < 100; n++) {
    const current = await page.evaluate(() => fetch('api/a02.value').then(r => r.json()));
    if (current.writer === 'agent') break;
    if ((await page.locator('body').innerText()).includes('本轮运行失败')) throw new Error('Agent turn failed before tool execution');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  result.checks.agentWrite = await page.evaluate(() => fetch('api/a02.value').then(r => r.json()));
  assert.equal(result.checks.agentWrite.value, 'agent-saved');
  await page.getByRole('button', { name: 'A02 学习探针', exact: true }).click();
  await page.getByRole('button', { name: '读取共享值' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="a02-result"]')?.textContent.includes('agent-saved'));
  result.checks.sameService = JSON.parse(await page.getByTestId('a02-result').innerText());
  result.checks.selectedSession = await page.getByTestId('a02-session').innerText();
  assert.ok(!result.checks.selectedSession.endsWith('null'));
  await save('study-agent-shared.png');
  await page.getByRole('button', { name: '返回原有对话' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('A02 adapter stream and tool round trip complete.'), null, { timeout: 45000 });
  await save('conversation-tool.png');
  result.checks.originalConversationRetained = true;
  console.log('SHARED_SERVICE_PASS');
  console.log((await page.locator('body').innerText()).slice(-1800));
  console.log(await page.locator('button').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, label: n.getAttribute('aria-label') })).filter(n => /停止|发送/.test(n.label ?? n.text))));
  result.checks.pageErrors = errors;
  assert.deepEqual(errors, []);
  result.passed = true;
} catch (error) {
  result.error = error.message; process.exitCode = 1;
  await save('ui-failure.png');
  console.log((await page.locator('body').innerText()).slice(-2400));
} finally {
  result.finished = new Date().toISOString();
  await writeFile(join(evidence, prefix + 'ui-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  await browser.close();
}
