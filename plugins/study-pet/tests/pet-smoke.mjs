/**
 * Real-browser smoke for the StudyBuddy pet plugin.
 *
 * Boots the shipped DSH Web profile with `study-core`, `study-outcomes`, and
 * `study-pet` rows, then drives the real page in Edge:
 *
 * 1. the pet is in the shell overlay, visible, correctly sized, and labelled;
 * 2. clicking it opens a non-empty bubble;
 * 3. dragging it 120 px moves it and the position survives a reload;
 * 4. Settings → General shows the pet row, the size chips resize the pet, and
 *    the visibility switch hides the pet and brings it back;
 * 5. light, bubble, and dark screenshots land in `tests/evidence/`.
 *
 * Startup `/api/study/*` 404s from the shell host are recorded and whitelisted,
 * matching the appearance smoke. Run:
 * `node plugins/study-pet/tests/pet-smoke.mjs [--keep]`
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

const SOURCE = fileURLToPath(new URL('../../../source/deepseek-harness/', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVIDENCE = fileURLToPath(new URL('./evidence/', import.meta.url));
const BUILD_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'build-client.mjs');
const HOST_ENTRY = join(PLUGIN_ROOT, 'host', 'index.mjs');
const CORE_ROOT = fileURLToPath(new URL('../../study-core/', import.meta.url));
const FACTS_ROOT = fileURLToPath(new URL('../../study-facts/', import.meta.url));
const SHELL_ROOT = fileURLToPath(new URL('../../study-outcomes/', import.meta.url));
const READINESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;
const KEEP = process.argv.includes('--keep');

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

/** Build the pet bundle and refresh the composed bundles it runs beside. */
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
    `      name: ${JSON.stringify(forward(join(CORE_ROOT, 'host', 'index.mjs')))}`,
    '      config:',
    `        dataDir: ${JSON.stringify(forward(join(root, 'data')))}`,
    '    - id: study-outcomes',
    `      name: ${JSON.stringify(forward(join(SHELL_ROOT, 'host', 'index.mjs')))}`,
    '    - id: study-facts',
    `      name: ${JSON.stringify(forward(join(FACTS_ROOT, 'host', 'index.mjs')))}`,
    '    - id: study-pet',
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
 * Wait for the pet root and read its live geometry and bubble.
 * @param {object} page - Playwright page.
 * @returns {Promise<object>} Pet facts.
 */
async function readPet(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-study-pet]');
    if (root === null) return null;
    const body = document.querySelector('[data-study-pet-body]');
    const photo = root.querySelector('.sp-photo');
    const bubble = document.querySelector('[data-study-pet-bubble]');
    const summon = document.querySelector('[data-study-pet-summon]');
    const rect = root.getBoundingClientRect();
    const photoRect = photo === null ? null : photo.getBoundingClientRect();
    const photoSource = photo === null ? null : photo.getAttribute('src');
    const dataUrl = typeof photoSource === 'string' && photoSource.startsWith('data:image/png');
    let stored = null;
    try {
      stored = localStorage.getItem('study-pet:position');
    } catch {
      stored = 'blocked';
    }
    return {
      state: root.getAttribute('data-state'),
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      figureWidth: photoRect === null ? null : Math.round(photoRect.width),
      figureHeight: photoRect === null ? null : Math.round(photoRect.height),
      photoIsDataUrl: dataUrl,
      photoSrcPrefix: dataUrl ? photoSource.slice(0, 22) : null,
      photoNaturalWidth: photo === null ? null : photo.naturalWidth,
      photoNaturalHeight: photo === null ? null : photo.naturalHeight,
      mirror: root.getAttribute('data-mirror') === 'true',
      squash: root.getAttribute('data-squash'),
      label: body === null ? null : body.getAttribute('aria-label'),
      bubble: bubble === null ? null : {
        text: bubble.textContent ?? '',
        kind: bubble.getAttribute('data-kind'),
        scene: bubble.getAttribute('data-scene'),
      },
      summon: summon !== null,
      stored,
      dark: document.body.hasAttribute('data-ds-dark-theme'),
    };
  });
}

/**
 * Wait for the pet root to be visible.
 * @param {object} page - Playwright page.
 */
async function waitForPet(page) {
  const root = page.locator('[data-study-pet]').first();
  await root.waitFor({ state: 'visible', timeout: 30000 });
  return root;
}

/**
 * Drag the pet image by one viewport delta; a full press/move/release gesture.
 * @param {object} page - Playwright page.
 * @param {number} dx - Horizontal delta in pixels.
 * @param {number} dy - Vertical delta in pixels.
 */
async function dragPet(page, dx, dy) {
  const body = page.locator('[data-study-pet-body]').first();
  const box = await body.boundingBox();
  assert.ok(box !== null, 'pet body has a box to drag');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + Math.round(dx / 2), startY + Math.round(dy / 2), { steps: 6 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 6 });
  await page.mouse.up();
  await delay(500);
}

/** Open Settings → General with the shell shortcut. */
async function openSettings(page) {
  await page.keyboard.press('Control+Alt+Comma');
  const row = page.locator('[data-testid="study-pet-setting"]').first();
  await row.waitFor({ timeout: 20000 });
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await delay(250);
  return row;
}

/** Close the Settings surface. */
async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await delay(500);
}

/**
 * Main smoke sequence.
 */
async function main() {
  await mkdir(EVIDENCE, { recursive: true });
  await build();
  const root = await mkdtemp(join(tmpdir(), 'study-pet-'));
  let host;
  let browser;
  try {
    host = await startHost(root);
    const playwright = loadPlaywright();
    browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
    browsers.push(browser);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage();
    const timerStatusResponses = [];
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') report.consoleErrors.push(message.text());
    });
    page.on('response', response => {
      if (/\/api\/study\/timer\/status$/.test(response.url())) timerStatusResponses.push(response.status());
      if (response.status() >= 400) report.httpErrors.push({ status: response.status(), url: response.url() });
    });

    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await settleFirstRun(page);
    await delay(1200);
    await waitForPet(page);
    await delay(900);

    const initial = await readPet(page);
    report.checks.initial = initial;
    assert.ok(initial !== null, 'pet root renders in the shell overlay');
    assert.equal(await page.locator('[data-study-pet-body]').first().isVisible(), true);
    assert.ok(typeof initial.label === 'string' && initial.label.length > 0, 'pet button has an accessible label');
    assert.ok(initial.figureHeight >= 120 && initial.figureHeight <= 200, `figure height ${initial.figureHeight}px`);
    assert.ok(initial.figureWidth >= 120 && initial.figureWidth <= 200, `figure width ${initial.figureWidth}px`);
    assert.equal(initial.photoIsDataUrl, true, 'the plush image is an inlined data URL');
    assert.equal(initial.photoNaturalWidth, 451, 'the shipped logo1 asset renders at its natural width');
    assert.equal(initial.photoNaturalHeight, 423);
    assert.equal(initial.mirror, true, 'the pet starts on the right half and mirrors into the page');
    assert.ok(initial.left >= 0 && initial.top >= 0, 'pet starts inside the viewport');
    assert.ok(initial.left + initial.width <= 1440 + 1, 'pet respects the right edge');
    assert.ok(initial.top + initial.height <= 900 + 1, 'pet respects the bottom edge');
    assert.match(initial.state, /^(idle|think|working|celebrate|rest|error|sleep)$/);
    // Let the mount greeting expire so the light screenshot shows the idle pet.
    await delay(3600);
    await page.screenshot({ path: join(EVIDENCE, 'pet-light.png') });
    report.screenshots.push('pet-light.png');

    // The optional StudyBuddy integration must reach the real timer namespace
    // (study-facts is in this profile) rather than failing against the shell.
    const timerDeadline = Date.now() + 25_000;
    while (!timerStatusResponses.includes(200) && Date.now() < timerDeadline) await delay(500);
    report.checks.timerStatus = { responses: [...timerStatusResponses] };
    assert.ok(timerStatusResponses.includes(200), `timer/status returns 200, saw: ${timerStatusResponses.join(', ') || 'no request'}`);
    assert.equal(await page.locator('text=requires study-facts').count(), 0, 'no missing facts toast is visible');

    const body = page.locator('[data-study-pet-body]').first();
    await body.click({ timeout: 8000 });
    const bubble = page.locator('[data-study-pet-bubble]').first();
    await bubble.waitFor({ state: 'visible', timeout: 8000 });
    await delay(400);
    const bubbleStyle = await bubble.evaluate(node => {
      const style = getComputedStyle(node);
      return { opacity: style.opacity, color: style.color };
    });
    report.checks.bubbleStyle = bubbleStyle;
    assert.equal(bubbleStyle.opacity, '1', 'the bubble entrance animation settled');
    const colorMatch = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bubbleStyle.color);
    assert.ok(colorMatch !== null, `bubble color parses: ${bubbleStyle.color}`);
    const colorAlpha = colorMatch[4] === undefined ? 1 : Number(colorMatch[4]);
    assert.ok(colorAlpha > 0, 'bubble text color is not transparent');
    const bubbleText = (await bubble.innerText()).trim();
    report.checks.click = { text: bubbleText, kind: await bubble.getAttribute('data-kind'), style: bubbleStyle };
    assert.ok(bubbleText.length > 0, 'clicking the pet produces a non-empty bubble');
    await page.screenshot({ path: join(EVIDENCE, 'pet-bubble.png') });
    report.screenshots.push('pet-bubble.png');

    const beforeDrag = await readPet(page);
    await dragPet(page, -120, -60);
    const afterDrag = await readPet(page);
    report.checks.drag = { before: beforeDrag, after: afterDrag };
    assert.ok(beforeDrag.left - afterDrag.left >= 100, `dragged left by ${beforeDrag.left - afterDrag.left}px`);
    assert.ok(beforeDrag.top - afterDrag.top >= 40, `dragged up by ${beforeDrag.top - afterDrag.top}px`);
    assert.equal(afterDrag.mirror, true, 'a drag that stays on the right half keeps the mirror');
    assert.notEqual(afterDrag.stored, null, 'position is written to localStorage');
    const storedPosition = JSON.parse(afterDrag.stored);
    assert.equal(storedPosition.left, afterDrag.left);
    assert.equal(storedPosition.top, afterDrag.top);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await settleFirstRun(page);
    await waitForPet(page);
    await delay(900);
    const afterReload = await readPet(page);
    report.checks.reload = afterReload;
    assert.ok(Math.abs(afterReload.left - afterDrag.left) <= 2, `left kept after reload (${afterReload.left} vs ${afterDrag.left})`);
    assert.ok(Math.abs(afterReload.top - afterDrag.top) <= 2, `top kept after reload (${afterReload.top} vs ${afterDrag.top})`);
    assert.equal(afterReload.mirror, true, 'the remembered right-half position still mirrors');

    // Mirroring follows the viewport half and updates live while dragging: move
    // across the midpoint, then back.
    await dragPet(page, -780, 0);
    const mirroredLeft = await readPet(page);
    report.checks.mirrorLeft = mirroredLeft;
    assert.ok(mirroredLeft.left < 720, `the pet crossed the midpoint (left ${mirroredLeft.left})`);
    assert.equal(mirroredLeft.mirror, false, 'the left half keeps the original facing');

    await dragPet(page, 780, 0);
    const mirroredRight = await readPet(page);
    report.checks.mirrorRight = mirroredRight;
    assert.ok(mirroredRight.left >= 720, `the pet is back on the right half (left ${mirroredRight.left})`);
    assert.equal(mirroredRight.mirror, true, 'the right half mirrors again');

    const row = await openSettings(page);
    report.checks.settingsRow = { visible: await row.isVisible(), text: (await row.innerText()).slice(0, 400) };
    assert.equal(await row.isVisible(), true);
    await page.screenshot({ path: join(EVIDENCE, 'pet-settings.png') });
    report.screenshots.push('pet-settings.png');

    const heightBefore = (await readPet(page)).figureHeight;
    await page.locator('[data-testid="study-pet-size-1.2"]').first().click({ timeout: 8000 });
    await closeSettings(page);
    await delay(500);
    const larger = await readPet(page);
    report.checks.size = { before: heightBefore, after: larger.figureHeight, state: larger.state };
    assert.ok(larger.figureHeight >= Math.round(heightBefore * 1.15), `size grows: ${heightBefore} -> ${larger.figureHeight}`);

    await openSettings(page);
    await page.locator('[data-testid="study-pet-toggle"]').first().click({ timeout: 8000 });
    await closeSettings(page);
    await delay(500);
    const hidden = await readPet(page);
    report.checks.hidden = hidden;
    assert.equal(hidden, null, 'the pet disappears while hidden');
    assert.equal(await page.locator('[data-study-pet-summon]').first().isVisible(), true, 'the summon button appears');
    await page.screenshot({ path: join(EVIDENCE, 'pet-hidden.png') });
    report.screenshots.push('pet-hidden.png');

    await openSettings(page);
    await page.locator('[data-testid="study-pet-toggle"]').first().click({ timeout: 8000 });
    await closeSettings(page);
    await waitForPet(page);
    await delay(400);
    assert.equal(await page.locator('[data-study-pet]').first().isVisible(), true, 'the pet comes back');
    assert.equal(await page.locator('[data-study-pet-summon]').count(), 0, 'the summon button is gone');

    // Reduced motion must stop the plush breathing/squash, the bubble entrance,
    // and the hover-panel transition even though those rules have higher
    // specificity than a universal child selector.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await delay(300);
    await page.locator('[data-study-pet-body]').first().click({ timeout: 8000 });
    const reducedBubble = page.locator('[data-study-pet-bubble]').first();
    await reducedBubble.waitFor({ state: 'visible', timeout: 8000 });
    await delay(250);
    const reduced = await page.evaluate(() => {
      const root = document.querySelector('[data-study-pet]');
      const photo = root === null ? null : root.querySelector('.sp-photo');
      const frame = root === null ? null : root.querySelector('.sp-photo-frame');
      const bubble = document.querySelector('[data-study-pet-bubble]');
      const panel = root === null ? null : root.querySelector('.sp-panel');
      return {
        petState: root === null ? null : root.getAttribute('data-state'),
        photoAnimation: photo === null ? null : getComputedStyle(photo).animationName,
        photoTransition: photo === null ? null : getComputedStyle(photo).transitionDuration,
        frameTransition: frame === null ? null : getComputedStyle(frame).transitionDuration,
        bubbleAnimation: bubble === null ? null : getComputedStyle(bubble).animationName,
        bubbleTransition: bubble === null ? null : getComputedStyle(bubble).transitionDuration,
        panelTransition: panel === null ? null : getComputedStyle(panel).transitionDuration,
      };
    });
    report.checks.reducedMotion = reduced;
    assert.equal(reduced.photoAnimation, 'none', 'reduced motion stops the plush breathing/squash');
    assert.equal(reduced.bubbleAnimation, 'none', 'reduced motion stops the bubble entrance');
    for (const duration of String(reduced.panelTransition).split(',')) {
      assert.ok(Number.parseFloat(duration) <= 0.001, `panel transition duration is ${duration}`);
    }
    for (const duration of String(reduced.frameTransition).split(',')) {
      assert.ok(Number.parseFloat(duration) <= 0.001, `mirror-wrapper transition duration is ${duration}`);
    }
    await page.screenshot({ path: join(EVIDENCE, 'pet-reduced-motion.png') });
    report.screenshots.push('pet-reduced-motion.png');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await delay(250);
    // Let the reduced-motion click bubble expire and drop keyboard focus so the
    // dark-mode evidence shows the resting pet, not a focus ring or stale bubble.
    await delay(4_200);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });

    await openSettings(page);
    const dark = page.getByRole('button', { name: /^(深色|Dark)$/ }).first();
    const darkSelected = await dark.count() > 0;
    report.checks.darkOptionFound = darkSelected;
    if (darkSelected) {
      await dark.click({ timeout: 8000 });
      await delay(600);
    }
    await closeSettings(page);
    await delay(800);
    const darkState = await readPet(page);
    report.checks.dark = { dark: darkState.dark, state: darkState.state, bubbleTheme: await page.evaluate(() => {
      const bubble = document.querySelector('[data-study-pet-bubble]');
      if (bubble === null) return null;
      return getComputedStyle(bubble).color;
    }) };
    if (darkSelected) assert.equal(darkState.dark, true, 'dark scheme is active');
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.screenshot({ path: join(EVIDENCE, 'pet-dark.png') });
    report.screenshots.push('pet-dark.png');

    report.checks.pageErrors = report.pageErrors;
    report.checks.consoleErrors = report.consoleErrors;
    report.checks.httpErrors = report.httpErrors;
    // The shell host can still race reminder/milestone namespace registration
    // before the composed profile finishes activating. Keep `/api/study/*` out
    // of the unexpected-failure set as a defensive filter; this profile includes
    // study-facts, so a healthy run records zero such responses.
    const unexpectedHttp = report.httpErrors.filter(entry => !/favicon/i.test(entry.url)
      && !/\/api\/study\//.test(entry.url));
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
    await writeFile(join(EVIDENCE, 'pet-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
}

await main().catch(async (error) => {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  report.failedAt = new Date().toISOString();
  console.error(report.error);
  await writeFile(join(EVIDENCE, 'pet-smoke.json'), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  process.exitCode = 1;
});
