// Run from any directory with the baseline Node; starts the documented dsh source launcher.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const evidence = dirname(fileURLToPath(import.meta.url));
const project = resolve(evidence, ...Array(7).fill('..'));
const source = join(project, 'source/deepseek-harness');
const runRoot = join(source, 'apps/desktop/.desktop-build/a01', `host-${Date.now()}`);
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^DSH_|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name)) delete env[name];
}
Object.assign(env, {
  DSH_HOME: join(runRoot, 'home'),
  DSH_AGENTS_HOME: join(runRoot, 'agents'),
  DSH_TELEMETRY_DISABLED: '1',
  DSH_TELEMETRY_MODE: 'DISABLED',
});
if (existsSync(join(source, '.env'))) throw new Error('Refusing keyless smoke with a source .env present');
await mkdir(runRoot, { recursive: true });
const args = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
  '--patch', join(evidence, 'smoke.cordis.patch.yml'), '--no-open', '--port', '0'];
const redact = (text) => text.replace(/([?&]token=)[^\s"'<>]+/g, '$1[REDACTED]');
const report = { started: new Date().toISOString(), source, command: [process.execPath, ...args],
  home: env.DSH_HOME, agentsHome: env.DSH_AGENTS_HOME, modelRequestsSubmitted: 0, passed: false };
let stdout = '', stderr = '', child, exitPromise;
try {
  child = spawn(process.execPath, args, { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  exitPromise = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 90000;
  let readyUrl;
  while (Date.now() < deadline) {
    readyUrl = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
    if (readyUrl) break;
    if (child.exitCode !== null) throw new Error(`Host exited before ready: ${child.exitCode}`);
    await delay(200);
  }
  if (!readyUrl) throw new Error('No complete Host readiness URL within 90 seconds');
  const origin = new URL(readyUrl).origin;
  report.origin = origin;
  const unauthorized = await fetch(`${origin}/api/a01-nonexistent`, { signal: AbortSignal.timeout(10000) });
  report.unauthenticatedApiStatus = unauthorized.status;
  if (unauthorized.status !== 401) throw new Error(`Expected API authentication refusal, got ${unauthorized.status}`);
  await unauthorized.arrayBuffer();
  const exchange = await fetch(readyUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  report.tokenExchangeStatus = exchange.status;
  const cookie = exchange.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  if (exchange.status !== 303 || !cookie) throw new Error('Browser authentication exchange did not return 303 and cookie');
  await exchange.arrayBuffer();
  const page = await fetch(`${origin}/`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) });
  const html = await page.text();
  report.pageStatus = page.status;
  report.pageBytes = Buffer.byteLength(html);
  report.hasBootInjection = html.includes('__DSH_BOOT__');
  if (page.status !== 200 || !report.hasBootInjection) throw new Error('Built frontend or plugin boot injection missing');
  // This commit advertises revisioned combo URLs, not the README's old per-id URLs.
  const bundlePaths = [...new Set([...html.matchAll(/(?:src|href)="(plugins\/[^"\s]+)"/g)]
    .map((match) => match[1].replaceAll('&amp;', '&')))];
  if (bundlePaths.length === 0) throw new Error('No advertised client bundles in the boot HTML');
  report.clientBundles = [];
  for (const path of bundlePaths) {
    const bundle = await fetch(new URL(path, `${origin}/`), { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) });
    const bytes = (await bundle.arrayBuffer()).byteLength;
    report.clientBundles.push({ status: bundle.status, bytes });
    if (bundle.status !== 200 || bytes === 0) throw new Error('Advertised client bundle unavailable');
  }
  report.passed = true;
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    // Windows terminate is not a graceful lifecycle test; A02/H01 must test real UI quit.
    report.stopMethod = process.platform === 'win32' ? 'TerminateProcess via child.kill; not graceful-shutdown acceptance' : 'SIGTERM';
    child.kill('SIGTERM');
  }
  if (exitPromise) report.exit = await exitPromise;
  report.finished = new Date().toISOString();
  await writeFile(join(evidence, 'host.stdout.log'), redact(stdout));
  await writeFile(join(evidence, 'host.stderr.log'), redact(stderr));
  await writeFile(join(evidence, 'host-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
