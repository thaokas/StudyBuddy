/**
 * T16 creation smoke: the real DSH Web host with the personalized-recommendations
 * bundle, a scripted model, and a generated StudyBuddy page.
 *
 * The script proves the product path rather than a mock service:
 * 1. Standard mode answers a daily question and shows no creation card.
 * 2. A new Session switches to Creator mode; the request carries the Creator
 *    tool set, and a page request produces one action card.
 * 3. Create writes a real plugin package (browser half reads only
 *    `/api/study/tasks/day`), the Host validates and installs it, and the
 *    generated tab shows seeded learning data.
 * 4. The default stays Standard for later Sessions, and an existing Session
 *    keeps the preset it started with.
 * 5. Restarting the Host with the same data root keeps the plugin and page.
 * 6. Undo uninstalls it, Restore reinstalls the retained profile copy, and a
 *    Creator that reports ready:false leaves a failed card with a retry.
 *
 * The model is a small Anthropic Messages SSE server: it writes the generated
 * package itself so the smoke does not need a real model key. Run:
 *   node tests/creator/creation-smoke.mjs [--keep]
 * Needs Edge (Playwright), host process permission, and the built DSH source.
 * Screenshots and the JSON report land in `tests/creator/evidence/`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { installCreatorSkill } from '../../scripts/project-config.mjs';

const SOURCE = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('../../plugins/', import.meta.url));
const EVIDENCE = fileURLToPath(new URL('./evidence/', import.meta.url));
const READINESS = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;
const SUCCESS_TEXT = '这是标准模式的回答。';
const INVITE_TEXT = '点击下面的 Create 后，我会在后台创建这个页面。';

const report = { started: new Date().toISOString(), checks: {}, screenshots: [], requests: [], passed: false };
const hosts = [];
const browsers = [];
const forward = value => value.replaceAll('\\', '/');

/** Absolute forward-slash entry of one business plugin row. */
function pluginEntry(plugin) {
  return forward(join(PLUGIN_ROOT, plugin, 'host', 'index.mjs'));
}

/** Import Playwright from the pinned source checkout's store. */
function loadPlaywright() {
  const bases = [
    join(SOURCE, 'node_modules', '.pnpm', 'node_modules', 'playwright'),
    join(SOURCE, 'node_modules', 'playwright'),
  ];
  const failures = [];
  for (const base of bases) {
    try { return createRequire(join(SOURCE, 'package.json'))(base); }
    catch (error) { failures.push(`${base}（${error.code ?? error.message}）`); }
  }
  throw new Error(`找不到 playwright，试过：\n  ${failures.join('\n  ')}`);
}

/**
 * Scripted Anthropic Messages server. The parent agent asks for a page once,
 * the Creator child gets exactly one request per Create, and the second child
 * reports ready:false to exercise the failed card.
 */
async function startMock() {
  const state = { toolCalls: new Map(), callSeq: 0, creatorRequests: 0, pageRequests: 0 };
  const requests = [];
  const head = () => ({
    type: 'message_start',
    message: { id: 'mock-message', type: 'message', role: 'assistant', model: 'mock', content: [], usage: { input_tokens: 1, output_tokens: 0 } },
  });
  const tail = (reason, tokens) => [
    { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: tokens } },
    { type: 'message_stop' },
  ];
  const write = (response, events) => {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  };
  const text = text => [
    head(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    ...tail('end_turn', 3),
  ];
  const tool = (name, input) => {
    const id = `mock-call-${++state.callSeq}`;
    state.toolCalls.set(id, name);
    return [
      head(),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
      { type: 'content_block_stop', index: 0 },
      ...tail('tool_use', 8),
    ];
  };
  const messageText = message => typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const toolResults = body => {
    const last = body.messages?.at(-1);
    if (last?.role !== 'user') return [];
    return (last.content ?? []).filter(block => block.type === 'tool_result')
      .map(block => state.toolCalls.get(block.tool_use_id) ?? 'unknown');
  };
  /** Extract the Creator JSON prompt from a user message body. */
  function creatorPrompt(textValue) {
    const start = textValue.indexOf('{"task"');
    if (start < 0) return undefined;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = start; index < textValue.length; index += 1) {
      const character = textValue[index];
      if (inString) {
        if (escape) escape = false;
        else if (character === '\\') escape = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) return JSON.parse(textValue.slice(start, index + 1));
      }
    }
    return undefined;
  }
  const server = createServer(async (request, response) => {
    if (!request.url.endsWith('/v1/messages')) { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const tools = (body.tools ?? []).map(item => item.name);
    const results = toolResults(body);
    const userText = messageText(body.messages?.filter(message => message.role === 'user').at(-1));
    const record = { index: requests.length + 1, tools, results, userText, kind: 'other' };
    requests.push(record);
    if (tools.includes('structured_output')) {
      state.creatorRequests += 1;
      record.kind = 'creator';
      const prompt = creatorPrompt(userText);
      record.prompt = prompt === undefined ? undefined : {
        title: prompt.title, location: prompt.location, packageName: prompt.packageName, directory: prompt.directory,
      };
      if (state.creatorRequests === 1 && prompt?.directory !== undefined && prompt?.packageName !== undefined) {
        await writeGeneratedPackage(prompt.directory, prompt.packageName);
        write(response, tool('structured_output', { ready: true }));
      } else {
        write(response, tool('structured_output', { ready: false }));
      }
      return;
    }
    if (tools.includes('propose_action')) {
      state.pageRequests += 1;
      const failed = /失败页面/.test(JSON.stringify(body.messages));
      const willPropose = results.includes('skill') || (results.length === 0 && failed);
      record.kind = willPropose ? 'proposal' : 'answer';
      if (willPropose) {
        write(response, tool('propose_action', {
          action: 'create_personalized_page',
          title: failed ? '失败页面' : '学习清单页',
          brief: failed ? '故意让 Creator 报告未完成，验证失败提示。' : '按日期列出今天的学习块与完成状态，只读学习服务。',
          details: { slot: 'page' },
        }));
      } else if (results.includes('propose_action')) {
        write(response, text(INVITE_TEXT));
      } else {
        write(response, text(SUCCESS_TEXT));
      }
      return;
    }
    if (tools.length === 0) {
      record.kind = 'answer';
      // This is the session-title prompt: return a stable title so the smoke
      // can open the two Sessions by name instead of by a shared fallback.
      const title = /帮我看看今天/.test(userText) ? '标准会话'
        : /失败页面/.test(userText) ? '失败页面会话'
          : /做一个学习清单页/.test(userText) ? '创造会话'
            : SUCCESS_TEXT;
      write(response, text(title));
      return;
    }
    if (tools.includes('skill') && (userText.includes('学习清单') || userText.includes('失败页面'))) {
      record.kind = 'skill';
      write(response, tool('skill', { name: 'personalized-pages' }));
      return;
    }
    record.kind = 'answer';
    write(response, text(SUCCESS_TEXT));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    requests,
    close,
  };
}

/**
 * Write the real generated package into the Creator's reserved directory.
 * The browser half reads only the study route; the host half stays empty.
 */
async function writeGeneratedPackage(directory, packageName) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: packageName, version: '1.0.0', private: true, type: 'module',
    main: './index.js', exports: { '.': './index.js', './client': './client.js' },
    files: ['index.js', 'client.js', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  }, undefined, 2)}\n`);
  await writeFile(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: "${packageName}:view"\n      name: "${packageName}"\n`);
  await writeFile(join(directory, 'index.js'), 'export function apply() {}\n');
  await writeFile(join(directory, 'client.js'), `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Page() {
      const [state, setState] = React.useState({ status: 'loading' });
      React.useEffect(() => {
        let cancelled = false;
        fetch('/api/study/tasks/day', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(async response => ({ status: response.status, envelope: await response.json() }))
          .then(({ status, envelope }) => {
            if (cancelled) return;
            if (envelope && envelope.ok === true) setState({ status: 'ready', day: envelope.value });
            else setState({ status: 'error', message: (envelope && envelope.message) || ('HTTP ' + status) });
          })
          .catch(error => { if (!cancelled) setState({ status: 'error', message: String(error) }); });
        return () => { cancelled = true; };
      }, []);
      if (state.status === 'loading') return h('div', { style: { padding: 24 } }, '正在读取学习清单…');
      if (state.status === 'error') return h('div', { role: 'alert', style: { padding: 24 } }, '读取失败：' + state.message);
      const blocks = state.day.blocks || [];
      return h('main', { style: { padding: 24, overflow: 'auto' } },
        h('h1', null, '学习清单 ' + state.day.date),
        blocks.length === 0
          ? h('p', null, '今天还没有安排。')
          : h('ul', null, blocks.map(block => h('li', { key: block.id },
            block.start + '–' + block.end + ' ' + ((block.task && block.task.title) || block.title || '未命名') + '（' + block.minutes + ' 分钟）'))));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'study-list', order: 20, label: '学习清单',
        }, Page));
      },
    };
  },
});
`);
}

/** Create the isolated Web profile and its study/mock overlay. */
async function prepareRoot(root, mock) {
  const home = join(root, 'home');
  const profile = join(home, 'profiles/web');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: {},
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-personalized-recommendations',
    ] } },
  }, undefined, 2)}\n`);
  await installCreatorSkill(home);
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  const overlay = [
    '- id: deepseek-account', '  disabled: true',
    '- id: llm-deepseek-account', '  disabled: true',
    '- id: ui-settings-account', '  disabled: true',
    '- id: account-controller', '  disabled: true',
    '- id: session-log-deepseek', '  disabled: true',
    '- id: session-telemetry-otel', '  disabled: true',
    '- id: product-analytics', '  disabled: true',
    '- id: workspace-controller', '  config:', `    documentsDirectory: ${JSON.stringify(forward(join(root, 'workspace')))}`,
    '- id: llm-deepseek', '  config:', `    baseURL: ${JSON.stringify(`${mock.baseURL}/v1`)}`,
    '    maxTokens: 4096', '    thinking: disabled', '    models:',
    '      - id: deepseek-flash', '        name: Mock model', '        inputModalities: [text]',
    '- insert:',
    '    - id: study-core',
    `      name: ${JSON.stringify(pluginEntry('study-core'))}`,
    '      config:',
    `        dataDir: ${JSON.stringify(forward(join(root, 'data')))}`,
    '    - id: study-facts',
    `      name: ${JSON.stringify(pluginEntry('study-facts'))}`,
    '    - id: study-learning',
    `      name: ${JSON.stringify(pluginEntry('study-learning'))}`,
    '    - id: study-reminders',
    `      name: ${JSON.stringify(pluginEntry('study-reminders'))}`,
    '    - id: study-memory',
    `      name: ${JSON.stringify(pluginEntry('study-memory'))}`,
    '    - id: study-outcomes',
    `      name: ${JSON.stringify(pluginEntry('study-outcomes'))}`,
    '',
  ].join('\n');
  const overlayPath = join(root, 'overlay.yml');
  await writeFile(overlayPath, overlay);
  return { home, profile, overlay: overlayPath, workspace: join(root, 'workspace') };
}

/** Boot one isolated Web host. */
async function startHost(root, paths) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(DSH_|ELECTRON_)/i.test(name)) delete env[name];
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    DSH_HOME: paths.home,
    DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TELEMETRY_MODE: 'DISABLED',
    DEEPSEEK_API_KEY: 'creation-smoke-key',
  });
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts',
    'web', '--patch', paths.overlay, '--no-open', '--port', '0',
  ], { cwd: SOURCE, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const host = {
    pid: child.pid,
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode === null) {
        spawnSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
      }
      await Promise.race([exited, delay(15000, undefined, { ref: false })]);
      await writeFile(join(root, 'host.stdout.log'), stdout);
      await writeFile(join(root, 'host.stderr.log'), stderr);
    },
  };
  hosts.push(host);
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Host 在就绪前退出（${child.exitCode}）：\n${stderr.slice(-4000)}`);
    const match = stdout.match(READINESS);
    if (match !== null) {
      host.url = match[0];
      host.origin = new URL(match[0]).origin;
      return host;
    }
    await delay(250);
  }
  await host.stop();
  throw new Error(`Host 在 240s 内没有报告就绪 URL：\n${stderr.slice(-4000)}`);
}

const FIRST_RUN_BUTTONS = Object.freeze([
  /^(继续|Continue)$/, /^(稍后配置|Configure later)$/, /^(添加 API Key|Add API Key)$/, /^(关闭|Close)$/,
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

/** Wait until no dialog or modal mask blocks the page. */
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
  throw new Error('首屏对话框没有关闭，会拦截页面点击');
}

/** Open one browser page and settle the first-run chain. */
async function openPage(playwright, host) {
  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  browsers.push(browser);
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = { page: [], console: [] };
  page.on('pageerror', error => errors.page.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.console.push(message.text()); });
  await page.goto(host.url);
  await settleFirstRun(page);
  await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30000 });
  return { browser, page, errors };
}

const chip = page => page.locator('button[aria-haspopup="menu"][title="选择新任务使用的 Agent 预设"]');
const cards = page => page.locator('[data-action-card]');
const lastCard = page => cards(page).last();
const composer = page => page.locator('[contenteditable="true"]').first();

/** Open the mode menu and return its item labels. */
async function modeItems(page) {
  await chip(page).click();
  await page.getByRole('menu').waitFor({ timeout: 10000 });
  const items = await page.getByRole('menuitem').allInnerTexts();
  await page.keyboard.press('Escape');
  return items;
}

/** Switch the blank Session to one preset. */
async function chooseMode(page, label) {
  await chip(page).click();
  await page.getByRole('menuitem', { name: label }).click();
  const expected = label instanceof RegExp ? label : new RegExp(label);
  const deadline = Date.now() + 15000;
  let text = '';
  while (Date.now() < deadline) {
    text = await chip(page).innerText().catch(() => '');
    if (expected.test(text)) return;
    await delay(200);
  }
  throw new Error(`模式没有切换到 ${expected}：${text}`);
}

/** Send one composer message. */
async function send(page, text) {
  const input = composer(page);
  await input.fill(text);
  await input.press('Enter');
}

/** Wait for the mock server to receive more requests. */
async function waitRequests(mock, count) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && mock.requests.length <= count) await delay(250);
  assert.ok(mock.requests.length > count, `发送后 mock 模型应在 120s 内收到请求（已有 ${mock.requests.length}）`);
  return mock.requests.slice(count);
}

/** Wait for body text. */
async function waitText(page, text, timeout = 60000) {
  await page.waitForFunction(value => document.body.innerText.includes(value), text, { timeout });
}

/** Click one sidebar session by title. */
async function openSession(page, title) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && await page.getByText(title, { exact: false }).count() === 0) await delay(250);
  await page.getByText(title, { exact: false }).first().click();
  await composer(page).waitFor({ timeout: 20000 });
  const chatTab = page.getByRole('tab', { name: /^对话$/ });
  if (await chatTab.count() > 0) await chatTab.first().click();
  await delay(1200);
}

/** Create a new blank Session from the sidebar. */
async function newSession(page) {
  // The brand header also exposes the "新会话" shortcut text; the shortcut
  // label identifies the actual control without relying on hashed CSS names.
  const button = page.locator('button').filter({ hasText: /Ctrl\+Alt\+N|Cmd\+Alt\+N/ }).first();
  assert.equal(await button.count(), 1, '侧栏应有新建会话按钮');
  await button.click();
  await chip(page).waitFor({ timeout: 20000 });
  await delay(800);
}

/** Reload the current page and settle the shell. */
async function reload(page) {
  await page.reload({ waitUntil: 'load' });
  await settleFirstRun(page);
  await composer(page).waitFor({ timeout: 30000 });
  await delay(1500);
}

/** Screenshot one named state. */
async function shot(page, name) {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  report.screenshots.push(`${name}.png`);
}

/** Close study reminder/recovery banners that can cover the composer or an action card. */
async function dismissStudyBanners(page) {
  for (const testId of ['followup-recovery-dismiss', 'followup-banner-dismiss']) {
    const button = page.getByTestId(testId);
    if (await button.count() === 0) continue;
    await button.first().click({ timeout: 5000 }).catch(() => {});
    await delay(200);
  }
}

/** Seed one task and one time block through the authenticated study route. */
async function seedToday(page) {
  return await page.evaluate(async () => {
    // Study writes are idempotent per requestId; the HTTP route does not invent one.
    const post = (path, body) => fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }),
    }).then(response => response.json());
    const task = await post('/api/study/tasks/createTask', { title: '极限习题', subject: '数学' });
    const block = await post('/api/study/tasks/createBlock', {
      taskId: task.value?.task?.id, start: '09:00', end: '09:30',
    });
    return { taskId: task.value?.task?.id, taskOk: task.ok === true, blockOk: block.ok === true, blockId: block.value?.block?.id };
  });
}

/** Wait for the card to reach one of the named states. */
async function waitCard(page, pattern, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let text = '';
  while (Date.now() < deadline) {
    if (await cards(page).count() === 0) {
      await delay(500);
      continue;
    }
    text = await lastCard(page).innerText().catch(() => '');
    if (pattern.test(text)) return text;
    await delay(500);
  }
  throw new Error(`卡片没有进入 ${pattern}：${text}`);
}

const workRoot = await mkdtemp(join(tmpdir(), 'study-creator-'));
const mock = await startMock();
let paths;
try {
  await mkdir(EVIDENCE, { recursive: true });
  const playwright = loadPlaywright();
  paths = await prepareRoot(join(workRoot, 'run'), mock);
  let host = await startHost(join(workRoot, 'run'), paths);
  const run = await openPage(playwright, host);
  const page = run.page;

  // 1. Standard mode answers a daily question, shows no card, and uses no
  //    Creator tools. The catalog already contains the StudyBuddy reference.
  const standardChip = await chip(page).innerText();
  assert.match(standardChip, /标准模式/);
  let before = mock.requests.length;
  await send(page, '帮我看看今天的学习安排');
  await waitRequests(mock, before);
  await waitText(page, SUCCESS_TEXT);
  await delay(800);
  const standardRequest = mock.requests.filter(request => request.kind === 'answer' && request.tools.length > 0).at(-1);
  assert.ok(standardRequest, '标准模式应收到一次带工具的模型请求');
  assert.equal(standardRequest.tools.includes('cordis_inspect_query'), false, '标准模式不应带 Creator 检查工具');
  assert.match(standardRequest.userText, /study-creator/, '请求的技能目录应包含 StudyBuddy 参考');
  assert.equal(await cards(page).count(), 0, '标准模式日常答疑不应出现创建卡片');
  report.checks.standard = {
    chip: standardChip, tools: standardRequest.tools.length, hasCordis: false, cards: 0,
    skillCatalog: /study-creator/.test(standardRequest.userText),
  };
  await shot(page, 'creator-standard-answer');

  // 2. A new Session switches to Creator explicitly; the request carries the
  //    Creator tool set and the page request produces exactly one card.
  await newSession(page);
  const defaultChip = await chip(page).innerText();
  assert.match(defaultChip, /标准模式/, '新会话默认仍应是标准模式');
  const items = await modeItems(page);
  assert.equal(items.length, 4);
  for (const name of ['标准模式', 'PTC 模式', '极简模式', '创造模式']) {
    assert.ok(items.some(item => item.includes(name)), `模式菜单缺少「${name}」：${JSON.stringify(items)}`);
  }
  await chooseMode(page, /创造模式/);
  const creatorChip = await chip(page).innerText();
  assert.match(creatorChip, /创造模式/);
  before = mock.requests.length;
  await send(page, '做一个学习清单页，按日期列出今天的学习块');
  await waitRequests(mock, before);
  await cards(page).first().waitFor({ timeout: 120000 });
  await waitText(page, INVITE_TEXT);
  const creatorParent = mock.requests.find(request => request.kind === 'proposal');
  assert.equal(creatorParent.tools.includes('cordis_inspect_query'), true, '创造模式请求应带 Creator 检查工具');
  assert.equal(await cards(page).count(), 1, '一个回合只应出现一张创建卡片');
  const offered = await lastCard(page).innerText();
  assert.match(offered, /学习清单页/);
  assert.match(offered, /创建/);
  report.checks.creatorMode = {
    defaultChip, items, chip: creatorChip,
    tools: creatorParent.tools.length, hasCordis: true, cards: 1,
  };
  await shot(page, 'creator-card-offered');

  // 3. Seed the learning data, then Create: the scripted Creator writes a real
  //    package whose browser half reads only the study route.
  const seeded = await seedToday(page);
  assert.equal(seeded.taskOk, true);
  assert.equal(seeded.blockOk, true);
  await dismissStudyBanners(page);
  const create = lastCard(page).getByRole('button', { name: /^创建$/ });
  await create.click();
  const installedText = await waitCard(page, /已安装|Installed/);
  const manifestAfterInstall = JSON.parse(await readFile(join(paths.profile, 'package.json'), 'utf8'));
  const installedName = Object.keys(manifestAfterInstall.dependencies ?? {})
    .find(name => name.startsWith('@dsh-local/view-'));
  assert.ok(installedName, `安装后 profile 应依赖生成的包：${JSON.stringify(manifestAfterInstall)}`);
  assert.ok(manifestAfterInstall.dsh.profile.bundles.includes(installedName));
  const creatorRequest = mock.requests.find(request => request.kind === 'creator' && request.prompt?.directory !== undefined);
  assert.ok(creatorRequest, 'Creator 应收到带目录的生成提示');
  const sourceClient = await readFile(join(creatorRequest.prompt.directory, 'client.js'), 'utf8');
  const createdDirectory = join(paths.profile, 'created-plugins', installedName.slice('@dsh-local/view-'.length));
  const clientSource = await readFile(join(createdDirectory, 'client.js'), 'utf8');
  assert.equal(clientSource, sourceClient, 'profile 副本应保持 Creator 写出的内容');
  assert.match(clientSource, /\/api\/study\/tasks\/day/, '生成页面应只经 study 路由读数据');
  assert.doesNotMatch(clientSource, /study\.db|study\.db-wal|memory\.json|credentials\.dpapi/, '生成页面不得直接打开学习数据文件');
  report.checks.created = {
    installedText: installedText.replace(/\s+/g, ' ').trim(), installedName,
    dependency: manifestAfterInstall.dependencies[installedName],
    readsStudyRoute: /\/api\/study\/tasks\/day/.test(clientSource),
    directFileAccess: /study\.db|study\.db-wal|memory\.json|credentials\.dpapi/.test(clientSource),
    seeded, sourceDirectory: creatorRequest.prompt.directory,
    promptLocation: creatorRequest.prompt.location,
  };
  await shot(page, 'creator-card-installed');

  // 4. Reload shows the installed page and seeded data in the current Session.
  await reload(page);
  await page.getByRole('tab', { name: /学习清单/ }).waitFor({ timeout: 30000 });
  await page.getByRole('tab', { name: /学习清单/ }).click();
  await waitText(page, '学习清单', 30000);
  await waitText(page, '极限习题', 30000);
  const installedPage = await page.locator('main').filter({ hasText: '学习清单' }).first().innerText();
  assert.match(installedPage, /09:00–09:30/);
  report.checks.installedPage = { text: installedPage.replace(/\s+/g, ' ').trim(), tabs: await page.getByRole('tab').allInnerTexts() };
  await shot(page, 'creator-installed-page');

  // 5. The default does not change, and an existing Session keeps its preset.
  const profilePatchAfterSwitch = await readFile(join(paths.profile, 'cordis.patch.yml'), 'utf8');
  assert.doesNotMatch(profilePatchAfterSwitch, /agent-preset-registry/, '选择创造模式不应写入新任务默认');
  await openSession(page, '标准会话');
  before = mock.requests.length;
  await send(page, '帮我整理一下今天的学习安排');
  await waitRequests(mock, before);
  await waitText(page, SUCCESS_TEXT);
  await delay(500);
  const laterStandard = mock.requests.filter(request => request.tools.length > 0).at(-1);
  assert.ok(laterStandard);
  assert.equal(laterStandard.tools.includes('cordis_inspect_query'), false, '标准模式会话的后续请求仍应是标准模式');
  assert.equal(await cards(page).count(), 0, '标准模式后续请求仍不应出现创建卡片');
  report.checks.defaultUnchanged = { defaultWrite: false, hasCordis: false, cards: 0 };

  await openSession(page, '创造会话');
  await page.getByText('创造模式', { exact: true }).first().waitFor({ timeout: 20000 });
  before = mock.requests.length;
  await send(page, '今天还有什么要注意的');
  await waitRequests(mock, before);
  await waitText(page, SUCCESS_TEXT);
  await delay(500);
  const creatorFollowup = mock.requests.filter(request => request.tools.length > 0).at(-1);
  assert.ok(creatorFollowup);
  assert.equal(creatorFollowup.tools.includes('cordis_inspect_query'), true, '创造模式会话的后续请求应保持创造预设');
  report.checks.sessionPresetKept = { hasCordis: true };

  // 6. Restart with the same data root: the generated page and card remain.
  await run.browser.close();
  await host.stop();
  host = await startHost(join(workRoot, 'run'), paths);
  const restarted = await openPage(playwright, host);
  const page2 = restarted.page;
  await delay(1500);
  const blankChip = await chip(page2).count() > 0
    ? await chip(page2).innerText({ timeout: 3000 }).catch(() => '')
    : '';
  if (blankChip !== '') assert.match(blankChip, /标准模式/, '重启后的空会话仍应是标准模式');
  await openSession(page2, '创造会话');
  await page2.getByText('创造模式', { exact: true }).first().waitFor({ timeout: 20000 });
  await page2.getByRole('tab', { name: /学习清单/ }).waitFor({ timeout: 30000 });
  await page2.getByRole('tab', { name: /学习清单/ }).click();
  await waitText(page2, '极限习题', 30000);
  const restartedPage = await page2.locator('main').filter({ hasText: '学习清单' }).first().innerText();
  assert.match(restartedPage, /极限习题/);
  report.checks.restart = { blankChip, tabs: await page2.getByRole('tab').allInnerTexts(), page: restartedPage.replace(/\s+/g, ' ').trim() };
  await shot(page2, 'creator-after-restart');

  // 7. Undo removes the plugin; Restore brings the retained profile copy back.
  await page2.getByRole('tab', { name: /^对话$/ }).click();
  const card2 = await waitCard(page2, /已安装|Installed/).then(() => lastCard(page2));
  await dismissStudyBanners(page2);
  await card2.getByRole('button', { name: /^撤销$/ }).click();
  const removedText = await waitCard(page2, /已移除|Removed/);
  const manifestAfterUndo = JSON.parse(await readFile(join(paths.profile, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(manifestAfterUndo.dependencies ?? {}, installedName), false, '撤销后 profile 不应再依赖生成的包');
  assert.equal(manifestAfterUndo.dsh.profile.bundles.includes(installedName), false);
  await reload(page2);
  assert.equal(await page2.getByRole('tab', { name: /学习清单/ }).count(), 0, '撤销并刷新后生成页签应消失');
  await openSession(page2, '创造会话');
  await dismissStudyBanners(page2);
  const restore = lastCard(page2).getByRole('button', { name: /^恢复$/ });
  await restore.click();
  await waitCard(page2, /已安装|Installed/);
  const manifestAfterRestore = JSON.parse(await readFile(join(paths.profile, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(manifestAfterRestore.dependencies ?? {}, installedName), true, '恢复后 profile 应重新依赖生成的包');
  await reload(page2);
  await page2.getByRole('tab', { name: /学习清单/ }).waitFor({ timeout: 30000 });
  await page2.getByRole('tab', { name: /学习清单/ }).click();
  await waitText(page2, '极限习题', 30000);
  report.checks.undoRestore = {
    removed: removedText.replace(/\s+/g, ' ').trim(),
    undoRemovedDependency: !Object.hasOwn(manifestAfterUndo.dependencies ?? {}, installedName),
    restoredDependency: Object.hasOwn(manifestAfterRestore.dependencies ?? {}, installedName),
    tabBack: await page2.getByRole('tab', { name: /学习清单/ }).count() === 1,
  };
  await shot(page2, 'creator-after-restore');

  // 8. A Creator that reports ready:false leaves a failed card with a retry.
  await page2.getByRole('tab', { name: /^对话$/ }).click();
  before = mock.requests.length;
  await send(page2, '再做一个失败页面，验证错误提示');
  await waitRequests(mock, before);
  await page2.locator('[data-action-card]').last().waitFor({ timeout: 120000 });
  await waitText(page2, '失败页面');
  await dismissStudyBanners(page2);
  await lastCard(page2).getByRole('button', { name: /^创建$/ }).click();
  const failedText = await waitCard(page2, /创建失败|Failed/, 120000);
  assert.match(failedText, /重新创建|Retry/);
  report.checks.failure = { text: failedText.replace(/\s+/g, ' ').trim() };
  await shot(page2, 'creator-failed-card');
  assert.deepEqual(run.errors.page, [], `浏览页抛出异常：${run.errors.page.join('；')}`);
  assert.deepEqual(restarted.errors.page, [], `重启后浏览页抛出异常：${restarted.errors.page.join('；')}`);
  report.checks.errors = { firstPage: run.errors, restartedPage: restarted.errors };
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const host of hosts.reverse()) await host.stop().catch(() => {});
  await mock.close().catch(() => {});
  report.requests = mock.requests.map(request => ({
    index: request.index, kind: request.kind, tools: request.tools.length,
    hasPropose: request.tools.includes('propose_action'),
    hasStructured: request.tools.includes('structured_output'),
    results: request.results, prompt: request.prompt,
  }));
  report.finished = new Date().toISOString();
  report.hostStderr = hosts.map(host => host.stderr().split(/\r?\n/)
    .filter(line => /study|creator|creation|plugin|skipping|FAILED/i.test(line)).slice(0, 20));
  await writeFile(join(EVIDENCE, 'creation-smoke.json'), `${JSON.stringify(report, undefined, 2)}\n`);
  if (process.argv.includes('--keep') !== true) await rm(workRoot, { recursive: true, force: true });
  console.log(JSON.stringify(report, undefined, 2));
}
