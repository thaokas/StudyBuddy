/** Real Web/Edge smoke: learning page, reports and disabled-row fallback. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SOURCE = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EVIDENCE = fileURLToPath(new URL('./evidence/', import.meta.url));
const BUILD_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'build-client.mjs');
const HOST_ENTRY = fileURLToPath(new URL('../../../study-outcomes/host/index.mjs', import.meta.url));
const CORE_ROOT = fileURLToPath(new URL('../../../study-core/', import.meta.url));
const CORE_ENTRY = join(CORE_ROOT, 'host', 'index.mjs');
const READINESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;

const report = { started: new Date().toISOString(), checks: {}, screenshots: [], passed: false };
const hosts = [];
const browsers = [];

const forward = value => value.replaceAll('\\', '/');

/** The host's local calendar date, used for a week goal anchor. */
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Import Playwright from the pinned source checkout's store. */
function loadPlaywright() {
  const bases = [
    join(SOURCE, 'node_modules', '.pnpm', 'node_modules', 'playwright'),
    join(SOURCE, 'node_modules', 'playwright'),
  ];
  const failures = [];
  for (const base of bases) {
    try {
      return createRequire(join(SOURCE, 'package.json'))(base);
    } catch (error) {
      failures.push(`${base} (${error.code ?? error.message})`);
    }
  }
  throw new Error(`cannot find playwright; tried:\n  ${failures.join('\n  ')}`);
}

/** Build the client bundle and fail with esbuild's own message when it does not. */
async function build() {
  const core = spawnSync(process.execPath, [join(CORE_ROOT, 'scripts', 'build-client.mjs')], { cwd: CORE_ROOT, encoding: 'utf8', timeout: 120000 });
  if (core.status !== 0) throw new Error(`Core client build failed: ${core.stderr || core.stdout}`);
  const result = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: PLUGIN_ROOT, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) {
    throw new Error(`client build failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  const summary = JSON.parse(result.stdout);
  return { bytes: summary.bytes, pages: summary.pages, messages: summary.messages };
}

/** Write the profile overlay for one host run. */
async function writeOverlay({ root, disabledLearning = false }) {
  const lines = [
    '- id: session-log-deepseek',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: product-analytics',
    '  disabled: true',
    '- insert:',
    '    - id: study-core',
    `      name: ${JSON.stringify(forward(CORE_ENTRY))}`,
    '      config:',
    `        dataDir: ${JSON.stringify(forward(join(root, 'data')))}`,
    '    - id: study-facts',
    `      disabled: false`,
  `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-facts/host/index.mjs', import.meta.url))))}`,
    '    - id: study-learning',
    `      disabled: ${disabledLearning}`,
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-learning/host/index.mjs', import.meta.url))))}`,
    '    - id: study-reminders',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-reminders/host/index.mjs', import.meta.url))))}`,
  '    - id: study-outcomes',
    `      name: ${JSON.stringify(forward(HOST_ENTRY))}`,
    '    - id: study-memory',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-memory/host/index.mjs', import.meta.url))))}`,
  ];
  const file = join(root, 'overlay.yml');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/** Boot one isolated DSH Web host with the study overlay. */
async function startHost({ root, disabledLearning = false }) {
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  const patch = await writeOverlay({ root, disabledLearning });
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(DSH_|ELECTRON_)/i.test(name)) delete env[name];
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    DSH_HOME: join(root, 'home'),
    DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
  });
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    'web', '--patch', patch, '--no-open', '--port', '0',
  ], { cwd: SOURCE, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const stop = async () => {
    if (child.exitCode === null) {
      spawnSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    }
    await Promise.race([exited, delay(15000, undefined, { ref: false })]);
    await writeFile(join(root, 'host.stdout.log'), stdout);
    await writeFile(join(root, 'host.stderr.log'), stderr);
  };
  const host = { url: undefined, origin: undefined, stderr: () => stderr, stop };
  hosts.push(host);
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`host exited before ready (${child.exitCode}):\n${stderr.slice(-4000)}`);
    const match = stdout.match(READINESS);
    if (match !== null) {
      host.url = match[0];
      host.origin = new URL(match[0]).origin;
      return host;
    }
    await delay(250);
  }
  await stop();
  throw new Error(`host did not report a ready URL within 240s:\n${stderr.slice(-4000)}`);
}

/** Exchange the launch token for the browser cookie, then call one study route. */
async function callRoute(url, route, body = {}) {
  const index = await fetch(url, { redirect: 'manual' });
  const setCookie = index.headers.getSetCookie?.()[0] ?? index.headers.get('set-cookie');
  if (typeof setCookie !== 'string' || setCookie.length === 0) throw new Error(`no cookie on the first response (HTTP ${index.status})`);
  const cookie = setCookie.split(';', 1)[0];
  // Writes require an idempotency identity; the route strips it for reads.
  const payload = { requestId: body.requestId ?? randomUUID(), ...body };
  const response = await fetch(`${new URL(url).origin}${route}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, envelope: await response.json().catch(() => null) };
}

/** Button labels of the first-run chain, in dismissal order. */
const FIRST_RUN_BUTTONS = Object.freeze([
  /^(继续|Continue)$/,
  /^(稍后配置|Configure later)$/,
  /^(添加 API Key|Add API Key)$/,
  /^(关闭|Close)$/,
]);

/** Close one blocking first-run surface. */
async function dismissOne(page) {
  for (const name of FIRST_RUN_BUTTONS) {
    const button = page.getByRole('button', { name });
    if (await button.count() === 0) continue;
    await button.first().click({ timeout: 8000 }).catch(() => {});
    return true;
  }
  return false;
}

/** Clear the first-run chrome the way a student would. */
async function settleFirstRun(page) {
  const blocked = async () => {
    if (await page.locator('[role="dialog"]').count() > 0) return true;
    return await page.evaluate(() => [...document.querySelectorAll('[aria-hidden="true"]')]
      .some(node => (node.getAttribute('class') ?? '').includes('mask') && node.getBoundingClientRect().width > 0));
  };
  const deadline = Date.now() + 60000;
  let calm = 0;
  while (Date.now() < deadline) {
    if (await blocked()) {
      calm = 0;
      const clicked = await dismissOne(page);
      if (!clicked) await page.keyboard.press('Escape').catch(() => {});
      await delay(clicked ? 700 : 400);
      continue;
    }
    calm += 1;
    if (calm >= 3) return;
    await delay(1000);
  }
  throw new Error('the first-run dialogs did not close');
}

const workRoot = await mkdtemp(join(tmpdir(), 'study-learning-ui-'));
try {
  await mkdir(EVIDENCE, { recursive: true });
  const playwright = loadPlaywright();
  report.checks.build = await build();
  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true }); browsers.push(browser);
  for (const disabledLearning of [false, true]) {
    const host = await startHost({ root: join(workRoot, disabledLearning ? 'disabled' : 'enabled'), disabledLearning });
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.url); await settleFirstRun(page);
    if (!disabledLearning) {
      const captured = await callRoute(host.url, '/api/study/learning/capture', { sessionId: 'ui-question', messageId: 'ui-turn', text: '\u600e\u4e48\u6c42 x^2 \u7684\u5bfc\u6570\uff1f' });
      assert.equal(captured.envelope.ok, true, JSON.stringify(captured));
      await page.getByRole('button', { name: '\u95ee\u7b54\u8bb0\u5f55', exact: true }).click();
      await page.getByTestId('study-questions').waitFor({ timeout: 30000 });
      await page.getByTestId('questions-count').waitFor();
      for (const method of ['week', 'month']) {
        const result = await callRoute(host.url, '/api/study/review/' + method, { save: false });
        assert.equal(result.envelope.ok, true, JSON.stringify(result));
      }
      const second = await callRoute(host.url, '/api/study/learning/capture', { sessionId: 'ui-second', messageId: 'ui-second-turn', text: 'How do I differentiate x^3?' });
      assert.equal(second.envelope.ok, true);
      const listed = (await callRoute(host.url, '/api/study/learning/list')).envelope.value;
      assert.equal(listed.total, 2);
      const merged = (await callRoute(host.url, '/api/study/learning/merge', { episodeIds: listed.items.map(row => row.id) })).envelope;
      assert.equal(merged.ok, true, JSON.stringify(merged));
      const detail = (await callRoute(host.url, '/api/study/learning/get', { id: merged.value.targetId })).envelope.value;
      const split = (await callRoute(host.url, '/api/study/learning/split', { episodeId: merged.value.targetId, atTurnId: detail.turns[1].id })).envelope;
      assert.equal(split.ok, true, JSON.stringify(split));
      report.checks.enabled = { questions: true, reports: true, mergeSplit: true };
    } else {
      assert.equal(await page.getByRole('button', { name: '\u95ee\u7b54\u8bb0\u5f55', exact: true }).count(), 0);
      for (const [ns, method] of [['tasks', 'listTasks'], ['followup', 'due'], ['memory', 'recall'], ['outcomes', 'day']]) {
        const result = await callRoute(host.url, '/api/study/' + ns + '/' + method);
        assert.equal(result.envelope.ok, true, JSON.stringify(result));
      }
      await page.getByRole('button', { name: '\u6210\u679c', exact: true }).click();
      await page.getByTestId('outcomes-mode-week').click();
      await page.getByTestId('outcomes-review-error').waitFor({ timeout: 30000 });
      assert.match(await page.getByTestId('outcomes-review-error').innerText(), /\u4e0d\u53ef\u7528/);
      report.checks.disabled = { questionsAbsent: true, otherRowsUsable: true, reportError: await page.getByTestId('outcomes-review-error').innerText() };
    }
    assert.deepEqual(errors, []);
    const screenshot = disabledLearning ? 'disabled.png' : 'enabled.png';
    await page.screenshot({ path: join(EVIDENCE, screenshot) }); report.screenshots.push(screenshot);
    await context.close(); await host.stop();
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const host of hosts.reverse()) await host.stop().catch(() => {});
  report.finished = new Date().toISOString();
  report.hostStderr = hosts.map(host => host.stderr().split(/\r?\n/).filter(line => /study|client-modules|FAILED/i.test(line)).slice(0, 20));
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(join(EVIDENCE, 'ui-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  if (!process.argv.includes('--keep')) await rm(workRoot, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
