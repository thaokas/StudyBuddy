// Real browser evidence for the learning-notification path, isolated from the
// student's data and API keys. It launches the installed Edge through the
// pinned source tree's Playwright, serves only `client/learning-notify.js`, and
// records both a granted and a denied permission context. Run with:
//   node plugins/study-outcomes/tests/notify/learning-browser-smoke.mjs
// Needs Edge and host process permission, so it is not part of `node --test`.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = join(ROOT, 'source', 'deepseek-harness');
const NOTIFIER = join(ROOT, 'plugins', 'study-reminders', 'client', 'learning-notify.js');
const EVIDENCE = join(HERE, 'evidence', 'learning-browser.json');

const requireFromSource = createRequire(join(SOURCE, 'package.json'));

/** Import Playwright from the pinned source checkout and its store. */
function loadPlaywright() {
  const bases = [
    join(SOURCE, 'node_modules', '.pnpm', 'node_modules', 'playwright'),
    join(SOURCE, 'node_modules', 'playwright'),
  ];
  for (const base of bases) {
    try { return requireFromSource(base); } catch { /* Try the next fixed locator. */ }
  }
  throw new Error('playwright not found in the pinned source tree');
}

const page = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>StudyBuddy learning notification evidence</title>
<h1>Learning notification evidence</h1>
<p id="permission">pending</p><button id="send">send one reminder</button><output id="result">waiting</output>
<div id="completion"></div><script type="importmap">{"imports":{"react":"/react.js"}}</script><script type="module">
import { createLearningNotifier } from '/learning-notify.js';
import { createCompletionNotifier, CompletionBanner } from '/notify.js';
import messages from '/messages.js';
const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replace('{' + name + '}', value), messages.en[key] || key);
const completion = createCompletionNotifier({ translate: t, mergeWindowMs: 10, isWatching: () => false });
completion.source.subscribe(() => {
  const node = CompletionBanner({ t, useCompletion: fn => fn(completion.source.getSnapshot()), dismiss: completion.dismiss, setEnabled: completion.setEnabled });
  document.querySelector('#completion').replaceChildren(...(node ? [node] : []));
});
const notifier = createLearningNotifier();
const result = document.querySelector('#result');
document.querySelector('#permission').textContent = notifier.permission();
document.querySelector('#send').onclick = () => {
  const row = running => ({ ids: ['reply'], byId: { reply: { id: 'reply', displayTitle: 'Completed reply', running, updatedAt: running ? 1 : 2 } } });
  completion.observe(row(true));
  completion.observe(row(false));
  const first = notifier.notify('block:browser-evidence', 'StudyBuddy', '学习时间块已结束');
  const second = notifier.notify('block:browser-evidence', 'StudyBuddy', '学习时间块已结束');
  const value = { permission: notifier.permission(), first, second };
  result.textContent = JSON.stringify(value);
  fetch('/evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
};
</script></html>`;

const results = [];
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/react.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(`export function createElement(tag, props, ...children) { const node = document.createElement(tag); for (const [key, value] of Object.entries(props || {})) { if (key === 'style') Object.assign(node.style, value); else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value); else if (key !== 'key') node.setAttribute(key, value); } node.append(...children.flat(Infinity).filter(v => v != null)); return node; }`); return;
    }
    if (['/notify.js', '/messages.js'].includes(req.url)) {
      res.setHeader('content-type', 'text/javascript');
      res.end(await readFile(join(ROOT, 'plugins/study-reminders/client', req.url === '/notify.js' ? 'notify.js' : 'messages/notify.js'))); return;
    }
    if (req.url === '/learning-notify.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.end(await readFile(NOTIFIER));
      return;
    }
    if (req.url === '/evidence' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      results.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end('saved');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(page);
  } catch (error) {
    res.statusCode = 500;
    res.end(error.message);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const granted = await browser.newContext();
  await granted.grantPermissions(['notifications'], { origin });
  const grantedPage = await granted.newPage();
  await grantedPage.goto(origin);
  await grantedPage.getByRole('button', { name: 'send one reminder' }).click();
  await grantedPage.waitForFunction(() => document.querySelector('#result').textContent !== 'waiting');
  await grantedPage.getByTestId('study-completion-notice').waitFor();
  const completionBanner = await grantedPage.getByTestId('study-completion-notice').innerText();
  const grantedResult = JSON.parse(await grantedPage.locator('#result').textContent());
  await granted.close();

  const denied = await browser.newContext();
  const deniedPage = await denied.newPage();
  await deniedPage.goto(origin);
  await deniedPage.getByRole('button', { name: 'send one reminder' }).click();
  await deniedPage.waitForFunction(() => document.querySelector('#result').textContent !== 'waiting');
  const deniedResult = JSON.parse(await deniedPage.locator('#result').textContent());
  await denied.close();

  const report = {
    at: new Date().toISOString(),
    browser: 'msedge',
    completionBanner,
    granted: { ...grantedResult, pagePermission: grantedResult.permission === 'granted' },
    denied: { ...deniedResult, pagePermission: ['denied', 'default'].includes(deniedResult.permission) },
    // The granted context sends once and deduplicates the second click; the
    // denied context keeps the in-app path and does not throw.
    passed: completionBanner.includes('Completed reply') && grantedResult.permission === 'granted' && grantedResult.first === true && grantedResult.second === false
      && deniedResult.first === false,
  };
  await mkdir(dirname(EVIDENCE), { recursive: true });
  await writeFile(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    at: new Date().toISOString(),
    status: 'BLOCKED',
    reason: error instanceof Error ? error.message : String(error),
    results,
  };
  await mkdir(dirname(EVIDENCE), { recursive: true });
  await writeFile(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
