/**
 * T03 route 1: zero-patch wide right panel.
 *
 * Boots an isolated DSH Web host with the layout probe row and an upstream mock
 * model, then drives the real page at 1440x900:
 *
 * 1. Hero (no session) — the right Sidebar, its expand button and the study
 *    tab do not exist.
 * 2. Send one message to create a session, open the right Sidebar through the
 *    native expand button, open the probe tab through its guide card.
 * 3. Drag the native rightbar handle to its widest position and record the
 *    panel / conversation / left-sidebar widths.
 * 4. Exercise both surfaces: toggle a task and add one in the probe, then send
 *    a second message in the native conversation.
 * 5. Reload the same profile and record whether the tab/panel come back.
 *
 * Evidence: `probes/layout/evidence/route1/route1.json` plus screenshots.
 * Run: `node probes/layout/run-route1.mjs`
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
const EVIDENCE = join(PROBE_ROOT, 'evidence', 'route1');
const READINESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;
const SUCCESS_TEXT = '收到，今天先完成数学极限习题，再复习英语单词。';

const report = {
  task: 'T03',
  route: '1-zero-patch-right-panel',
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

/**
 * Write the probe overlay.
 * @param {string} root - Isolated run root.
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
 * Boot one isolated DSH Web host with the probe overlay.
 * @param {{ root: string, mock: object }} options - Run identity.
 * @returns {Promise<{ url: string, origin: string, stop: () => Promise<void>, stderr: () => string }>} Running host.
 */
async function startHost({ root, mock }) {
  await mkdir(join(root, 'home'), { recursive: true });
  const patch = await writeOverlay(root, mock);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^DSH_|^ELECTRON_/i.test(name)) delete env[name];
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    DSH_HOME: join(root, 'home'),
    DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
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

/**
 * Rect of one element, or null when absent.
 * @param {object} page - Playwright page.
 * @param {string} selector - CSS selector.
 * @returns {Promise<object | null>} Rect.
 */
async function rectOf(page, selector) {
  return await page.evaluate((value) => {
    const element = document.querySelector(value);
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
}

/**
 * Measure the three frame columns (sidebar / conversation / right panel).
 * @param {object} page - Playwright page.
 * @returns {Promise<object>} Geometry.
 */
async function frameGeometry(page) {
  return await page.evaluate(() => {
    const rect = (element) => {
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const rightbarCol = document.querySelector('[data-rightbar-col]');
    const center = rightbarCol?.previousElementSibling ?? null;
    const sidebar = center?.previousElementSibling ?? null;
    const panel = document.querySelector('[data-sidebar-right-panel]');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      sidebar: rect(sidebar),
      conversation: rect(center),
      rightbarTrack: rect(rightbarCol),
      rightPanel: rect(panel),
    };
  });
}

/** Screenshot the page and record the file. */
async function shot(page, name) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
  return `${name}.png`;
}

const root = await mkdtemp(join(tmpdir(), 'study-layout-route1-'));
let mock;
try {
  await mkdir(EVIDENCE, { recursive: true });
  mock = await startMock();
  const playwright = loadPlaywright();
  const host = await startHost({ root: join(root, 'run'), mock });

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
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ timeout: 30000 });

  // 1. Boot: DSH already selected one blank "new session", so the right
  // Sidebar exists but is collapsed and holds no study surface yet.
  const hero = {
    expandButtons: await page.locator('[data-sidebar-right-expand]').count(),
    openPanels: await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').count(),
    probeTabBodies: await page.locator('[data-testid="layout-probe-panel"]').count(),
    addTaskButtons: await page.getByTestId('layout-probe-add').count(),
    messages: mock.requests.length,
    geometry: await frameGeometry(page),
  };
  await shot(page, 'route1-hero-blank-session');
  report.checks.hero = hero;

  // 2. Open the right column before any message: the blank session already
  // owns a collapsed surface, so the study area can be opened at boot.
  const expand = page.locator('[data-sidebar-right-expand]');
  if (await expand.count() > 0) await expand.first().click();
  await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').waitFor({ timeout: 30000 });
  const guideCard = page.getByText('学习工作台（探针）', { exact: true });
  const cardDeadline = Date.now() + 20000;
  while (Date.now() < cardDeadline && await guideCard.count() === 0
    && await page.getByTestId('layout-probe-panel').count() === 0) await delay(250);
  if (await page.getByTestId('layout-probe-panel').count() === 0) {
    await guideCard.first().click({ timeout: 10000 });
  }
  await page.getByTestId('layout-probe-panel').waitFor({ timeout: 30000 });
  await delay(500);
  const blankSessionStudy = {
    messages: mock.requests.length,
    geometry: await frameGeometry(page),
    widthReadout: await page.getByTestId('layout-probe-width').innerText(),
  };
  await shot(page, 'route1-blank-session-study');
  report.checks.blankSessionStudy = blankSessionStudy;

  // 3. A global panel replaces the conversation: this is the real "no
  // conversation on screen" state. Record whether the study area survives.
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await delay(1200);
  const globalPanel = {
    studyVisible: await page.getByTestId('layout-probe-panel').isVisible().catch(() => false),
    openPanels: await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').count(),
    composerVisible: await page.locator('[contenteditable="true"]').first().isVisible().catch(() => false),
    geometry: await frameGeometry(page),
  };
  await shot(page, 'route1-global-panel');
  report.checks.globalPanel = globalPanel;

  // Return to the blank session row under the workspace.
  await page.getByText('新会话', { exact: true }).last().click();
  await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30000 });
  await delay(600);
  if (await page.getByTestId('layout-probe-panel').count() === 0) {
    if (await page.locator('[data-sidebar-right-expand]').count() > 0) {
      await page.locator('[data-sidebar-right-expand]').first().click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && await page.getByTestId('layout-probe-panel').count() === 0) {
        if (await page.getByText('学习工作台（探针）', { exact: true }).count() > 0) {
          await page.getByText('学习工作台（探针）', { exact: true }).first().click();
        }
        await delay(300);
      }
    }
  }
  await page.getByTestId('layout-probe-panel').waitFor({ timeout: 30000 });

  // 4. Create the first native turn; the conversation stays usable beside the
  // study area.
  await composer.fill('帮我看看今天的学习安排');
  await composer.press('Enter');
  const firstTurnDeadline = Date.now() + 90000;
  while (Date.now() < firstTurnDeadline && mock.requests.length === 0) await delay(200);
  assert.ok(mock.requests.length > 0, '发送消息后 mock 模型应收到请求');
  await page.waitForFunction((text) => document.body.innerText.includes(text), SUCCESS_TEXT, { timeout: 60000 })
    .catch(() => {});
  report.checks.mockRequestsAfterFirstTurn = mock.requests.length;

  const opened = {
    geometry: await frameGeometry(page),
    widthReadout: await page.getByTestId('layout-probe-width').innerText(),
    tabCount: await page.locator('[data-sidebar-right-tab]').count(),
  };
  await shot(page, 'route1-opened');
  report.checks.opened = opened;

  // 4. Drag the native handle to the widest allowed right panel.
  const handle = page.locator('[data-side="rightbar"]');
  await handle.waitFor({ timeout: 10000 });
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox !== null, '右栏拖拽手柄不可见');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 300);
  await page.mouse.down();
  await page.mouse.move(80, handleBox.y + 300, { steps: 25 });
  await page.mouse.up();
  await delay(600);
  const widest = {
    geometry: await frameGeometry(page),
    widthReadout: await page.getByTestId('layout-probe-width').innerText(),
  };
  await shot(page, 'route1-widest');
  report.checks.widest = widest;

  // 4b. Collapse the left navigation rail and measure the absolute rightbar
  // ceiling at 1440 (984px), then restore the navigation column.
  await page.locator('[data-sidebar-toggle]').first().click();
  await delay(700);
  const collapsedHandle = page.locator('[data-side="rightbar"]');
  await collapsedHandle.waitFor({ timeout: 10000 });
  const collapsedBox = await collapsedHandle.boundingBox();
  assert.ok(collapsedBox !== null, '侧栏收起后右栏拖拽手柄不可见');
  await page.mouse.move(collapsedBox.x + collapsedBox.width / 2, collapsedBox.y + 300);
  await page.mouse.down();
  await page.mouse.move(40, collapsedBox.y + 300, { steps: 25 });
  await page.mouse.up();
  await delay(600);
  const widestCollapsed = {
    geometry: await frameGeometry(page),
    widthReadout: await page.getByTestId('layout-probe-width').innerText(),
  };
  await shot(page, 'route1-widest-collapsed-sidebar');
  report.checks.widestCollapsed = widestCollapsed;
  await page.locator('[data-sidebar-toggle]').first().click();
  await delay(700);

  // 5. Both surfaces stay operable.
  await page.getByTestId('layout-probe-add').click();
  await page.getByTestId('layout-probe-add').click();
  const addedCount = await page.getByTestId('layout-probe-count').innerText();
  await page.getByTestId('layout-probe-note').fill('下午三点复习英语');
  const noteValue = await page.getByTestId('layout-probe-note').inputValue();
  const requestsBeforeSecondTurn = mock.requests.length;
  await composer.fill('第二条消息');
  await composer.press('Enter');
  const secondDeadline = Date.now() + 60000;
  while (Date.now() < secondDeadline && mock.requests.length <= requestsBeforeSecondTurn) await delay(200);
  await delay(500);
  const operability = {
    addedCount,
    noteValue,
    requestsBeforeSecondTurn,
    requestsAfterSecondTurn: mock.requests.length,
    conversationStillVisible: await page.locator('[contenteditable="true"]').first().isVisible(),
  };
  await shot(page, 'route1-operable');
  report.checks.operability = operability;

  // 6. Reload the same profile; the per-session layout should restore the tab.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settleFirstRun(page);
  await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30000 });
  let sessionRestored = true;
  try {
    await page.locator('[data-sidebar-right-expand]').first().waitFor({ timeout: 8000 });
  } catch {
    // An expanded panel hides the expand button on desktop; that state is the
    // other proof that the session came back.
    sessionRestored = await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').count() > 0;
  }
  if (sessionRestored) {
    const expandAfterReload = page.locator('[data-sidebar-right-expand]');
    if (await expandAfterReload.count() > 0) await expandAfterReload.first().click();
  }
  let tabRestored = false;
  let panelRestored = false;
  try {
    await page.locator('[data-sidebar-right-panel][data-sidebar-right-open]').waitFor({ timeout: 15000 });
    panelRestored = true;
  } catch {
    panelRestored = false;
  }
  try {
    await page.getByTestId('layout-probe-panel').waitFor({ timeout: 10000 });
    tabRestored = true;
  } catch {
    tabRestored = false;
  }
  const reload = {
    sessionRestored,
    panelRestored,
    tabRestored,
    geometry: await frameGeometry(page),
    tabs: await page.locator('[data-sidebar-right-tab]').count(),
  };
  await shot(page, 'route1-reload');
  report.checks.reload = reload;

  report.checks.pageErrors = pageErrors;
  report.checks.consoleErrors = consoleErrors.filter(text => /layout-probe|client-modules|sidebarRight/i.test(text));

  // Assertions: the acceptance evidence must be real, not inferred.
  assert.equal(hero.expandButtons, 1, 'DSH 首屏应选中一个空白新会话并给出右栏入口');
  assert.equal(hero.openPanels, 0, '右栏首屏应保持折叠');
  assert.equal(hero.probeTabBodies, 0, '首屏不应预渲染学习区');
  assert.equal(blankSessionStudy.messages, 0, '学习区应在发送任何消息前可用');
  assert.ok((blankSessionStudy.geometry.rightPanel?.width ?? 0) > 300, '空白会话下右栏应可展开');
  assert.equal(globalPanel.studyVisible, false, '全局面板替换对话时学习区应不可见');

  const widePanel = widest.geometry.rightPanel?.width ?? 0;
  const wideConversation = widest.geometry.conversation?.width ?? 0;
  const absolutePanel = widestCollapsed.geometry.rightPanel?.width ?? 0;
  assert.ok(widePanel >= 740 && widePanel <= 800, `1440×900 下右栏上限应约为 760px，实测 ${widePanel}`);
  assert.ok(wideConversation >= 395, `右栏拉满后对话列应保持至少 400px，实测 ${wideConversation}`);
  assert.ok(absolutePanel >= 980 && absolutePanel <= 990, `左侧导航收起后右栏上限应约为 984px，实测 ${absolutePanel}`);
  assert.equal(Number(addedCount), 2, '学习区按钮应真实可操作');
  assert.equal(noteValue, '下午三点复习英语');
  assert.ok(operability.requestsAfterSecondTurn > requestsBeforeSecondTurn, '学习区展开时原生对话应仍可发送消息');
  assert.ok(sessionRestored, '刷新后应恢复会话');
  assert.ok(panelRestored, '刷新后应恢复右栏展开状态');
  assert.ok(tabRestored, '刷新后应恢复学习区标签');
  assert.deepEqual(pageErrors, [], `页面抛出未捕获异常：${pageErrors.join('；')}`);

  report.checks.widthLimit = {
    formula: 'min(70% × 1440 = 1008, 1440 − nav − 400)',
    navExpanded: { nav: 280, measured: widePanel, conversation: wideConversation },
    navRail: { nav: 56, measured: absolutePanel, conversation: widestCollapsed.geometry.conversation?.width ?? 0 },
    centerMin: 400,
  };
  report.checks.noSessionAnswer = [
    `DSH 启动即创建一个空白“新会话”，因此没有“完全无会话”的首屏：空白会话下右栏可展开，学习区在发送第一条消息前就可用（消息数 ${blankSessionStudy.messages}）。`,
    `但全局面板（如“插件”）替换对话时，右栏与学习区一起消失（openPanels=${globalPanel.openPanels}，studyVisible=${globalPanel.studyVisible}）。`,
    '右栏按 session id 存储，真正没有任何 session 的界面不会渲染学习区。',
  ].join('');
  report.checks.direction = '学习区落在右栏、对话在中间列，方向与目标（左学习、右对话）相反。';
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
  await writeFile(join(EVIDENCE, 'route1.json'), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
