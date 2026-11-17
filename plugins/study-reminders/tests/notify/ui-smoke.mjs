/**
 * Browser smoke for the reply-completion reminder's two shell surfaces.
 *
 * The reminder announces through the frame-wide `shell.overlay` slot and puts
 * its switch in the General settings rows (`settings.general.item`). Those two
 * contribution shapes are what the unit tests cannot prove: this script boots
 * the shipped DSH Web profile with the study plugin, opens Settings in the real
 * shell, and drives the switch through the real locale and storage.
 *
 * Sequence:
 *
 * 1. The row renders with the Chinese copy and reads as enabled.
 * 2. Pressing the switch stores the preference and flips the row to disabled.
 * 3. A reload keeps the disabled state, so the choice survives a restart.
 * 4. The banner stays absent while no reply finished, and the page raises no
 *    uncaught error.
 *
 * Report and screenshot land in `tests/notify/evidence/`.
 * Run: `node plugins/study-outcomes/tests/notify/ui-smoke.mjs [--keep]`
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
const HOST_ENTRY = join(PLUGIN_ROOT, 'host', 'index.mjs');
const CORE_ROOT = fileURLToPath(new URL('../../../study-core/', import.meta.url));
const CORE_ENTRY = join(CORE_ROOT, 'host', 'index.mjs');
const READINESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;
const PREFERENCE_KEY = 'study.notify.completion.enabled';
const ROW = '[data-testid="study-notify-setting"]';

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
  return { bytes: summary.bytes, messages: summary.messages, pages: summary.pages };
}

/**
 * Write the profile overlay for one host run.
 * @param {{ root: string }} options - Run identity.
 * @returns {Promise<string>} Overlay path.
 */
async function writeOverlay({ root, disabled = false }) {
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
    `      name: ${JSON.stringify(forward(HOST_ENTRY))}`,
  ];
  if (disabled) lines.push('      disabled: true');
  const file = join(root, 'overlay.yml');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/**
 * Boot one isolated DSH Web host with the study overlay.
 * @param {{ root: string }} options - Run identity.
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>} Running host.
 */
async function startHost({ root, disabled = false }) {
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
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const stop = async () => {
    if (child.exitCode === null) {
      spawnSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    }
    await Promise.race([exited, delay(15000, undefined, { ref: false })]);
    await writeFile(join(root, 'host.stdout.log'), stdout);
    await writeFile(join(root, 'host.stderr.log'), stderr);
  };
  const host = { url: undefined, stderr: () => stderr, stdout: () => stdout, stop };
  hosts.push(host);
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`host exited before it was ready (${child.exitCode}):\n${stderr.slice(-4000)}`);
    const match = stdout.match(READINESS);
    if (match !== null) {
      host.url = match[0];
      return host;
    }
    await delay(250);
  }
  await stop();
  throw new Error(`host did not report a ready URL within 240s:\n${stderr.slice(-4000)}`);
}

/** First-run button labels, in dismissal order. */
const FIRST_RUN_BUTTONS = Object.freeze([
  /^(继续|Continue)$/,
  /^(稍后配置|Configure later)$/,
  /^(添加 API Key|Add API Key)$/,
  /^(关闭|Close)$/,
]);

/**
 * Close one blocking first-run surface.
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
 * Clear the first-run chrome the way a student would.
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
  throw new Error('first-run dialogs never closed, so they would block the settings shortcut');
}

/**
 * Open the settings panel through the shell shortcut.
 * The web binding of `settings.open` is primary+alt+Comma, i.e. Ctrl+Alt+, on
 * Windows/Linux and Command+Option+, on macOS.
 * @param {object} page - Playwright page.
 */
async function openSettings(page, diagnose = () => []) {
  await page.keyboard.press('Control+Alt+Comma');
  try {
    await page.locator(ROW).waitFor({ timeout: 20000 });
  } catch (error) {
    const dialogs = await page.locator('[role="dialog"]').count();
    const visible = await page.evaluate(() => (document.querySelector('[role="dialog"]')?.innerText ?? document.body.innerText).slice(0, 700));
    await page.screenshot({ path: join(EVIDENCE, 'notify-setting-missing.png') }).catch(() => {});
    report.screenshots.push('notify-setting-missing.png');
    throw new Error(`settings row [${ROW}] did not appear (dialogs=${dialogs}): ${visible}\nconsole: ${diagnose().join(' | ')}`);
  }
}

/**
 * Read the row's visible text and stored preference.
 * @param {object} page - Playwright page.
 * @returns {Promise<{ text: string, enabled: string | null, pressed: string | null, banner: number }>} Observed facts.
 */
async function readRow(page) {
  return {
    text: await page.locator(ROW).innerText(),
    enabled: await page.evaluate(key => window.localStorage.getItem(key), PREFERENCE_KEY),
    pressed: await page.locator(`${ROW} button[aria-pressed]`).getAttribute('aria-pressed'),
    banner: await page.locator('[data-testid="study-completion-notice"]').count(),
  };
}

const workRoot = await mkdtemp(join(tmpdir(), 'study-notify-'));
try {
  await mkdir(EVIDENCE, { recursive: true });
  const playwright = loadPlaywright();
  report.checks.build = await build();

  const host = await startHost({ root: join(workRoot, 'enabled') });
  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  browsers.push(browser);
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1360, height: 940 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const consoleAll = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', (message) => {
    consoleAll.push(`${message.type()}: ${message.text()}`);
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(host.url);
  await settleFirstRun(page);
  report.checks.diagnostics = {
    studyPanel: await page.getByRole('button', { name: '今日' }).count(),
    console: consoleAll.filter(text => /study/i.test(text)).slice(0, 20),
    pageErrors,
  };
  await page.getByRole('button', { name: '\u63d0\u9192', exact: true }).click();
  await page.getByTestId('study-reminders').waitFor();
  await page.getByTestId('followup-refresh').click();
  report.checks.remindersPage = true;
  await page.screenshot({ path: join(EVIDENCE, 'reminders.png') });
  await openSettings(page, () => consoleAll.slice(-20));

  const initial = await readRow(page);
  report.checks.initial = initial;
  await page.locator(ROW).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(EVIDENCE, 'notify-setting-on.png') });
  report.screenshots.push('notify-setting-on.png');
  assert.match(initial.text, /回复完成时提醒/, `设置行没有渲染中文文案：${initial.text}`);
  assert.equal(initial.enabled, null, '未操作前不应写入偏好');
  assert.equal(initial.pressed, 'true', '默认应显示已开启');
  assert.equal(initial.banner, 0, '没有回复结束时不应出现提示条');

  await page.locator(`${ROW} button[aria-pressed]`).click();
  await page.locator(`${ROW} button[aria-pressed="false"]`).waitFor({ timeout: 10000 });
  const disabled = await readRow(page);
  report.checks.disabled = disabled;
  await page.screenshot({ path: join(EVIDENCE, 'notify-setting-off.png') });
  report.screenshots.push('notify-setting-off.png');
  assert.equal(disabled.enabled, '0', '关闭后必须写入偏好');
  assert.match(disabled.text, /已关闭/, `关闭后文案应为已关闭：${disabled.text}`);

  await page.reload();
  await settleFirstRun(page);
  await openSettings(page, () => consoleErrors);
  const reloaded = await readRow(page);
  report.checks.reloaded = reloaded;
  assert.equal(reloaded.pressed, 'false', '刷新后开关必须保持关闭');
  assert.match(reloaded.text, /已关闭/);

  assert.deepEqual(pageErrors, [], `页面抛出未捕获异常：${pageErrors.join('; ')}`);
  report.checks.consoleErrors = consoleErrors.filter(text => /study|client-modules/i.test(text));
  assert.deepEqual(report.checks.consoleErrors, [], `控制台出现插件相关错误：${report.checks.consoleErrors.join('; ')}`);

  await host.stop();
  const disabledHost = await startHost({ root: join(workRoot, 'disabled'), disabled: true });
  const disabledContext = await browser.newContext({ locale: 'zh-CN' });
  const disabledPage = await disabledContext.newPage();
  await disabledPage.goto(disabledHost.url);
  await settleFirstRun(disabledPage);
  assert.equal(await disabledPage.getByRole('button', { name: '\u63d0\u9192', exact: true }).count(), 0);
  await disabledPage.getByRole('button', { name: '\u8ba1\u5212', exact: true }).click();
  await disabledPage.getByRole('button', { name: '\u5de5\u4f5c\u53f0', exact: true }).click();
  await disabledPage.keyboard.press('Control+Alt+Comma');
  await delay(1000);
  assert.equal(await disabledPage.locator(ROW).count(), 0);
  assert.equal(await disabledPage.getByTestId('study-completion-notice').count(), 0);
  report.checks.disabledPlugin = { pageAbsent: true, settingsAbsent: true, bannerAbsent: true, factsNavigation: true };
  await disabledPage.screenshot({ path: join(EVIDENCE, 'disabled.png') });
  await disabledContext.close(); await disabledHost.stop();
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const host of hosts.reverse()) await host.stop().catch(() => {});
  report.finished = new Date().toISOString();
  report.hostStderr = hosts.map(host => host.stderr().split(/\r?\n/).filter(line => /study|client-modules|FAILED/i.test(line)).slice(0, 20));
  await writeFile(join(EVIDENCE, 'ui-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--keep') !== true) await rm(workRoot, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
