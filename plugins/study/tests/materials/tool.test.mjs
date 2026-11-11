import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { boot } from './helpers.mjs';

const MATERIAL_ROUTES = [
  '/api/study/materials/saveGoal',
  '/api/study/materials/getGoal',
  '/api/study/materials/listGoals',
  '/api/study/materials/importText',
  '/api/study/materials/importFile',
  '/api/study/materials/updateMaterial',
  '/api/study/materials/deleteMaterial',
  '/api/study/materials/list',
  '/api/study/materials/get',
  '/api/study/materials/outline',
  '/api/study/materials/chunks',
  '/api/study/materials/search',
  '/api/study/materials/locate',
];

test('the plugin serves every materials method and exposes the tool', async t => {
  const harness = await boot(t);
  // Other modules register their own tools here, so assert this module's contribution instead of the whole list.
  assert.ok(harness.tools.some(tool => tool.name === 'study_status'));
  const materialsTool = harness.tools.find(tool => tool.name === 'study_materials');
  assert.ok(materialsTool);
  assert.deepEqual(materialsTool.parameters.properties.action.enum, ['search', 'import_text', 'list']);
  for (const path of MATERIAL_ROUTES) {
    assert.ok(harness.routes.some(route => route.path === path), `missing route ${path}`);
  }
});

test('the HTTP route answers the search envelope', async t => {
  const harness = await boot(t);
  await harness.ok('importText', { kind: 'notes', title: '笔记', text: '导数的几何意义。' });

  const route = harness.routes.find(item => item.path === '/api/study/materials/search');
  const response = await route.fetch(new Request('http://localhost/api/study/materials/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '导数' }),
  }));
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.ok, true);
  assert.equal(envelope.value.hits.length, 1);
  assert.equal(envelope.value.hits[0].title, '笔记');
});

test('the tool reads the same facts as the service for search and list', async t => {
  const harness = await boot(t);
  await harness.ok('importText', { kind: 'textbook', title: '数学分析', text: '极限的定义与性质。' });

  const searched = await harness.tool({ action: 'search', query: '极限' });
  const service = await harness.ok('search', { query: '极限' });
  assert.deepEqual(searched, service);

  const listed = await harness.tool({ action: 'list' });
  const serviceList = await harness.ok('list', {});
  assert.deepEqual(listed, serviceList);
});

test('the tool imports pasted text as the agent actor', async t => {
  const harness = await boot(t);
  const imported = await harness.tool({
    action: 'import_text',
    kind: 'workbook',
    title: '练习册',
    chapter: '第二章 导数',
    text: '第一题：求导。',
  });
  assert.equal(imported.material.title, '练习册');
  assert.equal(imported.chunkCount, 1);
  assert.equal(imported.material.source.kind, 'pasted');

  const database = new DatabaseSync(join(harness.directory, 'study.db'), { readOnly: true });
  try {
    const rows = database.prepare("SELECT actor, entity, action FROM change_log WHERE entity = 'material' ORDER BY id").all();
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0] }, { actor: 'agent', entity: 'material', action: 'import' });
  } finally {
    database.close();
  }

  const found = await harness.tool({ action: 'search', query: '求导' });
  assert.equal(found.hits.length, 1);
});

test('the tool reports service failures and rejects unknown actions', async t => {
  const harness = await boot(t);
  await assert.rejects(async () => harness.tool({ action: 'search' }), /query/);
  await assert.rejects(async () => harness.tool({ action: 'import_text', title: '空', text: '   ' }), /空|文字|内容/);
  await assert.rejects(async () => harness.tool({ action: 'delete_everything' }), /invalid arguments/);
});
