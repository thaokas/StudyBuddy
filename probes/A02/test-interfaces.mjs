/** Time-bounded Schedule CRUD and malformed probe requests; never delivers a reminder or starts a model. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const evidence = fileURLToPath(new URL('../../docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02/', import.meta.url));
const require = createRequire(join(source, 'package.json'));
const { chromium } = require(join(source, 'node_modules/.pnpm/node_modules/playwright'));
const info = JSON.parse(await readFile(join(evidence, 'resume-running.json'), 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ locale: 'zh-CN' });
const report = { root: info.root, passed: false, reminderDeliveryTested: false };
async function rpc(endpoint, args) {
  return page.evaluate(async ({ endpoint, args }) => {
    const response = await fetch(`api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'a02-' + crypto.randomUUID(), method: endpoint, payload: { args } }) });
    return { status: response.status, body: await response.json() };
  }, { endpoint, args });
}
let id;
try {
  await page.goto(await readFile(join(info.root, 'browser-url.txt'), 'utf8'));
  report.invalidValueStatus = await page.evaluate(async () => (await fetch('api/a02.value', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 123 }),
  })).status);
  assert.equal(report.invalidValueStatus, 400);
  const created = await rpc('schedule/create', { request: { title: 'A02 future-only CRUD fixture', prompt: 'Never deliver: this task is deleted immediately.', timing: { kind: 'after', after_seconds: 86400 } } });
  report.created = created;
  assert.equal(created.body.result.ok, true);
  id = created.body.result.value.id ?? created.body.result.value.schedule?.id;
  assert.ok(id);
  report.paused = await rpc('schedule/edit', { request: { id, action: 'update', patch: { active: false } } });
  assert.equal(report.paused.body.result.ok, true);
  report.view = await rpc('schedule/view', { request: { id } });
  assert.equal(report.view.body.result.ok, true);
  report.deleted = await rpc('schedule/edit', { request: { id, action: 'delete' } });
  assert.equal(report.deleted.body.result.ok, true);
  assert.equal(report.deleted.body.result.value.deleted, true);
  id = undefined;
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (id) report.cleanup = await rpc('schedule/edit', { request: { id, action: 'delete' } });
  await writeFile(join(evidence, 'interfaces-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); await browser.close();
}
