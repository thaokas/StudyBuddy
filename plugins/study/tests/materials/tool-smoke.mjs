/**
 * Agent-loop smoke evidence for T08: run the shipped headless profile against
 * the upstream mock model server, make the mock call `study_materials` with an
 * import, and prove the tool is visible to the model, that it wrote through the
 * service, and that the chunks reached the lexical index. Manual run, not part
 * of `node --test`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const plugin = fileURLToPath(new URL('../../host/index.mjs', import.meta.url));
const requireFromSource = createRequire(join(source, 'package.json'));
const { startMockLlmServer } = requireFromSource(join(source, 'packages/test-support/llm-mock-server/lib/index.js'));

const root = await mkdtemp(join(tmpdir(), 'study-materials-tool-'));
const home = join(root, 'home');
const dataDir = join(root, 'data');
const databaseFile = join(dataDir, 'study.db');
await mkdir(home, { recursive: true });
const mock = await startMockLlmServer({
  sequence: ['tool_call_success', 'success'],
  repeatLast: true,
  successText: '资料已导入。',
  toolName: 'study_materials',
  toolArguments: JSON.stringify({
    action: 'import_text',
    kind: 'notes',
    title: '冒烟笔记',
    text: '极限的定义：函数值无限接近某个常数。',
  }),
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
  '    - id: study',
  `      name: ${JSON.stringify(forward(plugin))}`,
  '      config:',
  `        dataDir: ${JSON.stringify(forward(dataDir))}`,
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

const report = {
  plugin,
  dataDir,
  mockBaseUrl: mock.baseURL,
  toolVisible: false,
  toolResultSeen: false,
  materialStored: false,
  chunkIndexed: false,
  changeActor: null,
  database: null,
  passed: false,
  studyErrors: [],
};
try {
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    '--profile', 'headless', '--patch', overlayPath,
    'Import the student note with the study_materials tool, then confirm it is stored.',
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

  const firstRequest = mock.requests[0]?.body;
  report.toolVisible = firstRequest?.tools?.some(tool => tool.name === 'study_materials') === true;
  const toolResults = mock.requests
    .flatMap(request => request.body?.messages ?? [])
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result');
  const text = JSON.stringify(toolResults);
  report.toolResultSeen = text.includes('冒烟笔记') && text.includes('chunkCount') && text.includes('mat_');
  report.toolResultExcerpt = text.slice(0, 600);

  if (report.toolResultSeen) {
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const material = database.prepare('SELECT id, title, kind, source_kind, source_date, verification FROM study_material').get();
      const chunk = database.prepare('SELECT COUNT(*) AS count, SUM(page IS NULL) AS unknown_pages FROM study_material_chunk').get();
      const indexed = database.prepare('SELECT COUNT(*) AS count FROM study_material_fts WHERE study_material_fts MATCH ?').get('"极限"');
      const change = database.prepare("SELECT actor, entity, action FROM change_log WHERE entity = 'material'").get();
      report.database = {
        material: material === undefined ? null : { ...material },
        chunks: chunk === undefined ? null : { ...chunk },
        indexedHits: indexed === undefined ? null : Number(indexed.count),
        change: change === undefined ? null : { ...change },
      };
      report.materialStored = material !== undefined && material.title === '冒烟笔记';
      report.chunkIndexed = Number(indexed?.count ?? 0) > 0;
      report.changeActor = change === undefined ? null : change.actor;
    } finally {
      database.close();
    }
  }
  report.stderrTail = stderr.split(/\r?\n/).filter(Boolean).slice(-5);
  report.stdoutTail = stdout.split(/\r?\n/).filter(Boolean).slice(-5);
  report.studyErrors = stderr.split(/\r?\n/).filter(line => /study|StudyBuddy/i.test(line)).slice(0, 20);
  report.passed = report.toolVisible
    && report.toolResultSeen
    && report.materialStored
    && report.chunkIndexed
    && report.changeActor === 'agent'
    && report.studyErrors.length === 0;
} catch (error) {
  report.error = error.message;
} finally {
  await mock.close();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== true) process.exitCode = 1;
}
