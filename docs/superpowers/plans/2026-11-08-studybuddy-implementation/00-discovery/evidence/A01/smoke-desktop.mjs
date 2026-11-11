// Launch the upstream start:desktop command, then inspect its owned UI via loopback CDP.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const evidence = dirname(fileURLToPath(import.meta.url));
const source = resolve(evidence, ...Array(7).fill('..'), 'source/deepseek-harness');
const require = createRequire(join(source, 'package.json'));
const { chromium } = require(join(source, 'node_modules/.pnpm/node_modules/playwright'));
const root = join(source, 'apps/desktop/.desktop-build/a01', `desktop-${Date.now()}`);
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^DSH_|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|^ELECTRON_/i.test(name)) delete env[name];
}
// The workspace tree inherits the Low mandatory integrity label of an earlier
// low-integrity sandbox; Electron 44.7.0 aborts before loading its main script
// when the executable carries that label (see baseline.md section 7). A01_ELECTRON_DIST
// points at a byte-identical copy of the pinned dist on a normal-integrity directory;
// prepare-electron-runtime.ps1 recreates it and re-verifies the SHA-256.
const electronDist = process.env.A01_ELECTRON_DIST || '';
const port = async () => {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return String(value);
};
Object.assign(env, {
  DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
  DSH_DESKTOP_USER_DATA_DIR: join(root, 'electron-user-data'),
  DSH_DESKTOP_MAIN_INSPECT_PORT: await port(),
  DSH_DESKTOP_RENDERER_DEBUG_PORT: await port(),
  DSH_DESKTOP_HOST_INSPECT_PORT: await port(),
  DSH_DESKTOP_OPEN_DEVTOOLS: '0',
  DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'DISABLED',
  ...(electronDist ? { ELECTRON_OVERRIDE_DIST_PATH: electronDist } : {}),
});
if (existsSync(join(source, '.env'))) throw new Error('Refusing keyless smoke with a source .env present');
await mkdir(env.DSH_HOME, { recursive: true });
await copyFile(join(evidence, 'smoke.cordis.patch.yml'), join(env.DSH_HOME, 'cordis.patch.yml'));
const args = [join(source, 'node_modules/pnpm/bin/pnpm.mjs'), 'run', 'start:desktop'];
const report = { started: new Date().toISOString(), source, command: [process.execPath, ...args],
  home: env.DSH_HOME, agentsHome: env.DSH_AGENTS_HOME, userData: env.DSH_DESKTOP_USER_DATA_DIR,
  electronDistOverride: electronDist || 'none (node_modules dist)', modelRequestsSubmitted: 0, passed: false };
const redact = (text) => text.replace(/([?&]token=)[^\s"'<>]+/g, '$1[REDACTED]');
let stdout = '', stderr = '', child, browser, exitPromise;
try {
  child = spawn(process.execPath, args, { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  exitPromise = new Promise((done, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal }));
  });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const endpoint = `http://127.0.0.1:${env.DSH_DESKTOP_RENDERER_DEBUG_PORT}`;
  const deadline = Date.now() + 480000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Desktop launcher exited before CDP: ${child.exitCode}`);
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch (error) { /* The runtime preparation has not opened Electron's CDP port yet. */ }
    await delay(1000);
  }
  browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  let welcome;
  for (let attempt = 0; attempt < 90; attempt++) {
    welcome = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes('welcome'));
    if (welcome) break;
    await delay(1000);
  }
  if (!welcome) throw new Error('No keyless welcome window');
  await welcome.getByRole('button', { name: /^(Add API Key|添加 API Key)$/ }).click({ timeout: 60000 });
  const input = welcome.locator('input');
  report.keyInputEmpty = await input.inputValue() === '';
  if (!report.keyInputEmpty) throw new Error('Expected an empty key input');
  await welcome.getByRole('button', { name: /^(Set up later|稍后配置)$/ }).click({ timeout: 60000 });
  let appPage;
  for (let attempt = 0; attempt < 90; attempt++) {
    appPage = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().startsWith('dsh-app://app/'));
    if (appPage && await appPage.locator('body').innerText().then((text) => text.trim().length > 20)) break;
    await delay(1000);
  }
  if (!appPage) throw new Error('No real workspace after Set up later');
  await appPage.waitForFunction(() => Boolean(window.__DSH_BOOT__) && document.body.innerText.trim().length > 20, null, { timeout: 60000 });
  await delay(3000);
  report.applicationUrl = appPage.url();
  report.title = await appPage.title();
  report.bootInjection = await appPage.evaluate(() => Boolean(window.__DSH_BOOT__));
  report.bodyTextLength = (await appPage.locator('body').innerText()).trim().length;
  await appPage.screenshot({ path: join(evidence, 'desktop-workspace.png') });
  report.screenshot = 'desktop-workspace.png';
  report.passed = true;
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch((error) => { report.disconnectError = redact(error.message); });
  if (child && child.exitCode === null) {
    report.stopMethod = 'taskkill /PID <owned launcher PID> /T /F; not graceful-shutdown acceptance';
    const stop = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    report.stopExit = stop.status;
  }
  if (exitPromise) report.exit = await exitPromise;
  report.finished = new Date().toISOString();
  await writeFile(join(evidence, 'desktop.stdout.log'), redact(stdout));
  await writeFile(join(evidence, 'desktop.stderr.log'), redact(stderr));
  await writeFile(join(evidence, 'desktop-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
