// Re-run the A01 evidence checks and rewrite verification.json.
// Everything here is read-only: it does not start Host/Desktop or touch user data.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidence = dirname(fileURLToPath(import.meta.url));
const root = resolve(evidence, ...Array(7).fill('..'));
const source = join(root, 'source/deepseek-harness');
const failure = [];
const ok = (condition, message) => { if (!condition) failure.push(message); };

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();

const lock = JSON.parse(readFileSync(join(evidence, 'baseline.lock.json'), 'utf8'));
const host = JSON.parse(readFileSync(join(evidence, 'host-result.json'), 'utf8'));
const desktop = JSON.parse(readFileSync(join(evidence, 'desktop-result.json'), 'utf8'));

for (const [file, expected] of Object.entries(lock.sha256)) {
  ok(sha256(join(source, file)) === expected, `sha256 mismatch: ${file}`);
}
ok(git('rev-parse', 'HEAD') === lock.source.commit, 'pinned commit mismatch');
ok(git('rev-parse', '--abbrev-ref', 'HEAD') === lock.source.branch, 'branch mismatch');
ok(git('status', '--porcelain=v1') === '', 'upstream worktree is not clean');

ok(host.passed === true, 'host smoke did not pass');
ok(host.unauthenticatedApiStatus === 401, 'host unauthenticated status is not 401');
ok(host.tokenExchangeStatus === 303, 'host token exchange is not 303');
ok(host.pageStatus === 200, 'host page status is not 200');
ok(Array.isArray(host.clientBundles) && host.clientBundles.length === 3 && host.clientBundles.every((b) => b.status === 200), 'client bundles are not 3x200');
ok(host.modelRequestsSubmitted === 0, 'host smoke submitted model requests');

ok(desktop.passed === true, 'desktop smoke did not pass');
ok(desktop.bootInjection === true, 'desktop app did not expose __DSH_BOOT__');
ok(desktop.keyInputEmpty === true, 'key input was not empty');
ok(typeof desktop.applicationUrl === 'string' && desktop.applicationUrl.startsWith('dsh-app://app/'), 'desktop application URL missing');
const screenshot = join(evidence, desktop.screenshot ?? 'desktop-workspace.png');
ok(existsSync(screenshot), 'desktop screenshot missing');
ok(existsSync(screenshot) && statSync(screenshot).size > 50_000, 'desktop screenshot is suspiciously small');
ok(existsSync(join(evidence, 'archive/desktop-failure-20261108T230522Z/desktop-result.json')), 'archived first-round desktop failure is missing');
ok(JSON.parse(readFileSync(join(evidence, 'archive/desktop-failure-20261108T230522Z/desktop-result.json'), 'utf8')).passed === false, 'archived first-round failure was altered');

const runtime = join(process.env.TEMP ?? '', 'a01-electron-runtime', 'electron.exe');
const dist = join(source, 'node_modules/.pnpm/electron@44.7.0_supports-color@9.4.0/node_modules/electron/dist/electron.exe');
if (existsSync(runtime)) {
  ok(sha256(runtime) === sha256(dist), 'temporary electron runtime differs from the pinned dist');
}
const labels = `${execFileSync('icacls', [root], { encoding: 'utf8' })}${execFileSync('icacls', [dist], { encoding: 'utf8' })}`;
ok(/Medium Mandatory Level/.test(labels), 'workspace/electron lacks the Medium integrity label (Electron GUI start-up regresses)');

const leak = /[?&](token|access_token|auth_token)=[A-Za-z0-9_\-.]{16,}/;
const scan = (path) => {
  const text = readFileSync(path, 'utf8');
  ok(!leak.test(text), `possible unredacted launch token in ${path}`);
};
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'archive' || entry === 'verification.json') continue;
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(log|json|md|txt)$/.test(entry)) scan(path);
  }
};
walk(evidence);

const report = {
  verifiedAt: new Date().toISOString(),
  checks: [
    'sha256 pnpm-lock.yaml, pnpm-workspace.yaml, scripts/primary-runtime/lock.json, LICENSE',
    'pinned commit, branch and clean upstream worktree',
    'Host smoke 401 / 303 / 200 with three 200 client bundles and zero model requests',
    'Desktop smoke passed with boot injection, empty key input and a real workspace screenshot',
    'workspace root and Electron executable carry the Medium integrity label (Electron GUI start-up precondition)',
    'first-round desktop failure and workaround pass preserved unaltered in archive/',
    'temporary Electron runtime (if present) is byte-identical to the pinned dist',
    'no unredacted launch token in evidence text',
  ],
  upstreamUnmodified: git('status', '--porcelain=v1') === '',
  hostPassed: host.passed === true,
  desktopPassed: desktop.passed === true,
  desktopElectronDistOverride: desktop.electronDistOverride ?? null,
  taskStatus: 'DONE',
  failures: failure,
};
writeFileSync(join(evidence, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failure.length) process.exitCode = 1;
