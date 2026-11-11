/** Real official-model cancellation and synthetic attachment transport through Electron. */
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
const first = JSON.parse(await readFile(join(evidence, 'real-ui-result.json'), 'utf8'));
const browser = await chromium.connectOverCDP(info.origin);
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/'));
const report = { root: info.root, realProvider: true, passed: false, uploads: [] };
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
page.on('response', response => { if (response.url().includes('/api/session/uploadFileBinary')) report.uploads.push({ status: response.status() }); });
async function history() {
  return page.evaluate(async sessionId => {
    const endpoint = 'session/events';
    const envelope = await fetch(`api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'a02-' + crypto.randomUUID(), method: endpoint,
        payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 100 } } } }) }).then(response => response.json());
    if (!envelope.result.ok) throw new Error(envelope.result.error.code);
    return envelope.result.value.records.map(record => record.event);
  }, first.sessionId);
}
try {
  const editor = page.locator('[contenteditable="true"]');
  await editor.fill('A02 cancellation test. Do not call tools. Write 400 numbered lines, using four-digit numbers followed by a colon. Each line should contain one short sentence about a harmless local software test. Start immediately with the numbered output.');
  await editor.press('Enter');
  const stop = page.getByRole('button', { name: '停止生成', exact: true });
  await stop.waitFor({ timeout: 20000 });
  await page.getByText('0001:', { exact: false }).last().waitFor({ timeout: 30000 });
  report.livePartialTextObserved = true;
  await stop.click();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 15000 });
  let records = await history();
  report.cancelReason = records.filter(event => event.type === 'turn/end').at(-1)?.data.reason;
  assert.ok(report.cancelReason?.kind && report.cancelReason.kind !== 'completed');
  await page.screenshot({ path: join(evidence, 'real-cancelled.png') });
  const lastSeq = records.at(-1).seq;
  await editor.fill('A02 synthetic attachment transport test. A tiny test PNG and a text fixture are attached. Do not call tools. Confirm that the request with the image was accepted; reply only A02_ATTACHMENT_RECEIVED.');
  const image = await page.screenshot({ clip: { x: 0, y: 0, width: 8, height: 8 } });
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'a02-real.txt', mimeType: 'text/plain', buffer: Buffer.from('A02 synthetic official API attachment\n') },
    { name: 'a02-real.png', mimeType: 'image/png', buffer: image },
  ]);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    records = await history();
    const ended = records.filter(event => event.type === 'turn/end' && event.seq > lastSeq).at(-1);
    if (ended) { report.attachmentTurnEnd = ended.data.reason; break; }
    await pause();
  }
  assert.equal(report.attachmentTurnEnd?.kind, 'completed');
  assert.ok(report.uploads.length >= 2 && report.uploads.every(upload => upload.status === 200));
  const newRecords = records.filter(event => event.seq > lastSeq);
  report.persistedImageRef = newRecords.filter(event => event.type === 'user/message').some(event => JSON.stringify(event.data).includes('"image"'));
  assert.equal(report.persistedImageRef, true);
  report.officialAttachmentAcknowledged = newRecords.filter(event => event.type === 'assistant/message').some(event => JSON.stringify(event.data.message).includes('A02_ATTACHMENT_RECEIVED'));
  assert.equal(report.officialAttachmentAcknowledged, true);
  report.usage = newRecords.filter(event => event.type === 'assistant/message').map(event => event.data.usage);
  await page.screenshot({ path: join(evidence, 'real-attachments.png') });
  report.passed = true;
} catch (error) {
  report.error = error.message; process.exitCode = 1;
  await page.screenshot({ path: join(evidence, 'real-extra-failure.png') });
} finally {
  await writeFile(join(evidence, 'real-extra-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); await browser.close();
}
