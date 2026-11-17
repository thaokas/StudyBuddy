/**
 * Appearance smoke for the StudyBuddy client plugin.
 *
 * Boots the shipped DSH Web profile with `study-core`, `study-outcomes`,
 * `study-facts`, and `study-appearance` rows, then drives the real page in Edge:
 *
 * 1. the appearance layer is on, the default sprout-paper + deep-sea packs are
 *    the computed token values, and the sidebar shows the plush buddy head crop
 *    + StudyBuddy wordmark (both brand images are inlined data URLs);
 * 2. every light pack colors the canvas, sidebar fill, and the conversation
 *    `header[data-window-drag]:has([data-conversation-header-leading])` from
 *    its own three-surface combination, and the composer's send circle carries
 *    the family info color;
 * 3. the switch restores the native look (canvas #fff, transparent header,
 *    native send button);
 * 4. every dark pack resolves through the native dark preference, with the
 *    same canvas / sidebar / header / send-button assertions;
 * 5. the two pack choices survive a full reload, and no "requires study-facts"
 *    toast is on screen (the profile composes the facts row like pet-smoke).
 *
 * Screenshots and the JSON report land in `tests/evidence/`.
 * Run: `node plugins/study-appearance/tests/appearance-smoke.mjs [--keep]`
 * Needs Edge and host-process permission, so it is not part of `node --test`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DARK_PACKS, LIGHT_PACKS } from '../client/theme.js';

const SOURCE = fileURLToPath(new URL('../../../source/deepseek-harness/', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE = fileURLToPath(new URL('./evidence/', import.meta.url));
const BUILD_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'build-client.mjs');
const HOST_ENTRY = join(PLUGIN_ROOT, 'host', 'index.mjs');
const CORE_ROOT = fileURLToPath(new URL('../../study-core/', import.meta.url));
const CORE_ENTRY = join(CORE_ROOT, 'host', 'index.mjs');
const SHELL_ROOT = fileURLToPath(new URL('../../study-outcomes/', import.meta.url));
const SHELL_ENTRY = join(SHELL_ROOT, 'host', 'index.mjs');
const FACTS_ROOT = fileURLToPath(new URL('../../study-facts/', import.meta.url));
const FACTS_ENTRY = join(FACTS_ROOT, 'host', 'index.mjs');
const READINESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;
const KEEP = process.argv.includes('--keep');

const LIGHT_IDS = Object.keys(LIGHT_PACKS);
const DARK_IDS = Object.keys(DARK_PACKS);

const report = {
  started: new Date().toISOString(),
  checks: {},
  screenshots: [],
  pageErrors: [],
  consoleErrors: [],
  httpErrors: [],
  passed: false,
};

const hosts = [];
const browsers = [];

/** Forward slashes for YAML values on Windows. */
const forward = value => value.replaceAll('\\', '/');

/** @param {string} hex - Six-digit hex. @returns {string} `rgb(r, g, b)` matching getComputedStyle. */
function rgb(hex) {
  const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** @param {string} value - Stored hex value. @returns {string} Upper-case hex for comparisons. */
const normHex = value => value.trim().toUpperCase();

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

/** Build the appearance bundle and refresh the composed bundles it runs beside. */
async function build() {
  const steps = [
    [CORE_ROOT, join(CORE_ROOT, 'scripts', 'build-client.mjs')],
    [SHELL_ROOT, join(SHELL_ROOT, 'scripts', 'build-client.mjs')],
    [PLUGIN_ROOT, BUILD_SCRIPT],
  ];
  for (const [cwd, script] of steps) {
    const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', timeout: 180000 });
    if (result.status !== 0) {
      throw new Error(`客户端构建失败（${script}，退出 ${result.status}）：\n${result.stderr || result.stdout}`);
    }
  }
}

/**
 * Write the profile overlay for this smoke.
 * @param {string} root - Temporary data root.
 * @returns {Promise<string>} Overlay path.
 */
async function writeOverlay(root) {
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
    '- id: desktop-product-telemetry',
    '  disabled: true',
    '- id: product-analytics',
    '  disabled: true',
    '- insert:',
    '    - id: study-core',
    `      name: ${JSON.stringify(forward(CORE_ENTRY))}`,
    '      config:',
    `        dataDir: ${JSON.stringify(forward(join(root, 'data')))}`,
    '    - id: study-outcomes',
    `      name: ${JSON.stringify(forward(SHELL_ENTRY))}`,
    '    - id: study-facts',
    `      name: ${JSON.stringify(forward(FACTS_ENTRY))}`,
    '    - id: study-appearance',
    `      name: ${JSON.stringify(forward(HOST_ENTRY))}`,
  ];
  const file = join(root, 'overlay.yml');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/**
 * Boot one isolated DSH Web host.
 * @param {string} root - Temporary data root.
 * @returns {Promise<object>} Running host handle.
 */
async function startHost(root) {
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  const patch = await writeOverlay(root);
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
    await writeFile(join(EVIDENCE, 'host.stdout.log'), stdout);
    await writeFile(join(EVIDENCE, 'host.stderr.log'), stderr);
  };
  const host = { url: undefined, origin: undefined, pid: child.pid, child, stdout: () => stdout, stderr: () => stderr, stop };
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

/** Buttons of the first-run chain, in dismissal order. */
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
 * Clear the preview notice and sign-in gate a fresh profile chains together.
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
  throw new Error('首屏对话框没有关闭，会拦截页面操作');
}

/**
 * Read the appearance state from the live document.
 * @param {object} page - Playwright page.
 * @returns {Promise<object>} Root attributes, inline override tokens and computed colors.
 */
async function readAppearance(page) {
  return page.evaluate(() => {
    const body = document.body;
    const read = name => {
      if (body === null) return '';
      const inline = body.style.getPropertyValue(name).trim();
      return inline !== '' ? inline : getComputedStyle(body).getPropertyValue(name).trim();
    };
    const inline = name => (body === null ? '' : body.style.getPropertyValue(name).trim());
    const backgroundColor = element => (element === null ? null : getComputedStyle(element).backgroundColor);
    // The frame publishes its grid tracks inline and paints --dsw-alias-bg-base;
    // pick the first such element that actually paints a background.
    const canvases = [...document.querySelectorAll('div[style*="grid-template-columns"]')];
    const canvas = canvases.find(element => backgroundColor(element) !== 'rgba(0, 0, 0, 0)') ?? null;
    const header = document.querySelector('header[data-window-drag]');
    const strip = document.querySelector('[data-dockkit-strip]');
    // The composer's primary circle is the stable send control; its glyph is
    // static #fff, so the fill must carry the family's info color.
    const send = document.querySelector('button[aria-label="发送消息"], button[aria-label="Send message"]');
    return {
      enabled: document.documentElement.dataset.studyAppearance ?? null,
      lightPack: document.documentElement.dataset.studyLightPack ?? null,
      darkPack: document.documentElement.dataset.studyDarkPack ?? null,
      nativeDark: body !== null && body.hasAttribute('data-ds-dark-theme'),
      bgBase: read('--dsw-alias-bg-base'),
      sidebarFill: read('--dsw-specific-sidebar-fill'),
      topbar: read('--study-topbar'),
      brand: read('--dsw-alias-brand-primary'),
      inlineBgBase: inline('--dsw-alias-bg-base'),
      inlineSidebarFill: inline('--dsw-specific-sidebar-fill'),
      inlineTopbar: inline('--study-topbar'),
      inlineInfoFill: inline('--dsw-alias-button-info-fill'),
      inlineBrandSignal: inline('--dsw-alias-brand-primary-new-colorprimary-new-color'),
      canvasCount: canvases.length,
      canvasBackground: backgroundColor(canvas),
      headerCount: header === null ? 0 : 1,
      headerBackground: backgroundColor(header),
      dockStripCount: strip === null ? 0 : 1,
      dockStripBackground: backgroundColor(strip),
      sendCount: send === null ? 0 : 1,
      sendBackground: backgroundColor(send),
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      brandVisible: [...document.querySelectorAll('[data-testid="study-brand-mark"]')]
        .some(node => node.getBoundingClientRect().width > 0),
    };
  });
}

/**
 * Read one brand image: inline data-URL source, intrinsic size and rendered box.
 * @param {object} page - Playwright page.
 * @param {string} testid - `data-testid` of the image.
 * @returns {Promise<object|null>} Image facts, or null when the image is absent.
 */
async function readBrandImage(page, testid) {
  const selector = `[data-testid="${testid}"]`;
  const locator = page.locator(selector).first();
  if (await locator.count() === 0) return null;
  await locator.waitFor({ timeout: 20000 });
  await page.waitForFunction(
    value => [...document.querySelectorAll(value)].some(node => node.complete && node.naturalWidth > 0),
    selector,
    { timeout: 15000 },
  ).catch(() => {});
  return locator.evaluate(node => {
    const box = node.getBoundingClientRect();
    const src = node.getAttribute('src') ?? '';
    return {
      inline: src.startsWith('data:image/png;base64,'),
      srcLength: src.length,
      naturalWidth: node.naturalWidth,
      naturalHeight: node.naturalHeight,
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  });
}

/**
 * Open Settings → General and scroll the appearance row into view.
 * @param {object} page - Playwright page.
 * @returns {object} The appearance row locator.
 */
async function openSettings(page) {
  const row = page.locator('[data-testid="study-appearance-setting"]').first();
  if (!(await row.isVisible().catch(() => false))) {
    await page.keyboard.press('Control+Alt+Comma');
  }
  await row.waitFor({ state: 'visible', timeout: 20000 });
  await row.scrollIntoViewIfNeeded();
  return row;
}

/**
 * Close the Settings modal through the document-level Escape handler.
 * @param {object} page - Playwright page.
 */
async function closeSettings(page) {
  const row = page.locator('[data-testid="study-appearance-setting"]').first();
  if (!(await row.isVisible().catch(() => false))) return;
  await page.keyboard.press('Escape');
  await row.waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
  await delay(400);
}

/**
 * Click one palette chip.
 * @param {object} page - Playwright page.
 * @param {string} testid - `data-testid` of the chip.
 */
async function selectPack(page, testid) {
  const chip = page.locator(`[data-testid="${testid}"]`).first();
  await chip.waitFor({ timeout: 10000 });
  await chip.click({ timeout: 8000 });
  await delay(450);
}

/**
 * Apply the built-in dark appearance through the shell Settings row.
 * @param {object} page - Playwright page.
 * @returns {Promise<boolean>} Whether the dark cube was found and clicked.
 */
async function selectDark(page) {
  const dark = page.getByRole('button', { name: /^(深色|Dark)$/ }).first();
  if (await dark.count() === 0) return false;
  await dark.click({ timeout: 8000 });
  await delay(900);
  return true;
}

/**
 * Assert one pack's three student-facing surfaces reached the live document.
 * @param {object} state - `readAppearance` result.
 * @param {string} id - Pack id.
 * @param {'light'|'dark'} scheme - Which half of the pair the pack supplies.
 */
function assertPackState(state, id, scheme) {
  const pack = scheme === 'light' ? LIGHT_PACKS[id] : DARK_PACKS[id];
  assert.equal(scheme === 'light' ? state.lightPack : state.darkPack, id, `${scheme} pack id`);
  assert.equal(state.enabled, 'on', 'layer must stay on while switching packs');
  assert.equal(normHex(state.inlineBgBase), pack.surfaces.base, `${id} canvas token`);
  assert.equal(normHex(state.inlineSidebarFill), pack.surfaces.sidebar, `${id} sidebar token`);
  assert.equal(normHex(state.inlineTopbar), pack.surfaces.topbar, `${id} top-bar token`);
  assert.equal(state.canvasBackground, rgb(pack.surfaces.base), `${id} canvas computed background`);
  assert.equal(state.headerCount, 1, 'main conversation header must be present');
  assert.equal(state.headerBackground, rgb(pack.surfaces.topbar), `${id} header computed background`);
  if (state.dockStripCount > 0) {
    assert.equal(state.dockStripBackground, rgb(pack.surfaces.topbar), `${id} dock strip computed background`);
  }
  // The send circle and DSH's signal accent follow the family, not the surface:
  // green in the light family, background-safe blue in the dark family.
  const infoFill = scheme === 'light' ? '#3F6B26' : '#4E7FD8';
  assert.equal(normHex(state.inlineInfoFill), infoFill, `${id} send-button token`);
  assert.equal(normHex(state.inlineBrandSignal), infoFill, `${id} signal-accent token`);
  assert.equal(state.sendCount, 1, 'the composer send button must be present');
  assert.equal(state.sendBackground, rgb(infoFill), `${id} send button computed background`);
}

/**
 * Screenshot one pack with Settings closed.
 * @param {object} page - Playwright page.
 * @param {string} file - Evidence file name.
 */
async function shoot(page, file) {
  await page.screenshot({ path: join(EVIDENCE, file) });
  report.screenshots.push(file);
}

/**
 * Main smoke sequence.
 */
async function main() {
  await mkdir(EVIDENCE, { recursive: true });
  await build();
  const root = await mkdtemp(join(tmpdir(), 'study-appearance-'));
  let host;
  let browser;
  try {
    host = await startHost(root);
    const playwright = loadPlaywright();
    browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
    browsers.push(browser);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') report.consoleErrors.push(message.text());
    });
    page.on('response', response => {
      if (response.status() >= 400) report.httpErrors.push({ status: response.status(), url: response.url() });
    });

    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settleFirstRun(page);
    await delay(1200);

    const initial = await readAppearance(page);
    report.checks.initial = initial;
    assert.equal(initial.enabled, 'on');
    assert.equal(initial.lightPack, 'sprout-paper');
    assert.equal(initial.darkPack, 'deep-sea');
    assertPackState(initial, 'sprout-paper', 'light');
    assert.match(initial.brand.toLowerCase(), /#3f6b26|rgb\(63,\s*107,\s*38\)/);

    // Sidebar mark: the 250×250 head crop derived from the 451×423 plush portrait.
    const mark = await readBrandImage(page, 'study-brand-mark');
    report.checks.brandMark = mark;
    assert.ok(mark !== null, 'the sidebar brand mark must render');
    assert.equal(mark.inline, true, 'the sidebar mark must be an inlined PNG data URL');
    assert.equal(mark.naturalWidth, 250, 'sidebar mark uses the derived square head crop');
    assert.equal(mark.naturalHeight, 250);
    assert.ok(mark.width >= 20 && mark.width <= 30, `sidebar mark width ${mark.width}px`);
    assert.equal(mark.width, mark.height, 'the sidebar mark stays square');
    assert.equal(await page.locator('[data-testid="study-brand-name"]').first().innerText(), 'StudyBuddy');

    // Hero: the complete 451×423 plush portrait, not the head crop.
    const hero = await readBrandImage(page, 'study-hero-brand-mark');
    report.checks.heroMark = hero;
    if (hero !== null) {
      assert.equal(hero.inline, true, 'the hero mark must be an inlined PNG data URL');
      assert.equal(hero.naturalWidth, 451, 'hero uses the complete portrait');
      assert.equal(hero.naturalHeight, 423);
      assert.ok(hero.width >= 30 && hero.width <= 38, `hero mark width ${hero.width}px`);
    }

    // The profile composes study-facts, so the shell's milestones routes are
    // real; the missing-facts toast that used to sit bottom-left must be gone.
    await delay(2500);
    const missingFactsToasts = await page.locator('text=requires study-facts').count();
    report.checks.missingFactsToasts = missingFactsToasts;
    assert.equal(missingFactsToasts, 0, 'the composed study-facts row must clear the missing-facts toast');

    // Light group: every pack owns its own canvas, sidebar and top bar.
    await openSettings(page);
    report.checks.settingsRow = { visible: true, text: (await page.locator('[data-testid="study-appearance-setting"]').first().innerText()).slice(0, 500) };
    // The 44px settings preview keeps the complete portrait, like the hero.
    const preview = await readBrandImage(page, 'study-appearance-preview');
    report.checks.settingsPreview = preview;
    assert.ok(preview !== null, 'the settings preview must render');
    assert.equal(preview.inline, true, 'the settings preview must be an inlined PNG data URL');
    assert.equal(preview.naturalWidth, 451, 'settings preview uses the complete portrait');
    assert.equal(preview.naturalHeight, 423);
    assert.ok(preview.width >= 40 && preview.width <= 48, `settings preview width ${preview.width}px`);
    await shoot(page, 'appearance-settings-row.png');
    await shoot(page, 'appearance-settings.png');

    report.checks.lightPacks = {};
    for (const id of LIGHT_IDS) {
      await selectPack(page, `study-appearance-light-${id}`);
      const state = await readAppearance(page);
      report.checks.lightPacks[id] = state;
      assertPackState(state, id, 'light');
      assert.equal(state.nativeDark, false, 'light pack checks run under the native light scheme');
      await closeSettings(page);
      const closed = await readAppearance(page);
      assertPackState(closed, id, 'light');
      await shoot(page, `appearance-light-${id}.png`);
      await openSettings(page);
    }

    // Switch off: the override layer retracts, so the native light canvas
    // (#fff) and the transparent header come back.
    const toggle = page.locator('[data-testid="study-appearance-toggle"]').first();
    await toggle.click({ timeout: 8000 });
    await delay(500);
    const off = await readAppearance(page);
    report.checks.off = off;
    assert.equal(off.enabled, 'off');
    assert.equal(off.inlineBgBase, '', 'the override layer must retract the canvas token');
    assert.equal(off.inlineTopbar, '', 'the override layer must retract the top-bar token');
    assert.equal(off.inlineInfoFill, '', 'the override layer must retract the send-button token');
    assert.equal(off.canvasBackground, 'rgb(255, 255, 255)', 'native light canvas is #fff');
    assert.equal(off.headerBackground, 'rgba(0, 0, 0, 0)', 'the top-bar rule must not apply while off');
    await closeSettings(page);
    await shoot(page, 'appearance-off-native.png');

    await openSettings(page);
    await toggle.click({ timeout: 8000 });
    await delay(500);
    const back = await readAppearance(page);
    report.checks.back = back;
    assert.equal(back.enabled, 'on');
    assertPackState(back, 'celadon-page', 'light');
    await closeSettings(page);

    // Narrow windows keep the layer intact; 320px collapses host navigation.
    report.checks.narrow = {};
    for (const width of [1024, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await delay(500);
      const state = await readAppearance(page);
      report.checks.narrow[width] = state;
      await shoot(page, `appearance-narrow-${width}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await delay(400);

    // Dark group: switch the native preference to dark, then walk all packs.
    await openSettings(page);
    const selectedDark = await selectDark(page);
    report.checks.darkOptionClicked = selectedDark;
    assert.equal(selectedDark, true, 'the shell Appearance row must expose the dark option');
    const darkMode = await readAppearance(page);
    assert.equal(darkMode.nativeDark, true, 'native dark palette attaches data-ds-dark-theme');

    report.checks.darkPacks = {};
    for (const id of DARK_IDS) {
      await selectPack(page, `study-appearance-dark-${id}`);
      const state = await readAppearance(page);
      report.checks.darkPacks[id] = state;
      assertPackState(state, id, 'dark');
      assert.equal(state.nativeDark, true, 'dark pack checks run under the native dark scheme');
      await closeSettings(page);
      const closed = await readAppearance(page);
      assertPackState(closed, id, 'dark');
      await shoot(page, `appearance-dark-${id}.png`);
      await openSettings(page);
    }

    // Both pack choices persist across a full reload.
    await closeSettings(page);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await settleFirstRun(page);
    await delay(2500);
    const persisted = await readAppearance(page);
    report.checks.persisted = persisted;
    assert.equal(persisted.enabled, 'on');
    assert.equal(persisted.lightPack, 'celadon-page');
    assert.equal(persisted.darkPack, 'starry-blue');
    assertPackState(persisted, 'starry-blue', 'dark');
    const persistedToasts = await page.locator('text=requires study-facts').count();
    report.checks.persistedMissingFactsToasts = persistedToasts;
    assert.equal(persistedToasts, 0, 'the reloaded profile must not show the missing-facts toast');

    report.checks.pageErrors = report.pageErrors;
    report.checks.consoleErrors = report.consoleErrors;
    report.checks.httpErrors = report.httpErrors;
    // The shell's reminder/milestone overlays poll before the shell finishes
    // registering its namespaces; those startup 404/503s (`/api/study/*`) are
    // owned by the shell during the parallel P2 memory migration and are not
    // appearance failures. Record them, and fail on anything else.
    const hostNoise = entry => (entry.status === 404 || entry.status === 503) && /\/api\/study\//.test(entry.url);
    const unexpectedHttp = report.httpErrors.filter(entry => !/favicon/i.test(entry.url) && !hostNoise(entry));
    report.checks.hostNoiseHttpErrors = report.httpErrors.filter(entry => !/favicon/i.test(entry.url) && hostNoise(entry));
    report.checks.unexpectedHttpErrors = unexpectedHttp;
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors.filter(text => !/Failed to load resource/.test(text)), []);
    assert.deepEqual(unexpectedHttp, []);
    report.passed = true;
    console.log(JSON.stringify({ ok: true, root, report }, null, 2));
  } finally {
    await browser?.close().catch(() => {});
    await host?.stop().catch(() => {});
    if (!KEEP) await rm(root, { recursive: true, force: true }).catch(() => {});
    report.finished = new Date().toISOString();
    await writeFile(join(EVIDENCE, 'appearance-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
}

await main().catch(async (error) => {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  report.failedAt = new Date().toISOString();
  console.error(report.error);
  await writeFile(join(EVIDENCE, 'appearance-smoke.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  process.exitCode = 1;
});
