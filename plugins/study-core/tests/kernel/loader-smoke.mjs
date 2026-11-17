/**
 * Loader smoke evidence for T01: boot the shipped DSH web profile with an
 * overlay that inserts this plugin, then prove the plugin's lifecycle ran by
 * reading the database it created (the day snapshot is written on the first composed service call).
 * The script is not named as a test on purpose: it starts the real host and is
 * run manually, like the project's desktop smoke.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const plugin = fileURLToPath(new URL('../../host/index.mjs', import.meta.url));
const shell = fileURLToPath(new URL('../../../study-outcomes/host/index.mjs', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'study-loader-'));
const home = join(root, 'home');
const dataDir = join(root, 'data');
const databaseFile = join(dataDir, 'study.db');
await mkdir(home, { recursive: true });
const overlayPath = join(root, 'overlay.yml');
const forward = value => value.replaceAll('\\', '/');
await writeFile(overlayPath, [
  '- id: session-log-deepseek',
  '  disabled: true',
  '- id: session-telemetry-otel',
  '  disabled: true',
  '- id: product-analytics',
  '  disabled: true',
  '- insert:',
  '    - id: study-core',
  `      name: ${JSON.stringify(forward(plugin))}`,
  '      config:',
  `        dataDir: ${JSON.stringify(forward(dataDir))}`,
    '    - id: study-facts',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-facts/host/index.mjs', import.meta.url))))}`,
    '    - id: study-memory',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-memory/host/index.mjs', import.meta.url))))}`,
    '    - id: study-learning',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-learning/host/index.mjs', import.meta.url))))}`,
    '    - id: study-reminders',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-reminders/host/index.mjs', import.meta.url))))}`,
  '    - id: study-outcomes',
  `      name: ${JSON.stringify(forward(shell))}`,
  '',
].join('\n'));

const env = { ...process.env };
for (const name of Object.keys(env)) if (/^(DSH_|ELECTRON_)/i.test(name)) delete env[name];
Object.assign(env, {
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
  DSH_HOME: home,
  DSH_AGENTS_HOME: join(root, 'agents'),
  DSH_TELEMETRY_DISABLED: '1',
  DSH_TELEMETRY_MODE: 'DISABLED',
});

const child = spawn(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
  'web', '--patch', overlayPath, '--no-open', '--port', '0',
], { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));

const report = { plugin, dataDir, booted: false, databaseCreated: false, initialized: false, daySnapshots: 0, journalMode: null, studyErrors: [] };
try {
  const deadline = Date.now() + 180000;
  let readyUrl;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Host exited before readiness with code ${child.exitCode}`);
    readyUrl = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
    if (readyUrl !== undefined) break;
    await delay(250);
  }
  if (readyUrl === undefined) throw new Error('Host did not report a readiness URL in 180s');
  report.booted = true;
  report.databaseCreated = existsSync(databaseFile);
  if (report.databaseCreated) {
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      report.journalMode = database.prepare('PRAGMA journal_mode').get().journal_mode;
      report.daySnapshots = Number(database.prepare('SELECT COUNT(*) AS count FROM day_snapshot').get().count);
      report.modules = database.prepare('SELECT module_id, schema_version FROM module_schema ORDER BY module_id').all();
    } finally {
      database.close();
    }
    report.snapshotsBeforeCall = report.daySnapshots;
    report.initialized = report.daySnapshots === 0 && report.journalMode === 'wal';
  }

  // Exchange the launch token for the browser cookie, then call the plugin's exact route through real auth.
  const origin = new URL(readyUrl).origin;
  const index = await fetch(readyUrl, { redirect: 'manual' });
  const setCookie = index.headers.getSetCookie?.()[0] ?? index.headers.get('set-cookie');
  if (typeof setCookie !== 'string' || setCookie.length === 0) throw new Error(`No browser cookie minted (index ${index.status})`);
  const cookie = setCookie.split(';', 1)[0];
  const response = await fetch(`${origin}/api/study/kernel/status`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'loader-smoke-1' }),
  });
  const envelope = await response.json();
  const afterCall = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    report.daySnapshots = Number(afterCall.prepare('SELECT COUNT(*) AS count FROM day_snapshot').get().count);
    const snapshot = JSON.parse(afterCall.prepare('SELECT plan_json FROM day_snapshot').get().plan_json);
    report.snapshotHasOutcomes = Object.hasOwn(snapshot, 'outcomes');
    report.initialized = report.initialized && report.daySnapshots === 1 && report.snapshotHasOutcomes;
  } finally { afterCall.close(); }
  const anonymous = await fetch(`${origin}/api/study/kernel/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'loader-smoke-anonymous' }),
  });
  report.route = {
    status: response.status,
    ok: envelope.ok,
    revision: envelope.revision,
    moduleIds: envelope.value?.modules?.map(module => module.id),
    todayDate: envelope.value?.today?.date,
    blocked: envelope.value?.blocked,
    anonymousStatus: anonymous.status,
  };
  report.routePassed = response.status === 200 && envelope.ok === true
    && Array.isArray(report.route.moduleIds) && report.route.moduleIds.includes('kernel')
    && (anonymous.status === 401 || anonymous.status === 403);
} catch (error) {
  report.error = error.message;
} finally {
  if (child.exitCode === null) {
    spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  }
  report.exit = await Promise.race([exited, delay(15000, null, { ref: false })]);
  report.studyErrors = stderr.split(/\r?\n/).filter(line => /study|StudyBuddy/i.test(line)).slice(0, 20);
  await writeFile(join(root, 'stdout.log'), stdout);
  await writeFile(join(root, 'stderr.log'), stderr);
  report.passed = report.initialized === true && report.routePassed === true && report.studyErrors.length === 0;
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--keep') !== true) await rm(root, { recursive: true, force: true });
  if (report.passed !== true) process.exitCode = 1;
}
