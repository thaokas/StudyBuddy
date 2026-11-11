/**
 * Real-composition smoke evidence for T11: the shipped headless profile, the
 * upstream mock model, and a real DSH Agent call `study_tutoring` on one task.
 * The second model request must carry the injected `study-tutoring` context,
 * the session log must contain its producer-owned source kind, and a later
 * free-chat session must add no injection.
 *
 * Manual run, not part of `node --test`:
 *   node plugins/study/tests/tutoring/tool-smoke.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { boot, createMaterial, createPlan, createTask } from './helpers.mjs';

const source = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const plugin = fileURLToPath(new URL('../../host/index.mjs', import.meta.url));
const requireFromSource = createRequire(join(source, 'package.json'));
const { startMockLlmServer } = requireFromSource(join(source, 'packages/test-support/llm-mock-server/lib/index.js'));

const root = await mkdtemp(join(tmpdir(), 'study-tutoring-smoke-'));
const home = join(root, 'home');
const dataDir = join(root, 'data');
const databaseFile = join(dataDir, 'study.db');
const overlayPath = join(root, 'overlay.yml');
await mkdir(home, { recursive: true });
await mkdir(dataDir, { recursive: true });

const report = {
  plugin,
  dataDir,
  taskId: null,
  toolVisible: false,
  toolResultSeen: false,
  injectedMessageSeen: false,
  injectedFactsSeen: false,
  sessionSourceKindCount: 0,
  freeChatAddedInjection: null,
  exit: null,
  freeExit: null,
  database: null,
  stderrTail: [],
  passed: false,
};

/** Forward a Windows path into YAML as a JSON string. */
const forward = value => value.replaceAll('\\', '/');

/** Write the overlay that points the headless profile at one mock server. */
async function writeOverlay(baseUrl) {
  await writeFile(overlayPath, [
    '- id: session-log-deepseek',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: product-analytics',
    '  disabled: true',
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    compression: none',
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${JSON.stringify(`${baseUrl}/v1`)}`,
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
}

/** Run one headless prompt against one mock server. */
async function runHeadless(mock, prompt) {
  await writeOverlay(mock.baseURL);
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
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    '--profile', 'headless', '--patch', overlayPath, prompt,
  ], { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const result = await Promise.race([exited, delay(180000, undefined, { ref: false }).then(() => {
    spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    return { code: null, signal: 'deadline' };
  })]);
  return {
    ...result,
    stderrTail: stderr.split(/\r?\n/).filter(Boolean).slice(-8),
  };
}

/** Read one value from the study database. */
function readDatabase(file = databaseFile) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const link = database.prepare('SELECT session_id, task_id, digest, injected_at FROM study_tutoring_link').get();
    const changes = database.prepare("SELECT actor, action FROM change_log WHERE entity = 'tutoring_link' ORDER BY id").all();
    const tasks = database.prepare('SELECT id, title FROM study_task').all();
    return {
      link: link === undefined ? null : { ...link },
      changes: changes.map(row => ({ ...row })),
      tasks: tasks.map(row => ({ ...row })),
    };
  } finally {
    database.close();
  }
}

/** Find every study.db under one directory. */
async function findStudyDatabases(directory) {
  const found = [];
  for (const file of await filesUnder(directory).catch(() => [])) {
    if (file.endsWith('study.db')) found.push(file);
  }
  return found;
}

/** Recursively list files under one directory. */
async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

/**
 * Count occurrences of the tutoring source kind in every plaintext session log.
 * @param {string} directory - Session root.
 * @returns {Promise<number>} Number of occurrences.
 */
async function countSourceKind(directory) {
  let count = 0;
  let files;
  try {
    files = await filesUnder(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const text = await readFile(file, 'utf8').catch(() => '');
    count += (text.match(/"source":\s*\{\s*"kind":"study-tutoring"/g) ?? []).length;
  }
  return count;
}

/**
 * Extract the model-visible user messages of one request body.
 * @param {object} body - Mock LLM request body.
 * @returns {string[]} Text blocks of user-role messages, oldest first.
 */
function userTexts(body) {
  return (body?.messages ?? [])
    .filter(message => message.role === 'user')
    .flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .map(part => (typeof part.text === 'string' ? part.text : ''));
}

try {
  const seeded = await boot({ after() {} }, { directory: dataDir, cleanup: false });
  const material = await createMaterial(seeded);
  const task = await createTask(seeded, { materialRef: material.id });
  await createPlan(seeded);
  report.taskId = task.id;
  report.seedDatabase = readDatabase();
  await seeded.fiber.dispose();
  report.databasesAfterSeed = await findStudyDatabases(root);

  const firstMock = await startMockLlmServer({
    // A title request may precede the tool request; repeat so the first
    // tools-bearing request still returns the tool call.
    sequence: ['tool_call_success', 'tool_call_success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: '已按任务上下文讲解。',
    toolName: 'study_tutoring',
    toolArguments: JSON.stringify({ action: 'open', taskId: task.id }),
  });
  try {
    report.exit = await runHeadless(firstMock, 'Open the task context with study_tutoring, then explain the first exercise.');
    report.toolVisible = firstMock.requests.some(request => request.body?.tools?.some(tool => tool.name === 'study_tutoring') === true);
    const toolResults = firstMock.requests
      .flatMap(request => request.body?.messages ?? [])
      .flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_result');
    report.toolResultSeen = JSON.stringify(toolResults).includes('已带入') || JSON.stringify(toolResults).includes('injected');
    report.toolResultExcerpt = JSON.stringify(toolResults).slice(0, 1200);
    report.requests = firstMock.requests.map(request => ({
      roles: (request.body?.messages ?? []).map(message => message.role),
      toolNames: (request.body?.tools ?? []).map(tool => tool.name),
      hasToolResult: JSON.stringify(request.body?.messages ?? []).includes('tool_result'),
      hasStudyTutoringCall: JSON.stringify(request.body?.messages ?? []).includes('study_tutoring'),
    }));
    const texts = firstMock.requests.flatMap(request => userTexts(request.body))
      .filter(text => text.includes('【任务答疑上下文'));
    report.injectedMessageSeen = texts.length >= 1;
    report.injectedRequestCount = texts.length;
    const injected = texts[0] ?? '';
    report.injectedFactsSeen = injected.includes(task.title)
      && injected.includes('第一题：求 x^2 的导数')
      && injected.includes('19:00–19:30');
    report.injectedExcerpt = injected.slice(0, 500);
    report.stderrTail = report.exit.stderrTail;
  } finally {
    await firstMock.close();
  }

  const beforeFree = await countSourceKind(join(home, 'sessions'));
  report.sourceKindAfterFirst = beforeFree;
  report.databasesAfterFirst = await findStudyDatabases(root);
  const freeMock = await startMockLlmServer({ sequence: ['success'], repeatLast: true, successText: '你好，需要什么帮助？' });
  try {
    report.freeExit = await runHeadless(freeMock, 'Say hello without opening any task.');
  } finally {
    await freeMock.close();
  }
  const afterFree = await countSourceKind(join(home, 'sessions'));
  report.sessionSourceKindCount = afterFree;
  report.freeChatAddedInjection = afterFree !== beforeFree;
  // One injection is recorded twice: the durable inbox splice and the admitted
  // user/message that the model sees. A duplicate injection would add two more.
  report.injectionRecordsOk = beforeFree >= 2;
  try {
    report.sessionFiles = (await filesUnder(join(home, 'sessions'))).map(file => file.slice(home.length));
  } catch (error) {
    report.sessionFiles = error.code;
  }
  report.database = readDatabase();
  report.databaseOk = report.database.link !== null
    && report.database.link.task_id === task.id
    && report.database.link.injected_at !== null
    && report.database.changes.length === 1
    && report.database.changes[0].actor === 'agent'
    && report.database.changes[0].action === 'inject';
  report.passed = report.toolVisible
    && report.toolResultSeen
    && report.injectedMessageSeen
    && report.injectedFactsSeen
    && report.injectionRecordsOk === true
    && report.freeChatAddedInjection === false
    && report.databaseOk === true
    && report.exit.code === 0
    && report.freeExit.code === 0;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.errorStack = error instanceof Error ? error.stack : undefined;
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const evidence = fileURLToPath(new URL('./evidence/tool-smoke.json', import.meta.url));
  await mkdir(dirname(evidence), { recursive: true });
  await writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== true) process.exitCode = 1;
}
