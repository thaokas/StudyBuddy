/** Run an isolated shipped DSH profile with an A02-only overlay. No SDK app or Agent-loop replacement. */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { authorizedKey } from './credentials.mjs';
import { officialModel } from './official-model.mjs';

const probe = dirname(fileURLToPath(import.meta.url));
const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const evidence = fileURLToPath(new URL('../../docs/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02/', import.meta.url));
const require = createRequire(join(source, 'package.json'));
const real = process.argv.includes('--real');
const native = process.argv.includes('--native');
const headless = process.argv.includes('--headless');
const desktop = process.argv.includes('--desktop');
const label = desktop ? (real ? (process.argv.includes('--resume') ? 'desktop-real-resume' : 'desktop-real') : process.argv.includes('--resume') ? 'desktop-resume' : 'desktop') : process.argv.includes('--resume') ? 'resume' : real ? 'real' : native ? 'native' : 'local';
const rootFlag = process.argv.indexOf('--root');
const root = rootFlag < 0 ? join(source, 'apps/desktop/.desktop-build/a02', `${label}-${Date.now()}`) : process.argv[rootFlag + 1];
if (!root.startsWith(join(source, 'apps/desktop/.desktop-build/a02'))) throw new Error('Run root must remain in the A02 sandbox directory');
if (existsSync(join(source, '.env'))) throw new Error('Refusing to load a source .env');
await mkdir(evidence, { recursive: true });
await mkdir(join(root, 'home'), { recursive: true });
await mkdir(join(root, 'workspace'), { recursive: true });
await writeFile(join(root, 'workspace', 'a02.txt'), 'A02 native tool fixture\n');
let mock;
if (!real) {
  const { startMockLlmServer } = require(join(source, 'packages/test-support/llm-mock-server/lib/index.js'));
  mock = await startMockLlmServer({
    sequence: process.argv.includes('--slow') ? ['slow_success'] : ['tool_call_success', 'success', 'slow_success', 'success'], repeatLast: true,
    successText: 'A02 adapter stream and tool round trip complete. '.repeat(16), chunkSize: 12, chunkDelayMs: 300,
    toolName: native ? 'read' : 'a02_probe',
    toolArguments: JSON.stringify(native ? { file_path: join(root, 'workspace', 'a02.txt') } : { value: 'agent-saved' }),
  });
}
const key = real ? await authorizedKey() : 'a02-fake-key';
const model = real ? await officialModel(key) : { id: 'deepseek-flash', name: 'A02 local fixture' };
if (real) await writeFile(join(evidence, 'official-model.json'), JSON.stringify(model, null, 2) + '\n');
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^DSH_|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|^ELECTRON_/i.test(name)) delete env[name];
}
Object.assign(env, {
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
  DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
  DSH_DESKTOP_USER_DATA_DIR: join(root, 'electron-user-data'),
  DEEPSEEK_API_KEY: key,
  DEEPSEEK_BASE_URL: real ? 'https://api.deepseek.com/anthropic' : `${mock.baseURL}/v1`,
  DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'DISABLED',
});
if (desktop) {
  for (const name of ['DSH_DESKTOP_MAIN_INSPECT_PORT', 'DSH_DESKTOP_RENDERER_DEBUG_PORT', 'DSH_DESKTOP_HOST_INSPECT_PORT']) {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    env[name] = String(server.address().port);
    await new Promise(resolve => server.close(resolve));
  }
  env.DSH_DESKTOP_OPEN_DEVTOOLS = '0';
}
const overlay = [
  '- id: session-log-deepseek\n  disabled: true', '- id: session-telemetry-otel\n  disabled: true',
  '- id: desktop-product-telemetry\n  disabled: true', '- id: product-analytics\n  disabled: true',
  '- id: session-title-llm\n  disabled: true',
  `- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(root, 'workspace'))}`,
  `- id: llm-deepseek\n  config:\n    baseURL: ${JSON.stringify(env.DEEPSEEK_BASE_URL)}\n    maxTokens: 1024\n    thinking: disabled\n    models:\n      - id: ${JSON.stringify(model.id)}\n        name: ${JSON.stringify(model.name)}\n        inputModalities: [text, image]`,
  ...headless ? [] : ['- insert:\n    - id: a02-probe\n      name: ' + JSON.stringify(join(probe, 'index.mjs').replaceAll('\\', '/'))],
].join('\n');
const patch = join(root, 'overlay.yml');
await writeFile(patch, overlay + '\n');
if (desktop) await writeFile(join(root, 'home/cordis.patch.yml'), overlay + '\n');
const args = desktop ? [join(source, 'node_modules/pnpm/bin/pnpm.mjs'), 'run', 'start:desktop'] : ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...(headless
  ? ['--profile', 'headless', '--patch', patch, 'Call the read tool to read a02.txt, then report the exact fixture text.']
  : ['web', '--patch', patch, '--patch', join(source, 'apps/web/tests/pin-browse-picker.overlay.yml'), '--no-open', '--port', '0'])];
const report = { started: new Date().toISOString(), label, source, root, home: env.DSH_HOME, userData: env.DSH_DESKTOP_USER_DATA_DIR,
  realProvider: real, model, maxOutputTokensPerRequest: 1024, scope: 'Profile readiness; functional results are in the separate test reports.', passed: false };
const redact = text => text.replaceAll(key, '[REDACTED]').replace(/([?&]token=)[^\s"'<>]+/g, '$1[REDACTED]');
let stdout = '', stderr = '';
const child = spawn(process.execPath, args, { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
child.stdout.on('data', chunk => { stdout += chunk; writeFileSync(join(evidence, `${label}.stdout.log`), redact(stdout)); });
child.stderr.on('data', chunk => { stderr += chunk; writeFileSync(join(evidence, `${label}.stderr.log`), redact(stderr)); });
try {
  if (headless) {
    report.exit = await Promise.race([exited, delay(120000, undefined, { ref: false }).then(() => { throw new Error('Headless deadline'); })]);
    report.nativeToolResults = mock?.requests[1]?.body?.messages?.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
    report.nativeToolResultSeen = JSON.stringify(report.nativeToolResults).includes('A02 native tool fixture');
    report.passed = report.exit.code === 0 && report.nativeToolResultSeen;
    if (!report.passed) process.exitCode = 1;
  } else {
    const deadline = Date.now() + (desktop ? 240000 : 120000);
    let url;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Host exited before readiness: ${child.exitCode}`);
      if (desktop) {
        try {
          const endpoint = `http://127.0.0.1:${env.DSH_DESKTOP_RENDERER_DEBUG_PORT}`;
          if ((await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(500) })).ok) url = endpoint;
        } catch { /* Electron has not bound its debug port yet. */ }
      } else url = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
      if (url) break;
      await delay(200);
    }
    if (!url) throw new Error('No Host readiness URL');
    report.origin = new URL(url).origin;
    await writeFile(join(root, 'browser-url.txt'), url);
    await writeFile(join(evidence, `${label}-running.json`), JSON.stringify({ root, origin: report.origin, pid: child.pid }) + '\n');
    if (desktop) await writeFile(join(evidence, 'desktop-running.json'), JSON.stringify({ root, origin: report.origin, pid: child.pid }) + '\n');
    if (desktop && real) await writeFile(join(evidence, 'desktop-real-running.json'), JSON.stringify({ root, origin: report.origin, pid: child.pid }) + '\n');
    console.log(JSON.stringify({ ready: true, root, origin: report.origin }));
    const deadline2 = Date.now() + 1800000;
    while (Date.now() < deadline2 && child.exitCode === null) {
      try { await access(join(root, 'stop')); break; } catch { /* Owned stop file has not been created. */ }
      await delay(500);
    }
    report.passed = true;
  }
} catch (error) {
  report.error = redact(error.message); process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    report.stopMethod = 'taskkill owned launcher tree; no graceful-shutdown claim';
    const stopped = spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    report.stopExit = stopped.status;
    report.stopError = stopped.error?.message;
    if (stopped.status !== 0) child.kill();
  }
  report.exit ??= await exited;
  if (mock) {
    report.modelRequests = mock.requests.map(({ behavior, outcome, chunksSent, body }) => ({
      behavior, outcome, chunksSent,
      toolNames: body?.tools?.map(tool => tool.name),
      imagePresent: JSON.stringify(body?.messages).includes('"image"'),
      filePresent: JSON.stringify(body?.messages).includes('a02.txt'),
    }));
    await mock.close();
  }
  report.finished = new Date().toISOString();
  await writeFile(join(evidence, `${label}.stdout.log`), redact(stdout));
  await writeFile(join(evidence, `${label}.stderr.log`), redact(stderr));
  await writeFile(join(evidence, `${label}-result.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ label, passed: report.passed, error: report.error, exit: report.exit }));
}
