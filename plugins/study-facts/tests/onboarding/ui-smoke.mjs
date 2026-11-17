/**
 * Browser smoke for the T10 pages.
 *
 * The unit tests prove every rendered state from fixtures; this script proves
 * the two pages load in the real shell:
 *
 * 1. Build the client bundle and boot the shipped DSH Web profile with the
 *    study plugin.
 * 2. Open the "Create plan" page, fill the goal and reach the brief step,
 *    check the assistant handoff and the manual path, then skip and restart.
 * 3. Seed a goal, a material and one confirmed plan through the authenticated
 *    study routes.
 * 4. Refresh the setup page and see the confirmed revision.
 * 5. Open the Plan page, verify the stage/week goals, the task and the missing
 *    information, then click the material source open.
 *
 * Screenshots and the JSON report land in `tests/onboarding/evidence/`.
 * Run: `node plugins/study-outcomes/tests/onboarding/ui-smoke.mjs [--keep]`
 * Needs Edge and host processes, so it is not part of `node --test`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SOURCE = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EVIDENCE = fileURLToPath(new URL('./evidence/', import.meta.url));
const BUILD_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'build-client.mjs');
const HOST_ENTRY = fileURLToPath(new URL('../../../study-outcomes/host/index.mjs', import.meta.url));
const CORE_ROOT = fileURLToPath(new URL('../../../study-core/', import.meta.url));
const CORE_ENTRY = join(CORE_ROOT, 'host', 'index.mjs');
const READINESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;

const report = { started: new Date().toISOString(), checks: {}, screenshots: [], passed: false };
const hosts = [];
const browsers = [];

const forward = value => value.replaceAll('\\', '/');

/** The host's local calendar date, used for a week goal anchor. */
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Import Playwright from the pinned source checkout's store. */
function loadPlaywright() {
  const bases = [
    join(SOURCE, 'node_modules', '.pnpm', 'node_modules', 'playwright'),
    join(SOURCE, 'node_modules', 'playwright'),
  ];
  const failures = [];
  for (const base of bases) {
    try {
      return createRequire(join(SOURCE, 'package.json'))(base);
    } catch (error) {
      failures.push(`${base} (${error.code ?? error.message})`);
    }
  }
  throw new Error(`cannot find playwright; tried:\n  ${failures.join('\n  ')}`);
}

/** Build the client bundle and fail with esbuild's own message when it does not. */
async function build() {
  const core = spawnSync(process.execPath, [join(CORE_ROOT, 'scripts', 'build-client.mjs')], { cwd: CORE_ROOT, encoding: 'utf8', timeout: 120000 });
  if (core.status !== 0) throw new Error(`Core client build failed: ${core.stderr || core.stdout}`);
  const result = spawnSync(process.execPath, [BUILD_SCRIPT], { cwd: PLUGIN_ROOT, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) {
    throw new Error(`client build failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  const summary = JSON.parse(result.stdout);
  return { bytes: summary.bytes, pages: summary.pages, messages: summary.messages };
}

/** Write the profile overlay for one host run. */
async function writeOverlay({ root, disabledFacts = false }) {
  const lines = [
    '- id: session-log-deepseek',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: product-analytics',
    '  disabled: true',
    '- insert:',
    '    - id: study-core',
    `      name: ${JSON.stringify(forward(CORE_ENTRY))}`,
    '      config:',
    `        dataDir: ${JSON.stringify(forward(join(root, 'data')))}`,
    '    - id: study-facts',
    `      disabled: ${disabledFacts}`,
  `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-facts/host/index.mjs', import.meta.url))))}`,
    '    - id: study-learning',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-learning/host/index.mjs', import.meta.url))))}`,
    '    - id: study-reminders',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-reminders/host/index.mjs', import.meta.url))))}`,
  '    - id: study-outcomes',
    `      name: ${JSON.stringify(forward(HOST_ENTRY))}`,
    '    - id: study-memory',
    `      name: ${JSON.stringify(forward(fileURLToPath(new URL('../../../study-memory/host/index.mjs', import.meta.url))))}`,
  ];
  const file = join(root, 'overlay.yml');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/** Boot one isolated DSH Web host with the study overlay. */
async function startHost({ root, disabledFacts = false }) {
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  const patch = await writeOverlay({ root, disabledFacts });
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(DSH_|ELECTRON_)/i.test(name)) delete env[name];
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    DSH_HOME: join(root, 'home'),
    DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
  });
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    'web', '--patch', patch, '--no-open', '--port', '0',
  ], { cwd: SOURCE, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const stop = async () => {
    if (child.exitCode === null) {
      spawnSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    }
    await Promise.race([exited, delay(15000, undefined, { ref: false })]);
    await writeFile(join(root, 'host.stdout.log'), stdout);
    await writeFile(join(root, 'host.stderr.log'), stderr);
  };
  const host = { url: undefined, origin: undefined, stderr: () => stderr, stop };
  hosts.push(host);
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`host exited before ready (${child.exitCode}):\n${stderr.slice(-4000)}`);
    const match = stdout.match(READINESS);
    if (match !== null) {
      host.url = match[0];
      host.origin = new URL(match[0]).origin;
      return host;
    }
    await delay(250);
  }
  await stop();
  throw new Error(`host did not report a ready URL within 240s:\n${stderr.slice(-4000)}`);
}

/** Exchange the launch token for the browser cookie, then call one study route. */
async function callRoute(url, route, body = {}) {
  const index = await fetch(url, { redirect: 'manual' });
  const setCookie = index.headers.getSetCookie?.()[0] ?? index.headers.get('set-cookie');
  if (typeof setCookie !== 'string' || setCookie.length === 0) throw new Error(`no cookie on the first response (HTTP ${index.status})`);
  const cookie = setCookie.split(';', 1)[0];
  // Writes require an idempotency identity; the route strips it for reads.
  const payload = { requestId: body.requestId ?? randomUUID(), ...body };
  const response = await fetch(`${new URL(url).origin}${route}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, envelope: await response.json().catch(() => null) };
}

/** Button labels of the first-run chain, in dismissal order. */
const FIRST_RUN_BUTTONS = Object.freeze([
  /^(继续|Continue)$/,
  /^(稍后配置|Configure later)$/,
  /^(添加 API Key|Add API Key)$/,
  /^(关闭|Close)$/,
]);

/** Close one blocking first-run surface. */
async function dismissOne(page) {
  for (const name of FIRST_RUN_BUTTONS) {
    const button = page.getByRole('button', { name });
    if (await button.count() === 0) continue;
    await button.first().click({ timeout: 8000 }).catch(() => {});
    return true;
  }
  return false;
}

/** Clear the first-run chrome the way a student would. */
async function settleFirstRun(page) {
  const blocked = async () => {
    if (await page.locator('[role="dialog"]').count() > 0) return true;
    return await page.evaluate(() => [...document.querySelectorAll('[aria-hidden="true"]')]
      .some(node => (node.getAttribute('class') ?? '').includes('mask') && node.getBoundingClientRect().width > 0));
  };
  const deadline = Date.now() + 60000;
  let calm = 0;
  while (Date.now() < deadline) {
    if (await blocked()) {
      calm = 0;
      const clicked = await dismissOne(page);
      if (!clicked) await page.keyboard.press('Escape').catch(() => {});
      await delay(clicked ? 700 : 400);
      continue;
    }
    calm += 1;
    if (calm >= 3) return;
    await delay(1000);
  }
  throw new Error('the first-run dialogs did not close');
}

const workRoot = await mkdtemp(join(tmpdir(), 'study-onboarding-'));
try {
  await mkdir(EVIDENCE, { recursive: true });
  const playwright = loadPlaywright();
  report.checks.build = await build();
  assert.ok(report.checks.build.pages.includes('onboarding'), 'bundle should include the onboarding page');
  assert.ok(report.checks.build.pages.includes('plan'), 'bundle should include the plan page');

  const host = await startHost({ root: join(workRoot, 'enabled') });

  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  browsers.push(browser);
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(host.url);
  await settleFirstRun(page);

  // 1. First-run setup: goal → materials → brief, then skip and restart.
  await page.getByRole('button', { name: '创建计划', exact: true }).click();
  const setup = page.getByTestId('study-onboarding');
  await setup.waitFor({ timeout: 30000 });
  await page.locator('[data-testid="study-onboarding"][data-step="goal"]').waitFor({ timeout: 30000 });
  const onboarding = {
    title: await setup.locator('h1').innerText(),
    goalForm: await page.getByTestId('onboarding-goal-form').count(),
    stepLinks: await page.getByTestId('onboarding-steps').innerText(),
  };
  assert.equal(onboarding.title, '创建学习计划');
  assert.equal(onboarding.goalForm, 1);
  assert.match(onboarding.stepLinks, /目标/);
  assert.match(onboarding.stepLinks, /计划需求/);
  await page.screenshot({ path: join(EVIDENCE, 'onboarding-goal.png') });
  report.screenshots.push('onboarding-goal.png');

  // Fill the minimum and reach the brief step: it hands off to the assistant.
  await page.getByTestId('onboarding-goal-form').locator('input[name="exam"]').fill('考研数学一');
  await page.getByTestId('onboarding-goal-save').click();
  await page.locator('[data-testid="study-onboarding"][data-step="materials"]').waitFor({ timeout: 15000 });
  await page.getByTestId('onboarding-materials-continue').click();
  await page.locator('[data-testid="study-onboarding"][data-step="brief"]').waitFor({ timeout: 15000 });
  onboarding.briefText = await page.getByTestId('study-onboarding').innerText();
  assert.match(onboarding.briefText, /让助手开始规划/);
  assert.match(onboarding.briefText, /不用助手，自己写草案/);
  assert.match(onboarding.briefText, /确认之前不会改变正式安排/);
  assert.equal(await page.getByTestId('onboarding-brief-start').count(), 1);
  assert.equal(await page.getByTestId('onboarding-brief-summary-materials').count(), 1);
  await page.screenshot({ path: join(EVIDENCE, 'onboarding-brief.png') });
  report.screenshots.push('onboarding-brief.png');

  await page.getByTestId('onboarding-brief-skip').click();
  await page.locator('[data-testid="study-onboarding"][data-step="skipped"]').waitFor({ timeout: 15000 });
  onboarding.skippedText = await page.getByTestId('study-onboarding').innerText();
  assert.match(onboarding.skippedText, /已暂不创建/);
  assert.match(onboarding.skippedText, /不需要模型或网络/);
  assert.match(onboarding.skippedText, /不会创建目标、草案或正式计划/);

  await page.getByTestId('onboarding-restart').click();
  await page.locator('[data-testid="study-onboarding"][data-step="goal"]').waitFor({ timeout: 15000 });
  assert.equal(await page.getByTestId('onboarding-goal-form').count(), 1);
  report.checks.onboarding = onboarding;

  // 2. Seed a formal plan through the same authenticated routes the pages
  // call; refreshing the setup page picks it up.
  const goal = await callRoute(host.url, '/api/study/materials/saveGoal', {
    exam: '考研数学一',
    examYear: 2027,
    deadline: '2027-12-20',
    dailyMinutes: 120,
  });
  assert.equal(goal.envelope?.ok, true, `saveGoal: ${JSON.stringify(goal.envelope)}`);
  const material = await callRoute(host.url, '/api/study/materials/importText', {
    kind: 'workbook',
    title: '数学练习册',
    text: '第二章 导数\n第一题：求导。\n第二题：求导。',
  });
  assert.equal(material.envelope?.ok, true, `importText: ${JSON.stringify(material.envelope)}`);
  const materialId = material.envelope.value.material.id;
  const draft = await callRoute(host.url, '/api/study/plans/saveDraft', {
    title: '2027 考研数学计划',
    goalId: goal.envelope.value.goal.id,
    baseRevision: 0,
    expectedDraftRevision: 0,
    projects: [
      { id: 'proj_chapter', title: '章节学习', kind: 'chapter', materialId, target: '过完第二章' },
      { id: 'proj_workbook', title: '练习册', kind: 'workbook' },
    ],
    stageGoals: [{ title: '完成高数强化', target: '全书两轮' }],
    weekGoals: [{ weekStart: localToday(), title: '第二章', target: '习题 1-20' }],
    items: [{
      title: '第二章 导数习题',
      projectId: 'proj_chapter',
      materialId,
      locator: { chapter: '第二章', unverified: ['page'] },
      estimateMinutes: 30,
      date: localToday(),
      flexible: true,
    }, {
      title: '练习册第一章 1-10 题',
      projectId: 'proj_workbook',
      estimateMinutes: 40,
      date: null,
      flexible: true,
    }],
  });
  assert.equal(draft.envelope?.ok, true, `saveDraft: ${JSON.stringify(draft.envelope)}`);
  const planId = draft.envelope.value.plan.id;
  const confirmed = await callRoute(host.url, '/api/study/plans/confirm', {
    planId,
    baseRevision: 0,
    draftId: draft.envelope.value.draft.id,
    expectedDraftRevision: draft.envelope.value.draft.draftRevision,
  });
  assert.equal(confirmed.envelope?.ok, true, `confirm: ${JSON.stringify(confirmed.envelope)}`);
  assert.equal(confirmed.envelope.value.plan.revision, 1);
  report.checks.seeded = {
    goalId: goal.envelope.value.goal.id,
    materialId,
    planId,
    revision: confirmed.envelope.value.plan.revision,
    itemId: confirmed.envelope.value.revision.data.items[0].id,
  };

  await page.getByTestId('onboarding-refresh').click();
  await page.locator('[data-testid="study-onboarding"][data-step="done"]').waitFor({ timeout: 30000 });
  const doneText = await page.getByTestId('study-onboarding').innerText();
  assert.match(doneText, /计划已就位/);
  assert.match(doneText, /正式修订 1/);
  await page.screenshot({ path: join(EVIDENCE, 'onboarding-done.png') });
  report.screenshots.push('onboarding-done.png');

  // 3. Plan page: goals, task, missing information, clickable material source.
  await page.getByRole('button', { name: '计划', exact: true }).click();
  const plan = page.getByTestId('study-plan');
  await plan.waitFor({ timeout: 30000 });
  await page.locator('[data-testid="study-plan"][data-revision="1"]').waitFor({ timeout: 30000 });
  const planText = await plan.innerText();
  const planChecks = {
    title: await page.getByTestId('plan-summary').locator('h2').innerText(),
    revision: await page.getByTestId('plan-revision').innerText(),
    goalText: await page.getByTestId('plan-stage-goals').innerText(),
    weekText: await page.getByTestId('plan-week-goals').innerText(),
    hasTask: planText.includes('第二章 导数习题'),
    hasProjects: planText.includes('章节学习') && planText.includes('练习册'),
    projectCount: await page.getByTestId('plan-counts-projects').innerText(),
    hasMissing: planText.includes('缺失信息'),
    hasUnscheduled: planText.includes('1 项没有安排日期'),
    hasUnverified: planText.includes('1 项的材料定位未核实'),
    undoEnabled: await page.getByTestId('plan-undo').isEnabled(),
  };
  assert.equal(planChecks.title, '2027 考研数学计划');
  assert.match(planChecks.revision, /正式修订 1/);
  assert.match(planChecks.goalText, /完成高数强化/);
  assert.match(planChecks.weekText, /第二章/);
  assert.equal(planChecks.hasTask, true);
  assert.equal(planChecks.hasProjects, true);
  assert.equal(planChecks.projectCount, '2 个项目');
  assert.equal(planChecks.hasMissing, true);
  assert.equal(planChecks.hasUnscheduled, true);
  assert.equal(planChecks.hasUnverified, true);
  assert.equal(planChecks.undoEnabled, true);
  report.checks.plan = planChecks;

  // The detailed window is the primary reading surface, so its citation is the
  // one a student opens first; the project view keeps its own folded copy.
  const source = plan.locator('[data-testid^="plan-window-item-source-"]').first();
  await source.waitFor({ timeout: 15000 });
  const summaryText = await source.locator('summary').innerText();
  await source.locator('summary').click();
  assert.equal(await source.evaluate(node => node.open === true), true, 'clicking the citation summary should open it');
  const sourceText = await source.innerText();
  assert.match(summaryText, /数学练习册/);
  assert.match(sourceText, /类型：workbook/);
  assert.match(sourceText, /未核实/);
  assert.match(sourceText, /第二章/);
  report.checks.source = { summary: summaryText, opened: true };
  await page.screenshot({ path: join(EVIDENCE, 'plan.png') });
  report.screenshots.push('plan.png');

  // 4. Workbench: the task the plan assigned to today appears in its own group
  // and opens a time block, so "date in the plan, clock time in the workbench"
  // is wired end to end through the real routes.
  await page.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByTestId('study-workbench').waitFor({ timeout: 30000 });
  const planGroup = page.getByTestId('workbench-plan');
  await planGroup.waitFor({ timeout: 15000 });
  const planGroupText = await planGroup.innerText();
  assert.match(planGroupText, /今日计划/);
  assert.match(planGroupText, /第二章 导数习题/);
  assert.match(planGroupText, /项目：章节学习/);
  report.checks.workbench = { planGroup: planGroupText.split('\n').slice(0, 8), blockFormOpened: false };
  await page.screenshot({ path: join(EVIDENCE, 'workbench-plan.png') });
  report.screenshots.push('workbench-plan.png');
  await planGroup.getByRole('button', { name: '安排时间' }).first().click();
  const blockForm = page.getByTestId('workbench-block-form');
  await blockForm.waitFor({ timeout: 15000 });
  assert.match(await blockForm.innerText(), /第二章 导数习题/);
  report.checks.workbench.blockFormOpened = true;
  await page.screenshot({ path: join(EVIDENCE, 'workbench-block.png') });
  report.screenshots.push('workbench-block.png');

  // P3: verify the fourth migrated page and its live host connection.
  await page.getByRole('button', { name: '番茄钟', exact: true }).click();
  await page.getByTestId('study-timer').waitFor({ timeout: 30000 });
  await page.getByTestId('timer-start').waitFor({ timeout: 15000 });
  await page.getByTestId('timer-start').click();
  await page.getByTestId('timer-session').waitFor({ timeout: 15000 });
  report.checks.timer = { started: true, phase: await page.getByTestId('timer-phase').innerText() };
  await page.screenshot({ path: join(EVIDENCE, 'timer.png') });
  report.screenshots.push('timer.png');

  planChecks.pageErrors = pageErrors;
  planChecks.consoleErrors = consoleErrors.filter(text => /study|client-modules/i.test(text));
  assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join('; ')}`);
  assert.deepEqual(planChecks.consoleErrors, [], `study console errors: ${planChecks.consoleErrors.join('; ')}`);

  await context.close();
  await host.stop();
  // Test profile only: the base facts row is deliberately disabled.
  const disabledHost = await startHost({ root: join(workRoot, 'disabled'), disabledFacts: true });
  const disabledContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const disabledPage = await disabledContext.newPage();
  await disabledPage.goto(disabledHost.url);
  await settleFirstRun(disabledPage);
  for (const [ns, method] of [['learning', 'list'], ['followup', 'due'], ['outcomes', 'day']]) {
    const result = await callRoute(disabledHost.url, `/api/study/${ns}/${method}`);
    assert.equal(result.envelope.code, 'unavailable');
    assert.equal(result.envelope.details.plugin, 'study-facts');
  }
  for (const label of ['问答记录', '提醒', '成果']) {
    await disabledPage.getByRole('button', { name: label, exact: true }).click();
    await disabledPage.getByRole('alert').filter({ hasText: 'study-facts' }).first().waitFor({ timeout: 15000 });
  }
  assert.equal((await callRoute(disabledHost.url, '/api/study/memory/recall')).envelope.ok, true);
  await disabledPage.getByRole('button', { name: '记忆', exact: true }).click();
  await disabledPage.getByTestId('study-memory').waitFor({ timeout: 15000 });
  report.checks.disabledFacts = { started: true, shellPagesUnavailable: true, memoryUsable: true };
  await disabledPage.screenshot({ path: join(EVIDENCE, 'disabled-facts.png') });
  report.screenshots.push('disabled-facts.png');
  await disabledContext.close();
  await disabledHost.stop();
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const host of hosts.reverse()) await host.stop().catch(() => {});
  report.finished = new Date().toISOString();
  report.hostStderr = hosts.map(host => host.stderr().split(/\r?\n/).filter(line => /study|client-modules|FAILED/i.test(line)).slice(0, 20));
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(join(EVIDENCE, 'ui-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--keep') !== true) await rm(workRoot, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
