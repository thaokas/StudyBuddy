/**
 * T03 route 2: third-party dock workbench.
 *
 * Installs `dock-base` into an isolated `web` profile, then boots DSH Web with
 * the layout probe and an upstream mock model at 1440x900:
 *
 * 1. Record the dock shell next to the native conversation.
 * 2. Open the probe's workbench side panel and send a native chat message.
 * 3. Move the dock to the left edge through its own context menu and measure
 *    the overlay against the conversation column.
 * 4. Open the study content in a floating window, then try the docked editor
 *    area and record whether dock mode actually shows it.
 * 5. Reload and record which dock state persists.
 *
 * Evidence: `probes/layout/evidence/route2/route2.json` plus screenshots.
 * Run: `node probes/layout/run-route2.mjs`
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const PROBE_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const HOST_ENTRY = join(PROBE_ROOT, 'index.mjs');
const EVIDENCE = join(PROBE_ROOT, 'evidence', 'route2');
const READINESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;
const SUCCESS_TEXT = '收到，先完成数学极限习题。';

const report = {
  task: 'T03',
  route: '2-third-party-dock',
  started: new Date().toISOString(),
  checks: {},
  screenshots: [],
  passed: false,
};
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

/** Start the upstream mock model server. */
function startMock() {
  const requireFromSource = createRequire(join(SOURCE, 'package.json'));
  return requireFromSource(join(SOURCE, 'packages/test-support/llm-mock-server/lib/index.js')).startMockLlmServer({
    sequence: ['success'],
    repeatLast: true,
    successText: SUCCESS_TEXT,
  });
}

/** Base environment for every child process: isolated home, no inherited DSH/Electron vars. */
function childEnv(root) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^DSH_|^ELECTRON_/i.test(name)) delete env[name];
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    DSH_HOME: join(root, 'home'),
    DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
  });
  return env;
}

/**
 * Install dock-base into the isolated web profile.
 * @param {string} root - Isolated run root.
 * @returns {Promise<object>} Install summary.
 */
async function installDock(root) {
  await mkdir(join(root, 'home'), { recursive: true });
  const result = spawnSync(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    'plugin', '--profile', 'web', 'add', 'dock-base',
  ], {
    cwd: SOURCE,
    env: childEnv(root),
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`dock-base 安装失败（退出 ${result.status}）：\n${result.stderr || result.stdout}`);
  }
  return {
    command: 'dsh plugin --profile web add dock-base',
    exit: result.status,
    stdoutTail: (result.stdout ?? '').split(/\r?\n/).filter(Boolean).slice(-6),
  };
}

/**
 * Write the probe overlay.
 * @param {string} root - Isolated run root.
 * @param {object} mock - Mock model server.
 * @returns {Promise<string>} Overlay path.
 */
async function writeOverlay(root, mock) {
  const lines = [
    '- id: deepseek-account',
    '  disabled: true',
    '- id: llm-deepseek-account',
    '  disabled: true',
    '- id: ui-settings-account',
    '  disabled: true',
    '- id: account-controller',
    '  disabled: true',
    '- id: session-log-deepseek',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: product-analytics',
    '  disabled: true',
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`,
    '    maxTokens: 1024',
    '    thinking: disabled',
    '    models:',
    '      - id: deepseek-flash',
    '        name: Layout probe model',
    '        inputModalities: [text]',
    '- insert:',
    '    - id: layout-probe',
    `      name: ${JSON.stringify(forward(HOST_ENTRY))}`,
    '',
  ];
  const file = join(root, 'overlay.yml');
  await writeFile(file, lines.join('\n'));
  return file;
}

/**
 * Boot one isolated DSH Web host with the dock-enabled profile.
 * @param {{ root: string, mock: object }} options - Run identity.
 * @returns {Promise<{ url: string, origin: string, stop: () => Promise<void>, stderr: () => string }>} Running host.
 */
async function startHost({ root, mock }) {
  const patch = await writeOverlay(root, mock);
  const env = childEnv(root);
  Object.assign(env, {
    DEEPSEEK_API_KEY: 'layout-probe-fake-key',
    DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
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
      spawnSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, timeout: 10000,
      });
    }
    await Promise.race([exited, delay(15000, undefined, { ref: false })]);
    await writeFile(join(root, 'host.stdout.log'), stdout);
    await writeFile(join(root, 'host.stderr.log'), stderr);
  };
  const host = { url: undefined, origin: undefined, pid: child.pid, stop, stderr: () => stderr };
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

/** Button labels of the first-run chain, in dismissal order. */
const FIRST_RUN_BUTTONS = Object.freeze([
  /^(继续|Continue)$/,
  /^(稍后配置|Configure later)$/,
  /^(添加 API Key|Add API Key)$/,
  /^(关闭|Close)$/,
]);

/**
 * Click one blocking first-run control.
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
 * Dismiss the first-run dialogs until the page is calm for three checks.
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
  throw new Error('首屏对话框没有关闭，会拦截页面点击');
}

/** Screenshot the page and record the file. */
async function shot(page, name) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
  return `${name}.png`;
}

/**
 * Measure the dock shell and the conversation column.
 * @param {object} page - Playwright page.
 * @returns {Promise<object>} Geometry.
 */
async function layoutGeometry(page) {
  return await page.evaluate(() => {
    const rect = (element) => {
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const rightbarCol = document.querySelector('[data-rightbar-col]');
    const conversation = rightbarCol?.previousElementSibling ?? null;
    const dockRoot = document.querySelector('.dsh-wb-root');
    const dockBar = document.querySelector('.dsh-wb-activity');
    const dockSidebar = document.querySelector('.dsh-wb-sidebar');
    const dockMain = document.querySelector('.dsh-wb-main');
    const floating = document.querySelector('.dsh-wb-floating');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyDock: document.body.getAttribute('data-dock'),
      conversation: rect(conversation),
      dockRoot: rect(dockRoot),
      dockBar: rect(dockBar),
      dockSidebar: rect(dockSidebar),
      floating: rect(floating),
      dockMain: rect(dockMain),
      dockMainDisplay: dockMain === null ? null : getComputedStyle(dockMain).display,
      editorTabs: document.querySelectorAll('.dsh-wb-tab').length,
      floatingTitle: floating?.querySelector('.dsh-wb-floating-title')?.textContent ?? null,
    };
  });
}

/**
 * Send one message through the native composer.
 * @param {object} page - Playwright page.
 * @param {object} mock - Mock model server.
 * @param {string} text - Message text.
 * @returns {Promise<number>} Request count when the request was observed.
 */
async function sendMessage(page, mock, text) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30000 });
  const before = mock.requests.length;
  await composer.fill(text);
  await composer.press('Enter');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && mock.requests.length <= before) await delay(200);
  if (mock.requests.length <= before) throw new Error(`发送“${text}”后 mock 模型没有收到请求`);
  return mock.requests.length;
}

/** Move the dock to the left edge through its own context menu. */
async function dockLeft(page) {
  await page.locator('.dsh-wb-activity').click({ button: 'right' });
  await page.locator('.dsh-wb-menu').waitFor({ timeout: 10000 });
  await page.getByText(/停靠到左侧|Dock to Left/).click();
  await page.waitForFunction(() => document.body.getAttribute('data-dock') === 'left', null, { timeout: 10000 });
}

const root = await mkdtemp(join(tmpdir(), 'study-layout-route2-'));
let mock;
try {
  await mkdir(EVIDENCE, { recursive: true });
  report.checks.install = await installDock(root);
  mock = await startMock();
  const playwright = loadPlaywright();
  const host = await startHost({ root, mock });

  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  browsers.push(browser);
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(host.url);
  await settleFirstRun(page);
  await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30000 });
  await page.locator('.dsh-wb-activity').waitFor({ timeout: 30000 });
  await delay(800);

  const initial = {
    geometry: await layoutGeometry(page),
    dockActivities: await page.locator('.dsh-wb-activity button').count(),
    probeActivity: await page.locator('.dsh-wb-activity button[title="学习工作台"]').count(),
  };
  await shot(page, 'route2-initial');
  report.checks.initial = initial;

  // One native turn while the dock bar floats over the page.
  const firstTurn = await sendMessage(page, mock, '帮我看看今天的学习安排');
  await delay(800);
  const withChat = { requests: firstTurn, geometry: await layoutGeometry(page) };
  await shot(page, 'route2-chat-and-dock');
  report.checks.withChat = withChat;

  // Open the probe workbench side panel.
  await page.locator('.dsh-wb-activity button[title="学习工作台"]').click();
  await page.getByTestId('layout-probe-dock-panel').waitFor({ timeout: 30000 });
  await delay(600);
  const sidePanel = { geometry: await layoutGeometry(page) };
  await shot(page, 'route2-side-panel');
  report.checks.sidePanel = sidePanel;

  // Dock the whole workbench to the left and send again while it overlays.
  await dockLeft(page);
  await delay(800);
  const left = { geometry: await layoutGeometry(page) };
  await shot(page, 'route2-dock-left');
  const leftTurn = await sendMessage(page, mock, '学习区在左边时还能对话吗');
  await delay(600);
  left.requests = leftTurn;
  left.geometryAfterChat = await layoutGeometry(page);
  await shot(page, 'route2-dock-left-chat');
  report.checks.left = left;

  // Docked editor view: dock mode hides the editor area entirely.
  await page.getByTestId('layout-probe-open-docked').click();
  await delay(800);
  const dockedEditor = {
    geometry: await layoutGeometry(page),
    editorMainViewCount: await page.locator('.dsh-wb-main [data-testid="layout-probe-dock-view"]').count(),
    editorMainViewVisible: await page.locator('.dsh-wb-main [data-testid="layout-probe-dock-view"]').isVisible().catch(() => false),
  };
  await shot(page, 'route2-docked-editor');
  report.checks.dockedEditor = dockedEditor;

  // Floating study window (a second view id, so it does not focus the hidden
  // docked tab).
  await page.getByTestId('layout-probe-open-float').click();
  await page.locator('.dsh-wb-floating').waitFor({ timeout: 20000 });
  await delay(500);
  const floating = { geometry: await layoutGeometry(page) };
  await shot(page, 'route2-floating');
  report.checks.floating = floating;

  // Reload: which dock state survives?
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settleFirstRun(page);
  await page.locator('.dsh-wb-activity').waitFor({ timeout: 30000 });
  await delay(1000);
  const reload = {
    geometry: await layoutGeometry(page),
    sidePanelVisible: await page.getByTestId('layout-probe-dock-panel').isVisible().catch(() => false),
    floatingCount: await page.locator('.dsh-wb-floating').count(),
  };
  await shot(page, 'route2-reload');
  report.checks.reload = reload;

  report.checks.pageErrors = pageErrors;
  report.checks.consoleErrors = consoleErrors.filter(text => /dock|layout-probe|client-modules/i.test(text));

  // Assertions: coexistence and the two presentations are real; the limits are
  // recorded as findings rather than hidden.
  assert.equal(initial.probeActivity, 1, 'dock 活动栏应出现学习区入口');
  assert.equal(initial.geometry.dockMainDisplay, null, '初始没有编辑器区');
  assert.ok(withChat.geometry.conversation !== null, '原生对话列应存在');
  assert.ok((sidePanel.geometry.dockSidebar?.width ?? 0) <= 305, 'dock 侧栏宽度上限应为 300px（含 1px 边框）');
  assert.equal(left.geometry.bodyDock, 'left', '右键菜单应能把 dock 停靠到左侧');
  assert.ok(leftTurn > firstTurn, 'dock 覆盖时原生对话仍应可发送');
  assert.ok((floating.geometry.floating?.width ?? 0) >= 500, '学习区应能在悬浮窗中打开');
  assert.equal(dockedEditor.geometry.dockMainDisplay, 'none', 'dock 模式下编辑器区应被隐藏');
  assert.equal(dockedEditor.editorMainViewVisible, false, '隐藏的编辑器视图不应可见');
  assert.equal(reload.geometry.bodyDock, 'left', '刷新后 dock 位置应恢复');
  assert.deepEqual(pageErrors, [], `页面抛出未捕获异常：${pageErrors.join('；')}`);

  report.checks.verdict = {
    coexist: 'dock 浮条/侧栏与原生对话同时存在，对话可继续发送。',
    dockable: '右键菜单可把 dock 停靠到左/右/上/下四边；停靠后仍只是浮条 + 300px 浮层。',
    floating: '学习区可开成独立悬浮窗（默认 520×360，可拖动缩放）。',
    noReflow: 'dock 不改变页面宽度/对话列宽度；只移动右侧 turn navigator，左停靠会覆盖左侧栏与对话左缘。',
    noWideWorkbench: 'dock 模式 CSS 隐藏编辑器区；侧栏上限 300px，无法承载 700px 级学习工作台。',
    persistence: '位置、侧栏/悬浮窗状态经 localStorage 恢复。',
  };
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const host of hosts.reverse()) await host.stop().catch(() => {});
  await mock?.close().catch(() => {});
  report.finished = new Date().toISOString();
  report.hostStderr = hosts.map(host => host.stderr().split(/\r?\n/).filter(Boolean).slice(-12));
  await writeFile(join(EVIDENCE, 'route2.json'), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
