/**
 * Agent-loop smoke evidence for T09: run the shipped headless profile against
 * the upstream mock model server three times over one data directory, make the
 * mock call `study_plan` to draft and confirm a plan, then call
 * `study_progress` to read it. Proves both tools are visible to the model, that
 * the headless profile loads the plans module, and that the writes land through
 * the service (change_log actor `agent`, one applied revision, no draft left).
 * Manual run, not part of `node --test`.
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
const plugin = fileURLToPath(new URL('../../../study-core/host/index.mjs', import.meta.url));
const shell = fileURLToPath(new URL('../../../study-outcomes/host/index.mjs', import.meta.url));
const requireFromSource = createRequire(join(source, 'package.json'));
const { startMockLlmServer } = requireFromSource(join(source, 'packages/test-support/llm-mock-server/lib/index.js'));

const root = await mkdtemp(join(tmpdir(), 'study-plans-tool-'));
const home = join(root, 'home');
const dataDir = join(root, 'data');
const databaseFile = join(dataDir, 'study.db');
await mkdir(home, { recursive: true });

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const plan = {
  title: '冒烟计划',
  availability: [{ date: today, minutes: 120 }],
  items: [{ title: '冒烟任务', subject: '数学', estimateMinutes: 60, date: today }],
};
const forward = value => value.replaceAll('\\', '/');
const overlayPath = join(root, 'overlay.yml');

async function writeOverlay(baseUrl) {
  await writeFile(overlayPath, [
    '- id: session-log-deepseek',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: product-analytics',
    '  disabled: true',
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
    '    - id: study-core',
    `      name: ${JSON.stringify(forward(plugin))}`,
    '      config:',
    `        dataDir: ${JSON.stringify(forward(dataDir))}`,
  '    - id: study-facts',
  `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-facts/host/index.mjs', import.meta.url))))}`,
    '    - id: study-learning',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-learning/host/index.mjs', import.meta.url))))}`,
    '    - id: study-reminders',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-reminders/host/index.mjs', import.meta.url))))}`,
  '    - id: study-outcomes',
  `      name: ${JSON.stringify(forward(shell))}`,
    '',
  ].join('\n'));
}

const report = {
  plugin,
  dataDir,
  planDraft: { toolsVisible: false, toolResultSeen: false, draftStored: false },
  planConfirm: { toolsVisible: false, toolResultSeen: false, revisionApplied: false },
  progressRead: { toolsVisible: false, toolResultSeen: false },
  changeActor: null,
  database: null,
  passed: false,
  studyErrors: [],
};

function readDatabase() {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      plan: database.prepare('SELECT id, title, status, revision FROM study_plan').get(),
      draft: database.prepare('SELECT id, revision FROM study_plan_draft').get(),
      revision: database.prepare('SELECT number, action, status, snapshot_json FROM study_plan_revision ORDER BY number DESC LIMIT 1').get(),
      draftCount: Number(database.prepare('SELECT COUNT(*) AS count FROM study_plan_draft').get().count),
      changes: database.prepare("SELECT actor, action FROM change_log WHERE entity = 'plan' ORDER BY id").all(),
      progressRows: Number(database.prepare('SELECT COUNT(*) AS count FROM study_plan_progress').get().count),
    };
  } finally {
    database.close();
  }
}

async function runHeadless({ toolName, toolArguments, successText, prompt, expectText }, runReport) {
  const mock = await startMockLlmServer({
    // The headless profile may issue a title-generation request before the
    // agent turn; repeat the tool call so whichever request carries the tools
    // still gets one. Every write carries an explicit requestId, so repeats
    // replay the first result instead of applying twice.
    sequence: ['tool_call_success', 'tool_call_success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText,
    toolName,
    toolArguments: JSON.stringify(toolArguments),
  });
  try {
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
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    runReport.exit = await Promise.race([exited, delay(180000, undefined, { ref: false }).then(() => {
      spawnSync(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
      return { code: null, signal: 'deadline' };
    })]);

    runReport.toolsVisible = mock.requests.some(request => request.body?.tools?.some(tool => tool.name === 'study_plan') === true
      && request.body?.tools?.some(tool => tool.name === 'study_progress') === true);
    const toolResults = mock.requests
      .flatMap(request => request.body?.messages ?? [])
      .flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_result');
    const text = toolResults
      .flatMap(block => Array.isArray(block.content) ? block.content : [])
      .map(part => typeof part.text === 'string' ? part.text : '')
      .join('\n');
    runReport.toolResultSeen = expectText.every(fragment => text.includes(fragment));
    runReport.toolResultExcerpt = text.slice(0, 800);
    runReport.stderrTail = stderr.split(/\r?\n/).filter(Boolean).slice(-5);
    runReport.stdoutTail = stdout.split(/\r?\n/).filter(Boolean).slice(-5);
    report.studyErrors.push(...stderr.split(/\r?\n/).filter(line => /study|StudyBuddy/i.test(line)).slice(0, 20));
  } finally {
    await mock.close();
  }
}

try {
  await runHeadless({
    toolName: 'study_plan',
    toolArguments: { action: 'draft', baseRevision: 0, expectedDraftRevision: 0, requestId: 'smoke-plan-draft', plan },
    successText: '计划草案已提交。',
    prompt: 'Draft a study plan with the study_plan tool, then confirm it is stored.',
    expectText: ['冒烟计划', 'fits', 'requiresTrial'],
  }, report.planDraft);
  const afterDraft = readDatabase();
  report.planDraft.draftStored = afterDraft.draftCount === 1
    && afterDraft.plan !== undefined
    && Number(afterDraft.plan.revision) === 0
    && afterDraft.changes.some(change => change.actor === 'agent' && change.action === 'draft');

  await runHeadless({
    toolName: 'study_plan',
    toolArguments: {
      action: 'confirm',
      baseRevision: 0,
      expectedDraftRevision: afterDraft.draft === undefined ? 0 : Number(afterDraft.draft.revision),
      requestId: 'smoke-plan-confirm',
    },
    successText: '计划已确认。',
    prompt: 'Confirm the pending study plan draft with the study_plan tool.',
    expectText: ['冒烟任务', 'confirm', '"number": 1'],
  }, report.planConfirm);

  await runHeadless({
    toolName: 'study_progress',
    toolArguments: { action: 'read' },
    successText: '已读取学习进度。',
    prompt: 'Read the current study progress with the study_progress tool.',
    expectText: ['冒烟任务', 'unrecorded', 'itemCount'],
  }, report.progressRead);

  const final = readDatabase();
  report.database = {
    plan: final.plan === undefined ? null : { ...final.plan },
    revision: final.revision === undefined ? null : {
      number: Number(final.revision.number),
      action: String(final.revision.action),
      status: String(final.revision.status),
      hasItem: String(final.revision.snapshot_json).includes('冒烟任务'),
    },
    draftCount: final.draftCount,
    changes: final.changes.map(row => ({ ...row })),
    progressRows: final.progressRows,
  };
  report.planConfirm.revisionApplied = final.plan !== undefined
    && Number(final.plan.revision) === 1
    && final.plan.status === 'active'
    && final.revision !== undefined
    && Number(final.revision.number) === 1
    && final.revision.action === 'confirm'
    && String(final.revision.snapshot_json).includes('冒烟任务')
    && final.draftCount === 0;
  report.changeActor = final.changes.length === 0 ? null : final.changes.map(row => String(row.actor)).join(',');
  report.passed = report.planDraft.toolsVisible
    && report.planDraft.toolResultSeen
    && report.planDraft.draftStored
    && report.planConfirm.toolsVisible
    && report.planConfirm.toolResultSeen
    && report.planConfirm.revisionApplied
    && report.progressRead.toolsVisible
    && report.progressRead.toolResultSeen
    && report.changeActor === 'agent,agent'
    && report.studyErrors.length === 0;
} catch (error) {
  report.error = error.message;
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== true) process.exitCode = 1;
}
