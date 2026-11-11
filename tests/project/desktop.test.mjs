/** Validate native model management through its actual RPCs and an isolated synthetic chat in the owned desktop. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { YAML } from '../../scripts/project-config.mjs';
const project = fileURLToPath(new URL('../../', import.meta.url));
const source = join(project, 'source/deepseek-harness');
const require = createRequire(join(source, 'package.json'));
const { chromium } = require(join(source, 'node_modules/.pnpm/node_modules/playwright'));
const launch = JSON.parse(await readFile(join(project, '.studybuddy/launch.json'), 'utf8'));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${launch.DSH_DESKTOP_RENDERER_DEBUG_PORT}`);
const pages = browser.contexts().flatMap(context => context.pages());
const page = pages.find(page => page.url().startsWith('dsh-app://app/'));
const report = { passed: false, root: launch.root, checks: {} };
const temporary = 'project-api-validation';
let inserted = false;
async function rpc(endpoint, args = {}, requireSuccess = true) {
  const result = await page.evaluate(async ({ endpoint, args }) => {
    const response = await fetch(`api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'project-' + crypto.randomUUID(), method: endpoint, payload: { args } }) });
    if (!response.ok) return { ok: false, error: { code: `http/${response.status}` } };
    return (await response.json()).result;
  }, { endpoint, args });
  if (requireSuccess) assert.equal(result.ok, true, `${endpoint}: ${result.error?.code}`);
  return result.ok ? result.value : result;
}
async function section() { return (await rpc('settings/describe')).namespaces.find(row => row.ns === 'llm-pi-ai'); }
try {
  assert.ok(page);
  assert.ok(!pages.some(page => page.url().includes('welcome')));
  report.checks.noNativeLoginWindow = true;
  const catalog = await rpc('session/modelCatalog');
  const custom = catalog.groups.find(group => group.id === 'studybuddy-deepseek');
  assert.ok(custom);
  const model = custom.models.find(model => model.id === 'deepseek-flash');
  assert.ok(model);
  report.checks.model = model;
  assert.deepEqual(model.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'high', 'max']);
  assert.equal(catalog.default.provider, 'studybuddy-deepseek');
  const profilePath = join(launch.home, 'profiles/desktop/cordis.patch.yml');
  const before = YAML.parse(await readFile(profilePath, 'utf8'));
  const savedDefault = before.find(row => row.id === 'agent-default-model').config;
  assert.equal(catalog.default.reasoningEffort, savedDefault.reasoningEffort);
  report.checks.persistedDefault = catalog.default;
  report.checks.accountEndpoint = await rpc('account/getState', {}, false);
  assert.equal(report.checks.accountEndpoint.ok, false);
  report.checks.keyMetadata = await rpc('credentials/describe', { refs: ['STUDYBUDDY_DEEPSEEK_API_KEY'] });
  assert.equal(report.checks.keyMetadata.STUDYBUDDY_DEEPSEEK_API_KEY.configured, true);
  const store = JSON.parse(await readFile(join(launch.home, 'credentials.dpapi'), 'utf8'));
  assert.equal(store.protection, 'windows-dpapi-current-user');
  const first = await section();
  assert.ok(!first.value.providers[temporary]);
  await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: first.revision, ops: [{ op: 'set', path: ['providers', temporary], value: {
    displayName: 'Synthetic validation', api: 'anthropic-messages', baseURL: 'http://127.0.0.1:9',
    apiKeyEnv: 'PROJECT_VALIDATION_API_KEY', models: [{ id: 'synthetic-model', input: ['text'] }],
  } }] });
  inserted = true;
  const second = await section();
  await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: second.revision, ops: [{ op: 'set', path: ['providers', temporary, 'displayName'], value: 'Edited validation' }] });
  const edited = YAML.parse(await readFile(profilePath, 'utf8'));
  assert.equal(edited.find(row => row.id === 'llm-pi-ai').config.providers[temporary].displayName, 'Edited validation');
  const third = await section();
  await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: third.revision, ops: [{ op: 'unset', path: ['providers', temporary] }] });
  inserted = false;
  assert.deepEqual((await section()).value.providers['studybuddy-deepseek'], first.value.providers['studybuddy-deepseek']);
  report.checks.nativeCustomProviderCreateEditDelete = true;
  report.checks.originalCustomProviderPreserved = true;
  if (process.argv.includes('--real')) {
    const created = await rpc('session/create', { request: { cwd: join(launch.root, 'workspace'), agentPreset: 'minimal' } });
    report.checks.realSessionId = created.sessionId;
    await rpc('session/prompt', { request: { sessionId: created.sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: '项目自定义模型连通测试。请只回复 PROJECT_MODEL_OK，不要调用工具。' }] } });
    const deadline = Date.now() + 90000;
    let events;
    while (Date.now() < deadline) {
      const history = await rpc('session/events', { request: { address: { kind: 'session', sessionId: created.sessionId }, maxMessages: 30 } });
      events = history.records.map(record => record.event);
      if (events.some(event => event.type === 'turn/end')) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const end = events.filter(event => event.type === 'turn/end').at(-1);
    report.checks.realTurnEnd = end?.data.reason;
    assert.equal(end?.data.reason.kind, 'completed');
    assert.ok(events.filter(event => event.type === 'assistant/message').some(event => JSON.stringify(event.data.message).includes('PROJECT_MODEL_OK')));
    report.checks.realCustomModelReply = true;
    await rpc('workspace/archiveSession', { request: { sessionId: created.sessionId } });
    report.checks.syntheticChatArchived = true;
  }
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (inserted) await rpc('settings/mutate', { ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['providers', temporary] }] });
  await mkdir(join(launch.root, 'test-results'), { recursive: true });
  await writeFile(join(launch.root, 'test-results/desktop.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); await browser.close();
}
