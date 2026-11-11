/** Authorized official-model smoke in the real Electron/Host/Agent stack; only synthetic task data. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const evidence = fileURLToPath(new URL('../../docs/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02/', import.meta.url));
const require = createRequire(join(source, 'package.json'));
const { chromium } = require(join(source, 'node_modules/.pnpm/node_modules/playwright'));
const info = JSON.parse(await readFile(join(evidence, 'desktop-real-running.json'), 'utf8'));
const browser = await chromium.connectOverCDP(info.origin);
let page;
const report = { root: info.root, realProvider: true, model: JSON.parse(await readFile(join(evidence, 'official-model.json'), 'utf8')), passed: false };
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
async function events(id) {
  return page.evaluate(async sessionId => {
    const endpoint = 'session/events';
    const response = await fetch(`api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'a02-' + crypto.randomUUID(), method: endpoint,
        payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 100 } } } }) });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.code);
    return envelope.result.value.records.map(record => record.event);
  }, id);
}
try {
  for (let n = 0; n < 480; n++) {
    const pages = browser.contexts().flatMap(context => context.pages());
    const welcome = pages.find(candidate => candidate.url().includes('welcome'));
    if (welcome) {
      await welcome.getByRole('button', { name: /^(Add API Key|添加 API Key)$/ }).click();
      await welcome.getByRole('button', { name: /^(Set up later|稍后配置)$/ }).click();
    }
    page = pages.find(candidate => candidate.url().startsWith('dsh-app://app/'));
    if (page) break;
    await pause();
  }
  if (!page) throw new Error('Official desktop never opened a workspace');
  const close = page.getByRole('button', { name: '关闭', exact: true });
  if (await close.isVisible()) await close.click();
  await page.getByRole('button', { name: 'A02 学习探针', exact: true }).click();
  await page.getByRole('textbox', { name: '探针值' }).fill('real-ui-saved');
  await page.getByRole('button', { name: '保存共享值' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="a02-result"]')?.textContent.includes('real-ui-saved'));
  report.uiWrite = JSON.parse(await page.getByTestId('a02-result').innerText());
  await page.getByRole('button', { name: '返回原有对话' }).click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill(`This is the authorized A02 smoke, using synthetic data only. First call a02_probe with value "real-agent-saved". Then call the native read tool with file_path "${join(info.root, 'workspace/a02.txt')}". Report the exact file text and write ten short numbered lines describing what you verified. Do not call any other tools.`);
  await editor.press('Enter');
  let activeSeen = false;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const active = await page.getByRole('button', { name: '停止生成', exact: true }).isVisible();
    activeSeen ||= active;
    const state = await page.evaluate(() => fetch('api/a02.value').then(response => response.json()));
    if (activeSeen && !active && state.value === 'real-agent-saved') break;
    await pause();
  }
  report.turnAdmitted = activeSeen;
  await page.getByRole('button', { name: 'A02 学习探针', exact: true }).click();
  await page.getByRole('button', { name: '读取共享值' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="a02-result"]')?.textContent.includes('real-agent-saved'));
  report.agentWrite = JSON.parse(await page.getByTestId('a02-result').innerText());
  assert.equal(report.agentWrite.writer, 'agent');
  report.sessionId = JSON.parse((await page.getByTestId('a02-session').innerText()).split(': ').slice(1).join(': '));
  const history = await events(report.sessionId);
  report.toolCalls = history.filter(event => event.type === 'tool/call').map(event => event.data.name);
  assert.ok(report.toolCalls.includes('a02_probe'));
  assert.ok(report.toolCalls.includes('read'));
  report.nativeToolResultSeen = history.filter(event => event.type === 'tool/result').some(event => !event.data.message.isError && JSON.stringify(event.data.message).includes('A02 native tool fixture'));
  assert.ok(report.nativeToolResultSeen);
  report.assistantStreams = history.filter(event => event.type === 'assistant/message').map(event => ({ chunks: event.data.stream?.length, usage: event.data.usage }));
  assert.ok(report.assistantStreams.some(stream => stream.chunks > 1));
  report.turnEnd = history.filter(event => event.type === 'turn/end').at(-1)?.data.reason;
  await page.screenshot({ path: join(evidence, 'real-study-shared.png') });
  await page.getByRole('button', { name: '返回原有对话' }).click();
  await page.screenshot({ path: join(evidence, 'real-conversation.png') });
  report.passed = true;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  if (page) await page.screenshot({ path: join(evidence, 'real-ui-failure.png') });
} finally {
  report.finished = new Date().toISOString();
  await writeFile(join(evidence, 'real-ui-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); await browser.close();
}
