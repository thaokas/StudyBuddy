import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as study from '../../host/index.mjs';
import { openStudyDatabase } from '../../host/db.mjs';
import { NAMESPACES } from '../../host/registry.mjs';

const hostDirectory = fileURLToPath(new URL('../../host/', import.meta.url));
const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { Context } = requireFromSource('@deepseek-ai/cordis');

function mountServices(ctx, { connection = true } = {}) {
  const tools = [];
  const routes = [];
  ctx.provide('tools', {
    register(definition) {
      tools.push(definition);
      return () => {
        const index = tools.indexOf(definition);
        if (index >= 0) tools.splice(index, 1);
      };
    },
  });
  if (connection) {
    ctx.provide('connection', {
      fetch: {
        register(route) {
          routes.push(route);
          return async () => {
            const index = routes.indexOf(route);
            if (index >= 0) routes.splice(index, 1);
          };
        },
      },
    });
  }
  return { tools, routes };
}

/** Boot the plugin against fake host services; the database closes before the directory is removed. */
async function fixture(t, { dataDir, prepare, connection = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'study-plugin-'));
  const target = dataDir ?? directory;
  if (prepare) await prepare(target);
  const ctx = new Context();
  const { tools, routes } = mountServices(ctx, { connection });
  const fiber = ctx.plugin(study, { dataDir: target });
  await fiber;
  t.after(async () => {
    try { await fiber.dispose(); } catch { /* Already disposed by the test. */ }
    await rm(directory, { recursive: true, force: true });
  });
  return { ctx, fiber, tools, routes, directory, dataDir: target };
}

test('the plugin exposes the kernel route, the status tool, and a working service', async t => {
  const { ctx, tools, routes } = await fixture(t);

  // Later modules register their own tools and routes, so assert this module's contributions by name.
  assert.ok(tools.some(tool => tool.name === 'study_status'));
  const kernelRoute = routes.find(route => route.path === '/api/study/kernel/status');
  assert.ok(kernelRoute, 'expected the kernel status route');
  assert.deepEqual(kernelRoute.methods, ['POST']);
  assert.equal(kernelRoute.requestBody, 'buffered');

  const result = await ctx.study.call('kernel', 'status', {});
  assert.equal(result.ok, true);
  assert.equal(result.revision, 0);
  assert.ok(result.value.database.file.endsWith('study.db'));
  assert.ok(result.value.modules.some(module => module.id === 'kernel'));
  assert.ok(result.value.namespaces.some(entry => entry.ns === 'learning'), 'expected the learning namespace');
  assert.ok(result.value.today.snapshotAt);
});

test('the plugin loads without a web connection and still serves tools', async t => {
  const { ctx, tools, routes } = await fixture(t, { connection: false });
  assert.ok(tools.some(tool => tool.name === 'study_status'));
  assert.equal(routes.length, 0);
  const result = await ctx.study.call('kernel', 'status', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.database.journalMode, 'wal');
});

test('routes attach when a connection activates after the plugin', async t => {
  const { ctx, routes } = await fixture(t, { connection: false });
  assert.equal(routes.length, 0);
  const late = [];
  ctx.provide('connection', {
    fetch: {
      register(route) {
        late.push(route);
        return async () => {
          const index = late.indexOf(route);
          if (index >= 0) late.splice(index, 1);
        };
      },
    },
  });
  for (let attempt = 0; attempt < 200 && late.length === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const kernelRoute = late.find(route => route.path === '/api/study/kernel/status');
  assert.ok(kernelRoute, 'expected the kernel status route to attach late');
  const response = await kernelRoute.fetch(new Request('http://localhost/api/study/kernel/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('the HTTP route answers the success envelope and rejects malformed bodies', async t => {
  const { routes } = await fixture(t);
  const route = routes[0];

  const success = await route.fetch(new Request('http://localhost/api/study/kernel/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: 'plugin-1' }),
  }));
  assert.equal(success.status, 200);
  const envelope = await success.json();
  assert.equal(envelope.ok, true);
  assert.equal(envelope.revision, 0);
  assert.equal(envelope.value.modules[0].id, 'kernel');

  const malformed = await route.fetch(new Request('http://localhost/api/study/kernel/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'invalid');

  const arrayBody = await route.fetch(new Request('http://localhost/api/study/kernel/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '[]',
  }));
  assert.equal(arrayBody.status, 400);
  assert.equal((await arrayBody.json()).code, 'invalid');
});

test('the status tool reads the same facts as the service', async t => {
  const { ctx, tools } = await fixture(t);
  const tool = tools.find(item => item.name === 'study_status');
  assert.ok(tool, 'expected the study_status tool');
  const value = await tool.execute({}, { signal: new AbortController().signal });
  const service = await ctx.study.call('kernel', 'status', {});
  const { serverTime: _toolTime, ...toolFacts } = value;
  const { serverTime: _serviceTime, ...serviceFacts } = service.value;
  assert.deepEqual(toolFacts, serviceFacts);
});

test('a namespace registered after startup gets a route and serves envelopes', async t => {
  const { ctx, routes } = await fixture(t);

  // Every frozen namespace that ships a module is registered at startup, so use
  // one no module claims yet. When every namespace is claimed (the full build),
  // there is no namespace left to simulate; the connection-activation test above
  // still covers late route attachment.
  const status = await ctx.study.call('kernel', 'status', {});
  const used = new Set(status.value.namespaces.map(entry => entry.ns));
  const namespace = NAMESPACES.find(candidate => !used.has(candidate));
  if (namespace === undefined) {
    t.skip('所有冻结命名空间都由已发布模块注册，无法再模拟启动后注册的命名空间');
    return;
  }
  const dispose = ctx.study.register(namespace, { methods: { echo: payload => ({ echo: payload.value ?? null }) } });
  const route = routes.find(item => item.path === `/api/study/${namespace}/echo`);
  assert.ok(route, 'expected a route for the late namespace');

  const response = await route.fetch(new Request(`http://localhost/api/study/${namespace}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'hi' }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).value, { echo: 'hi' });

  dispose();
  const afterRemoval = await route.fetch(new Request(`http://localhost/api/study/${namespace}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'hi' }),
  }));
  assert.equal(afterRemoval.status, 404);
  assert.equal((await afterRemoval.json()).code, 'not_found');
});

test('disposing the plugin removes its contributions and leaves the database readable', async t => {
  const { ctx, fiber, tools, routes, directory } = await fixture(t);
  await fiber.dispose();
  assert.equal(tools.length, 0);
  assert.equal(routes.length, 0);
  assert.equal(ctx.get('study'), undefined);

  const database = await openStudyDatabase({ file: join(directory, 'study.db') });
  assert.equal(database.get('SELECT COUNT(*) AS count FROM day_snapshot').count, 1);
  database.close();
});

test('an incompatible database layout stops the plugin before it registers anything', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-plugin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = new DatabaseSync(join(directory, 'study.db'));
  raw.exec('PRAGMA user_version = 42');
  raw.close();

  const ctx = new Context();
  const { tools, routes } = mountServices(ctx);
  await assert.rejects(async () => { await ctx.plugin(study, { dataDir: directory }); }, error => {
    assert.equal(error.code, 'unavailable');
    assert.match(error.details.recovery, /备份/);
    return true;
  });
  assert.equal(tools.length, 0);
  assert.equal(routes.length, 0);
});

test('a missing data directory configuration fails loudly', async t => {
  const saved = { home: process.env.DSH_HOME, study: process.env.STUDYBUDDY_STUDY_DIR };
  delete process.env.DSH_HOME;
  delete process.env.STUDYBUDDY_STUDY_DIR;
  t.after(() => {
    if (saved.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.home;
    if (saved.study === undefined) delete process.env.STUDYBUDDY_STUDY_DIR; else process.env.STUDYBUDDY_STUDY_DIR = saved.study;
  });
  await assert.rejects(async () => { await study.apply(new Context(), {}); }, error => {
    assert.equal(error.code, 'invalid');
    assert.match(error.message, /dataDir/);
    return true;
  });
});

test('the shipped module directory contains the kernel module', async () => {
  const definitions = await study.loadModuleDefinitions(join(hostDirectory, 'modules'));
  const kernel = definitions.find(definition => definition.id === 'kernel');
  assert.ok(kernel, 'expected the shipped kernel module');
  assert.deepEqual(kernel.deps, []);
  assert.deepEqual(kernel.schema, []);
  assert.equal(kernel.schemaVersion, 1);
  assert.equal(typeof kernel.apply, 'function');
});

test('module discovery orders dependencies first', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-modules-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'a.mjs'), "export const id = 'a';\nexport const deps = ['b'];\nexport const apply = () => {};\n");
  await writeFile(join(directory, 'b.mjs'), "export const id = 'b';\nexport const apply = () => {};\n");
  const definitions = await study.loadModuleDefinitions(directory);
  assert.deepEqual(definitions.map(definition => definition.id), ['b', 'a']);
});

test('module discovery rejects missing dependencies, duplicate ids, and cycles', async t => {
  const lonely = await mkdtemp(join(tmpdir(), 'study-modules-'));
  t.after(() => rm(lonely, { recursive: true, force: true }));
  await writeFile(join(lonely, 'lonely.mjs'), "export const id = 'lonely';\nexport const deps = ['absent'];\nexport const apply = () => {};\n");
  await assert.rejects(study.loadModuleDefinitions(lonely), error => {
    assert.equal(error.code, 'invalid');
    assert.match(error.message, /不存在的模块/);
    return true;
  });

  const duplicate = await mkdtemp(join(tmpdir(), 'study-modules-'));
  t.after(() => rm(duplicate, { recursive: true, force: true }));
  await writeFile(join(duplicate, 'one.mjs'), "export const id = 'same';\nexport const apply = () => {};\n");
  await writeFile(join(duplicate, 'two.mjs'), "export const id = 'same';\nexport const apply = () => {};\n");
  await assert.rejects(study.loadModuleDefinitions(duplicate), error => {
    assert.equal(error.code, 'invalid');
    assert.match(error.message, /重复/);
    return true;
  });

  const cyclic = await mkdtemp(join(tmpdir(), 'study-modules-'));
  t.after(() => rm(cyclic, { recursive: true, force: true }));
  await writeFile(join(cyclic, 'x.mjs'), "export const id = 'x';\nexport const deps = ['y'];\nexport const apply = () => {};\n");
  await writeFile(join(cyclic, 'y.mjs'), "export const id = 'y';\nexport const deps = ['x'];\nexport const apply = () => {};\n");
  await assert.rejects(study.loadModuleDefinitions(cyclic), error => {
    assert.equal(error.code, 'invalid');
    assert.match(error.message, /成环/);
    return true;
  });
});

test('module definitions with a bad id or no apply function are rejected', async t => {
  const badId = await mkdtemp(join(tmpdir(), 'study-modules-'));
  t.after(() => rm(badId, { recursive: true, force: true }));
  await writeFile(join(badId, 'bad.mjs'), "export const id = 'Bad Id';\nexport const apply = () => {};\n");
  await assert.rejects(study.loadModuleDefinitions(badId), error => error.code === 'invalid' && /id/.test(error.message));

  const noApply = await mkdtemp(join(tmpdir(), 'study-modules-'));
  t.after(() => rm(noApply, { recursive: true, force: true }));
  await writeFile(join(noApply, 'noapply.mjs'), "export const id = 'noapply';\n");
  await assert.rejects(study.loadModuleDefinitions(noApply), error => error.code === 'invalid' && /apply/.test(error.message));
});
