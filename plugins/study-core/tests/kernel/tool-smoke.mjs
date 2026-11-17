/**
 * Agent-loop smoke evidence for T01: run the shipped headless profile against
 * the upstream mock model server, make the mock call `study_status`, and prove
 * the tool is visible to the model and returns real kernel facts. Manual run,
 * not part of `node --test`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const plugin = fileURLToPath(new URL('../../host/index.mjs', import.meta.url));
const shell = fileURLToPath(new URL('../../../study-outcomes/host/index.mjs', import.meta.url));
const requireFromSource = createRequire(join(source, 'package.json'));
const { startMockLlmServer } = requireFromSource(join(source, 'packages/test-support/llm-mock-server/lib/index.js'));

const root = await mkdtemp(join(tmpdir(), 'study-tool-'));
const home = join(root, 'home');
const dataDir = join(root, 'data');
await mkdir(home, { recursive: true });
const mock = await startMockLlmServer({
  sequence: ['tool_call_success', 'success'],
  repeatLast: true,
  successText: '学习服务已读取。',
  toolName: 'study_status',
  toolArguments: '{}',
});
const forward = value => value.replaceAll('\\', '/');
const overlayPath = join(root, 'overlay.yml');
await writeFile(overlayPath, [
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
  '        name: StudyBuddy smoke model',
  '        inputModalities: [text]',
  '- insert:',
  '    - id: study-core',
  `      name: ${JSON.stringify(forward(plugin))}`,
  '      config:',
  `        dataDir: ${JSON.stringify(forward(dataDir))}`,
    '    - id: study-learning',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-learning/host/index.mjs', import.meta.url))))}`,
    '    - id: study-reminders',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-reminders/host/index.mjs', import.meta.url))))}`,
  '    - id: study-outcomes',
  `      name: ${JSON.stringify(forward(shell))}`,
  '',
].join('\n'));

const env = { ...process.env };
for (const name of Object.keys(env)) if (/^DSH_|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|^ELECTRON_/i.test(name)) delete env[name];
Object.assign(env, {
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
  DSH_HOME: home,
  DSH_AGENTS_HOME: join(root, 'agents'),
  DEEPSEEK_API_KEY: 'study-smoke-fake-key',
  DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_TELEMETRY_MODE: 'DISABLED',
});

const report = { plugin, dataDir, mockBaseUrl: mock.baseURL, toolVisible: false, toolResultSeen: false, passed: false };
try {
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    '--profile', 'headless', '--patch', overlayPath,
    'Call the study_status tool, then tell me the learning service revision.',
  ], { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  report.exit = await Promise.race([exited, delay(180000, undefined, { ref: false }).then(() => {
    spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    return { code: null, signal: 'deadline' };
  })]);

  const first = mock.requests[0]?.body;
  report.toolVisible = first?.tools?.some(tool => tool.name === 'study_status') === true;
  const toolResults = mock.requests
    .flatMap(request => request.body?.messages ?? [])
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result');
  const text = JSON.stringify(toolResults);
  report.toolResultSeen = text.includes('coreSchemaVersion') && text.includes('journalMode');
  report.toolResultExcerpt = text.slice(0, 500);
  report.requests = mock.requests.map(request => ({
    roles: (request.body?.messages ?? []).map(message => message.role),
    toolNames: (request.body?.tools ?? []).map(tool => tool.name),
    hasToolResult: JSON.stringify(request.body?.messages ?? []).includes('tool_result'),
  }));
  report.stderrTail = stderr.split(/\r?\n/).filter(Boolean).slice(-5);
  report.stdoutTail = stdout.split(/\r?\n/).filter(Boolean).slice(-5);
  report.passed = report.toolVisible && report.toolResultSeen;
} catch (error) {
  report.error = error.message;
} finally {
  await mock.close();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== true) process.exitCode = 1;
}
