/** Re-open the official-model Session after a real Electron/Host restart without another model call. */
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
const before = JSON.parse(await readFile(join(evidence, 'real-ui-result.json'), 'utf8'));
const browser = await chromium.connectOverCDP(info.origin);
let page;
const report = { root: info.root, realProvider: true, paidRequestsSubmittedByThisTest: 0, passed: false };
async function rpc(endpoint, args) {
  return page.evaluate(async ({ endpoint, args }) => {
    const response = await fetch(`api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'a02-' + crypto.randomUUID(), method: endpoint, payload: { args } }) });
    const envelope = await response.json();
    if (!envelope.result.ok) throw new Error(envelope.result.error.code);
    return envelope.result.value;
  }, { endpoint, args });
}
try {
  for (let n = 0; n < 240; n++) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/'));
    if (page && await page.getByRole('button', { name: 'A02 学习探针', exact: true }).isVisible()) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const catalog = await rpc('session/list', { _request: {} });
  const saved = catalog.items.find(item => (item.sessionId ?? item.id) === before.sessionId);
  assert.ok(saved);
  report.sessionId = before.sessionId;
  const history = await rpc('session/events', { request: { address: { kind: 'session', sessionId: before.sessionId }, maxMessages: 100 } });
  const events = history.records.map(record => record.event);
  report.restoredTurnEnds = events.filter(event => event.type === 'turn/end').map(event => event.data.reason);
  assert.ok(report.restoredTurnEnds.length >= 3);
  assert.deepEqual(report.restoredTurnEnds.slice(0, 3).map(reason => reason.kind), ['completed', 'aborted', 'completed']);
  report.restoredToolCalls = events.filter(event => event.type === 'tool/call').map(event => event.data.name);
  assert.ok(before.toolCalls.every(name => report.restoredToolCalls.includes(name)));
  const savedTitle = saved.projections?.values?.title;
  assert.equal(typeof savedTitle, 'string');
  await page.getByText(savedTitle, { exact: true }).first().click();
  await page.getByText('A02_ATTACHMENT_RECEIVED', { exact: true }).first().waitFor({ timeout: 15000 });
  report.historyVisible = true;
  await page.getByRole('button', { name: 'A02 学习探针', exact: true }).click();
  await page.getByRole('button', { name: '读取共享值' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="a02-result"]')?.textContent.includes('real-agent-saved'));
  report.pluginState = JSON.parse(await page.getByTestId('a02-result').innerText());
  assert.deepEqual(report.pluginState, before.agentWrite);
  report.selectedSession = await page.getByTestId('a02-session').innerText();
  assert.ok(report.selectedSession.includes(before.sessionId));
  await page.screenshot({ path: join(evidence, 'real-resume-study.png') });
  report.passed = true;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  if (page) await page.screenshot({ path: join(evidence, 'real-resume-failure.png') });
} finally {
  await writeFile(join(evidence, 'real-resume-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); await browser.close();
}
