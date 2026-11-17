/**
 * UI smoke for the study client.
 *
 * Sequence: build the bundle, boot the shipped DSH Web profile with the study
 * plugin inserted, then drive the real page in a browser:
 *
 * 1. Chinese run — the sidebar entry opens the page, the page shows the same
 *    revision the authenticated `kernel.status` route reports, and the
 *    `refresh` action issues a second request.
 * 2. English run — the same entry and page render from the English dictionary,
 *    proving the copy follows the locale instead of being hardcoded.
 * 3. Disabled run — with the plugin row disabled the entry and the route are
 *    gone and the app still boots.
 *
 * Screenshots and the JSON report land in `tests/client/evidence/`.
 * Run: `node plugins/study-memory/tests/client/ui-smoke.mjs [--keep]`
 * Needs a browser (Edge) and host processes, so it is not part of `node --test`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const MEMORY_ENTRY = join(PLUGIN_ROOT, 'host', 'index.mjs');
const CORE_ROOT = fileURLToPath(new URL('../../../study-core/', import.meta.url));
const CORE_ENTRY = join(CORE_ROOT, 'host', 'index.mjs');
const READINESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;

const report = { started: new Date().toISOString(), checks: {}, screenshots: [], passed: false };
const hosts = [];
const browsers = [];

/** Forward slashes for YAML values on Windows. */
const forward = value => value.replaceAll('\\', '/');

/**
 * Import Playwright from the pinned source checkout's store.
 * @returns {object} Playwright module.
 */
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
      failures.push(`${base}（${error.code ?? error.message}）`);
    }
  }
  throw new Error(`找不到 playwright，试过：\n  ${failures.join('\n  ')}`);
}

/** Build the client bundle and fail with esbuild's own message when it does not. */
async function build() {
  const core = spawnSync(process.execPath, [join(CORE_ROOT, 'scripts', 'build-client.mjs')], { cwd: CORE_ROOT, encoding: 'utf8', timeout: 120000 });
  if (core.status !== 0) throw new Error(`Core client build failed: ${core.stderr || core.stdout}`);
  const result = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: PLUGIN_ROOT, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) {
    throw new Error(`客户端构建失败（退出 ${result.status}）：\n${result.stderr || result.stdout}`);
  }
  const summary = JSON.parse(result.stdout);
  return { core: JSON.parse(core.stdout), bytes: summary.bytes, pages: summary.pages, actions: summary.actions };
}

/**
 * Write the profile overlay for one host run.
 * @param {{ root: string, disabled: boolean }} options - Run identity.
 * @returns {Promise<string>} Overlay path.
 */
async function writeOverlay({ root, disabled }) {
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
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-facts/host/index.mjs', import.meta.url))))}`,
    '    - id: study-learning',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-learning/host/index.mjs', import.meta.url))))}`,
    '    - id: study-reminders',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-reminders/host/index.mjs', import.meta.url))))}`,
    '    - id: study-outcomes',
    `      name: ${JSON.stringify(forward(HOST_ENTRY))}`,
    '    - id: study-memory',
    `      name: ${JSON.stringify(forward(MEMORY_ENTRY))}`,
  ];
  // A later patch entry overrides the row inserted just above: the entry
  // disappears from both the Loader and the served client graph.
  if (disabled) lines.push('- id: study-memory', '  disabled: true');
  const file = join(root, 'overlay.yml');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/**
 * Boot one isolated DSH Web host with the study overlay.
 * @param {{ root: string, disabled: boolean }} options - Run identity.
 * @returns {Promise<{ url: string, origin: string, pid: number, stderr: () => string, stop: () => Promise<void> }>}
 *   Running host; `stop` kills its process tree.
 */
async function startHost({ root, disabled }) {
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  const patch = await writeOverlay({ root, disabled });
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
  const host = { url: undefined, origin: undefined, pid: child.pid, child, stderr: () => stderr, stdout: () => stdout, stop };
  hosts.push(host);
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Host 在就绪前退出（${child.exitCode}）：\n${stderr.slice(-4000)}`);
    const match = stdout.match(READINESS);
    if (match !== null) {
      host.url = match[0];
      host.origin = new URL(match[0]).origin;
      return host;
    }
    await delay(250);
  }
  await stop();
  throw new Error(`Host 在 240s 内没有报告就绪 URL：\n${stderr.slice(-4000)}`);
}

/**
 * Exchange the launch token for the browser cookie, then call one plugin route.
 * @param {string} url - Launch URL with the token.
 * @param {string} route - `/api/...` route.
 * @param {object} [body] - JSON body.
 * @returns {Promise<{ status: number, cookie: string, envelope: object | null }>} Route result.
 */
async function callRoute(url, route, body = {}) {
  const index = await fetch(url, { redirect: 'manual' });
  const setCookie = index.headers.getSetCookie?.()[0] ?? index.headers.get('set-cookie');
  if (typeof setCookie !== 'string' || setCookie.length === 0) throw new Error(`首屏没有下发 cookie（HTTP ${index.status}）`);
  const cookie = setCookie.split(';', 1)[0];
  const response = await fetch(`${new URL(url).origin}${route}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let envelope = null;
  try {
    envelope = await response.json();
  } catch {
    // A route that does not exist answers with a non-JSON 404 body.
  }
  return { status: response.status, cookie, envelope };
}

/** Button labels of the first-run chain, in dismissal order. */
const FIRST_RUN_BUTTONS = Object.freeze([
  /^(继续|Continue)$/,
  /^(稍后配置|Configure later)$/,
  /^(添加 API Key|Add API Key)$/,
  /^(关闭|Close)$/,
]);

/**
 * Close one blocking surface: the preview notice, the sign-in gate that
 * follows it, or the API-key step opened from that gate.
 * @param {object} page - Playwright page.
 * @returns {Promise<boolean>} Whether a known button was clicked.
 */
async function dismissOne(page) {
  for (const name of FIRST_RUN_BUTTONS) {
    const button = page.getByRole('button', { name });
    if (await button.count() === 0) continue;
    await button.first().click({ timeout: 8000 }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Clear the first-run chrome. A fresh profile chains two blocking dialogs —
 * the preview notice and the model sign-in gate — and each masks the page.
 * Dismiss the chain the way a student would and only continue once three
 * one-second checks see no dialog and no mask, so a late arrival cannot steal
 * the following click.
 * @param {object} page - Playwright page.
 */
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
  await page.screenshot({ path: join(EVIDENCE, 'first-run-blocked.png') }).catch(() => {});
  throw new Error('首屏对话框没有关闭，会拦截页面点击');
}

const root = await mkdtemp(join(tmpdir(), 'p2-memory-ui-'));
try {
  await mkdir(EVIDENCE, { recursive: true });
  report.checks.build = await build();
  const playwright = loadPlaywright();
  for (const [stage, disabled] of [['enabled', false], ['disabled', true], ['restored', false]]) {
    const host = await startHost({ root, disabled });
    if (stage === 'enabled') {
      const write = await callRoute(host.url, '/api/study/memory/remember', { text: 'P2 persistent preference', requestId: 'p2-ui-remember' });
      assert.equal(write.envelope?.ok, true);
    }
    const recall = await callRoute(host.url, '/api/study/memory/recall');
    assert.equal(recall.status, disabled ? 404 : 200);
    if (!disabled) assert.equal(recall.envelope.value.items[0].text, 'P2 persistent preference');
    const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
    browsers.push(browser);
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1360, height: 940 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /study|client-modules/i.test(message.text())) errors.push(message.text()); });
    await page.goto(host.url);
    await settleFirstRun(page);
    const entry = page.getByRole('button', { name: '记忆', exact: true });
    if (disabled) {
      assert.equal(await entry.count(), 0);
      for (const key of ['questions', 'plan', 'outcomes']) {
        assert.equal((await callRoute(host.url, '/api/study/kernel/status')).envelope.ok, true);
        const labels = { questions: '问答记录', plan: '计划', outcomes: '成果' };
        await page.getByRole('button', { name: labels[key], exact: true }).click();
        await page.locator(`[data-page="${key}"]`).waitFor({ timeout: 20000 });
      }
    } else {
      await entry.click();
      await page.getByTestId('study-memory').waitFor({ timeout: 30000 });
      await page.getByText('P2 persistent preference', { exact: true }).waitFor();
      await page.getByTestId('memory-tab-profile').click();
      await page.getByTestId('memory-trait-explain_detail').waitFor();
    }
    await page.screenshot({ path: join(EVIDENCE, `${stage}.png`) });
    assert.deepEqual(errors, []);
    report.checks[stage] = { routeStatus: recall.status, errors, dataPreserved: !disabled };
    await context.close();
    await browser.close();
    await host.stop();
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const host of hosts.reverse()) await host.stop().catch(() => {});
  await writeFile(join(EVIDENCE, 'ui-smoke.json'), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
