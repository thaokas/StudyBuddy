/**
 * Agent-loop smoke evidence for T20: run the shipped headless profile with the
 * study plugin, save a Chinese preference through `memory_remember`, start a
 * new process and prove the preference reaches the next conversation, then
 * recall, delete, and retry the deleted content. Manual run, not part of
 * `node --test`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const plugin = fileURLToPath(new URL('../../../study-core/host/index.mjs', import.meta.url));
const shell = fileURLToPath(new URL('../../../study-outcomes/host/index.mjs', import.meta.url));
const memory = fileURLToPath(new URL('../../host/index.mjs', import.meta.url));
const requireFromSource = createRequire(join(source, 'package.json'));
const { startMockLlmServer } = requireFromSource(join(source, 'packages/test-support/llm-mock-server/lib/index.js'));

const PREFERENCE = '我更喜欢在上午学习数学。';
const root = await mkdtemp(join(tmpdir(), 'study-memory-smoke-'));
const home = join(root, 'home');
const dataDir = join(root, 'data');
await mkdir(home, { recursive: true });
const overlayPath = join(root, 'overlay.yml');
const forward = value => value.replaceAll('\\', '/');
const databaseFile = join(dataDir, 'study.db');

/** Read the SQLite tables the tool just wrote; an unopened database returns no rows. */
function readRows(sql, ...params) {
  let database;
  try {
    database = new DatabaseSync(databaseFile);
    return database.prepare(sql).all(...params).map(row => ({ ...row }));
  } catch {
    return [];
  } finally {
    try { database?.close(); } catch { /* The read result is the reportable outcome. */ }
  }
}

async function runStep({ id, prompt, toolName, toolArguments, successText }) {
  const mock = await startMockLlmServer({
    sequence: toolName === undefined ? ['success'] : ['tool_call_success', 'success'],
    repeatLast: true,
    successText,
    ...(toolName === undefined ? {} : { toolName, toolArguments }),
  });
  await writeFile(overlayPath, [
    '- id: session-log-deepseek', '  disabled: true',
    '- id: session-telemetry-otel', '  disabled: true',
    '- id: product-analytics', '  disabled: true',
    '- id: session-title-first-prompt-llm', '  disabled: true',
    '- id: session-title-all-prompts-llm', '  disabled: true',
    '- id: session-title-llm', '  disabled: true',
    '- id: llm-deepseek', '  config:',
    `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`,
    '    maxTokens: 1024', '    thinking: disabled', '    models:',
    '      - id: deepseek-flash', '        name: StudyBuddy smoke model', '        inputModalities: [text]',
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
  "    - id: study-memory",
  `      name: ${JSON.stringify(forward(memory))}`,
    '',
  ].join('\n'));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^DSH_|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|^ELECTRON_/i.test(name)) delete env[name];
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(root, 'agents'),
    DEEPSEEK_API_KEY: 'study-memory-smoke-fake-key',
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
  const exit = await Promise.race([exited, delay(120000, undefined, { ref: false }).then(() => {
    spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    return { code: null, signal: 'deadline' };
  })]);
  const requests = mock.requests;
  await mock.close();
  const toolResults = requests
    .flatMap(request => request.body?.messages ?? [])
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result')
    .map(block => typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
    .join('\n');
  const conversation = requests.map(request => JSON.stringify(request.body ?? {})).join('\n');
  return {
    id,
    exit,
    requestCount: requests.length,
    requests: requests.map(request => ({
      roles: (request.body?.messages ?? []).map(message => message.role),
      hasToolResult: JSON.stringify(request.body?.messages ?? []).includes('tool_result'),
      hasToolUse: JSON.stringify(request.body?.messages ?? []).includes('tool_use'),
    })),
    toolResults,
    conversation,
    stderrTail: stderr.split(/\r?\n/).filter(Boolean).slice(-6),
  };
}

const report = { plugin, dataDir, steps: [], assertions: {}, passed: false };
try {
  const saved = await runStep({
    id: 'remember',
    prompt: '记住：我更喜欢在上午学习数学。',
    toolName: 'memory_remember',
    toolArguments: JSON.stringify({ text: PREFERENCE, kind: 'preference', requestId: 'smoke-remember' }),
    successText: '好的，我记住了。',
  });
  report.steps.push(saved);
  const idMatch = /mem_[a-f0-9]{12}/.exec(saved.toolResults);
  const remembered = readRows("SELECT id, kind, text, status, source_kind FROM study_memory_item WHERE kind = 'preference' ORDER BY rowid DESC LIMIT 1");
  report.memoryId = idMatch?.[0] ?? remembered[0]?.id ?? null;
  report.tableRemembered = remembered[0] === undefined ? null : remembered[0];

  const recalledInNewSession = await runStep({
    id: 'new-session',
    prompt: '我的学习偏好是什么？',
    successText: '你更喜欢在上午学习数学。',
  });
  report.steps.push(recalledInNewSession);
  const recalled = await runStep({
    id: 'recall-tool',
    prompt: '用记忆工具确认一下我的学习时间偏好。',
    toolName: 'memory_recall',
    toolArguments: JSON.stringify({ query: '上午学习数学' }),
    successText: '已确认。',
  });
  report.steps.push(recalled);
  const deleted = await runStep({
    id: 'forget',
    prompt: '忘掉我的学习时间偏好。',
    toolName: 'memory_forget',
    toolArguments: JSON.stringify({ id: report.memoryId ?? 'mem_000000000000', requestId: 'smoke-forget' }),
    successText: '已删除。',
  });
  report.steps.push(deleted);
  report.tableAfterDelete = {
    items: readRows('SELECT id, kind, text FROM study_memory_item'),
    tombstones: readRows('SELECT id, content_hash, goal_id FROM study_memory_tombstone'),
  };

  const afterDelete = await runStep({
    id: 'after-delete',
    prompt: '我的学习偏好是什么？',
    successText: '我没有找到这条记忆。',
  });
  report.steps.push(afterDelete);

  const rebuilt = await runStep({
    id: 'rebuild-attempt',
    prompt: '旧对话里提到我更喜欢在上午学习数学，再记一遍。',
    toolName: 'memory_remember',
    toolArguments: JSON.stringify({ text: PREFERENCE, kind: 'preference', requestId: 'smoke-rebuild' }),
    successText: '这条没有重新写入。',
  });
  report.steps.push(rebuilt);
  report.tableAfterRebuild = readRows('SELECT id, kind, text FROM study_memory_item');
  const afterRebuild = await runStep({
    id: 'after-rebuild',
    prompt: '我的学习偏好是什么？',
    successText: '我没有找到这条记忆。',
  });
  report.steps.push(afterRebuild);

  report.assertions = {
    toolCallsSucceeded: [saved, recalled, deleted].every(step => step.exit.code === 0 && step.toolResults.includes('mem_')),
    saveWrotePreference: saved.toolResults.includes('已记住') || saved.toolResults.includes(PREFERENCE),
    newSessionInjectsPreference: recalledInNewSession.conversation.includes(PREFERENCE),
    recallToolFindsPreference: recalled.toolResults.includes(PREFERENCE),
    forgetSucceeded: deleted.toolResults.includes('已删除') || deleted.toolResults.includes('删除'),
    deletedNotInjectedAfterRestart: !afterDelete.conversation.includes(PREFERENCE),
    rebuildSuppressed: rebuilt.toolResults.includes('未写入'),
    notInjectedAfterRebuild: !afterRebuild.conversation.includes(PREFERENCE),
    tableRemembered: report.tableRemembered?.text === PREFERENCE
      && report.tableRemembered?.kind === 'preference'
      && report.tableRemembered?.status === 'active'
      && report.tableRemembered?.source_kind === 'explicit',
    tableItemDeleted: report.tableAfterDelete.items.length === 0,
    tableTombstoneWritten: report.tableAfterDelete.tombstones.length === 1,
    tableNotRebuilt: report.tableAfterRebuild.length === 0,
  };
  report.passed = Object.values(report.assertions).every(Boolean);
} catch (error) {
  report.error = error.message;
} finally {
  await rm(root, { recursive: true, force: true });
  const output = JSON.stringify({
    assertions: report.assertions,
    passed: report.passed,
    memoryId: report.memoryId,
    tableRemembered: report.tableRemembered,
    tableAfterDelete: report.tableAfterDelete,
    tableAfterRebuild: report.tableAfterRebuild,
    error: report.error,
    steps: report.steps.map(step => ({
      id: step.id,
      exit: step.exit,
      requestCount: step.requestCount,
      requests: step.requests,
      resultExcerpt: step.toolResults.slice(0, 300),
      stderrTail: step.stderrTail,
    })),
  }, null, 2);
  if (typeof process.env.STUDYBUDDY_T20_EVIDENCE === 'string' && process.env.STUDYBUDDY_T20_EVIDENCE.length > 0) {
    await writeFile(process.env.STUDYBUDDY_T20_EVIDENCE, `${output}\n`);
  }
  console.log(output);
  if (report.passed !== true) process.exitCode = 1;
}
