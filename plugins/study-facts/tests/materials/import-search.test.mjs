import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localDate } from '../../../study-core/host/kernel.mjs';
import { boot } from './helpers.mjs';

const MARKDOWN = [
  '# 第一章 函数',
  '',
  '函数是集合之间的映射。',
  '',
  '--- 第 2 页 ---',
  '',
  '## 1.1 极限',
  '',
  '极限描述自变量趋近时函数值的变化。',
  '函数极限的计算依赖定义域，习题 2.3 求下列函数的极限。',
].join('\n');

async function importMarkdown(harness, overrides = {}) {
  return harness.ok('importText', {
    kind: 'textbook',
    title: '数学分析',
    edition: '第三版',
    subject: '数学',
    format: 'markdown',
    text: MARKDOWN,
    sourceDate: '2026-11-01',
    ...overrides,
  });
}

test('an imported markdown excerpt is chunked with the locators its own text proves', async t => {
  const harness = await boot(t);
  const imported = await importMarkdown(harness);

  assert.equal(imported.material.title, '数学分析');
  assert.equal(imported.material.kind, 'textbook');
  assert.equal(imported.material.edition, '第三版');
  assert.equal(imported.material.subject, '数学');
  assert.equal(imported.material.format, 'markdown');
  assert.equal(imported.material.verification, 'unverified');
  assert.equal(imported.material.source.kind, 'pasted');
  assert.equal(imported.material.source.date, '2026-11-01');
  assert.equal(imported.chunkCount, 2);
  assert.deepEqual(imported.material.toc.map(entry => entry.title), ['第一章 函数', '1.1 极限']);
  assert.deepEqual(imported.material.toc.map(entry => entry.index), [1, 2]);
  assert.equal(imported.material.toc[1].page, 2);
  assert.equal(imported.material.toc[1].chunkCount, 1);
  // Nothing in the excerpt proves a page for its first chapter.
  assert.deepEqual(imported.material.missing, ['page']);

  const chunks = await harness.ok('chunks', { materialId: imported.material.id });
  assert.equal(chunks.total, 2);
  const [first, second] = chunks.items;
  assert.equal(first.chapter, '第一章 函数');
  assert.equal(first.page, null);
  assert.deepEqual(first.unverified, ['page']);
  assert.equal(first.locatorSource, 'detected');
  assert.equal(first.sourceDate, '2026-11-01');
  assert.equal(second.chapter, '1.1 极限');
  assert.equal(second.chapterIndex, 2);
  assert.equal(second.page, 2);
  assert.deepEqual(second.unverified, []);
  assert.match(second.text, /习题 2\.3/);
});

test('search returns the imported text with a citation back to its source', async t => {
  const harness = await boot(t);
  const imported = await importMarkdown(harness);

  const result = await harness.ok('search', { query: '极限' });
  assert.equal(result.matchMode, 'lexical');
  assert.deepEqual(result.tokens, ['极限']);
  assert.equal(result.hits.length, 1);
  const [hit] = result.hits;
  assert.equal(hit.materialId, imported.material.id);
  assert.equal(hit.title, '数学分析');
  assert.equal(hit.locator.chapter, '1.1 极限');
  assert.equal(hit.locator.page, 2);
  assert.deepEqual(hit.unverified, []);
  assert.equal(hit.sourceDate, '2026-11-01');
  assert.equal(hit.verification, 'unverified');
  assert.match(hit.citation, /《数学分析》/);
  assert.match(hit.citation, /1\.1 极限/);
  assert.match(hit.citation, /第2页/);
  assert.match(hit.citation, /2026-11-01/);
  assert.match(hit.snippet, /极限/);

  const other = await harness.ok('search', { query: '函数' });
  assert.equal(other.hits.length, 2);
  const uncited = other.hits.find(item => item.locator.chapter === '第一章 函数');
  assert.match(uncited.citation, /页码未核实/);
  assert.deepEqual(uncited.unverified, ['page']);
});

test('text without page or chapter markers is reported as unverified, never filled in', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importText', {
    kind: 'notes',
    title: '课堂笔记',
    text: '这是没有页眉页脚的课堂笔记，讲到了导数的几何意义。',
  });

  assert.deepEqual(imported.material.toc, []);
  assert.deepEqual(imported.material.missing, ['edition', 'toc', 'page', 'chapter']);
  const chunks = await harness.ok('chunks', { materialId: imported.material.id });
  assert.equal(chunks.items[0].page, null);
  assert.equal(chunks.items[0].chapter, null);
  assert.equal(chunks.items[0].chapterIndex, null);
  assert.equal(chunks.items[0].locatorSource, 'none');
  assert.deepEqual(chunks.items[0].unverified, ['page', 'chapter']);

  const { hits } = await harness.ok('search', { query: '导数' });
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].unverified, ['page', 'chapter']);
  assert.match(hits[0].citation, /章节与页码未核实/);

  const chapter = await harness.ok('locate', { materialId: imported.material.id, chapter: '第三章' });
  assert.equal(chapter.verification, 'unverified');
  assert.deepEqual(chapter.unverified, ['chapter']);
  assert.match(chapter.reason, /第三章/);

  const page = await harness.ok('locate', { materialId: imported.material.id, page: 3 });
  assert.deepEqual(page.unverified, ['page']);
  assert.match(page.reason, /页码/);

  const exercise = await harness.ok('locate', { materialId: imported.material.id, exercise: '3.2' });
  assert.deepEqual(exercise.unverified, ['exercise']);
  assert.match(exercise.reason, /3\.2/);
});

test('locate confirms a chapter, page, and exercise number only when the text contains them', async t => {
  const harness = await boot(t);
  const imported = await importMarkdown(harness);

  const chapter = await harness.ok('locate', { materialId: imported.material.id, chapter: '第一章' });
  assert.equal(chapter.verification, 'verified');
  assert.equal(chapter.matches.chapter.title, '第一章 函数');
  assert.equal(chapter.matches.chapter.index, 1);

  const page = await harness.ok('locate', { materialId: imported.material.id, page: 2 });
  assert.equal(page.verification, 'verified');
  assert.equal(page.matches.page.chunkIds.length, 1);

  const exercise = await harness.ok('locate', { materialId: imported.material.id, exercise: '2.3' });
  assert.equal(exercise.verification, 'verified');
  assert.match(exercise.matches.exercise.excerpt, /习题 2\.3/);

  const missing = await harness.ok('locate', { materialId: imported.material.id, exercise: '9.9', chapter: '第一章' });
  assert.equal(missing.verification, 'partial');
  assert.deepEqual(missing.unverified, ['exercise']);

  const outside = await harness.ok('locate', { materialId: imported.material.id, page: 40 });
  assert.equal(outside.verification, 'unverified');
  assert.deepEqual(outside.unverified, ['page']);
  assert.match(outside.reason, /页码范围/);
});

test('a long paragraph is split into chunks no larger than the requested size', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importText', {
    kind: 'notes',
    title: '长笔记',
    text: '极限的定义。'.repeat(400),
    maxChunkChars: 300,
  });
  assert.ok(imported.chunkCount >= 8, `expected several chunks, got ${imported.chunkCount}`);

  const chunks = await harness.ok('chunks', { materialId: imported.material.id, limit: 50 });
  assert.equal(chunks.items.length, imported.chunkCount);
  for (const chunk of chunks.items) {
    assert.ok(chunk.text.length <= 300, `chunk ${chunk.ordinal} is ${chunk.text.length} chars`);
  }
  assert.deepEqual(chunks.items.map(chunk => chunk.ordinal), Array.from({ length: imported.chunkCount }, (_value, index) => index));
});

test('the outline reports chapter coverage and page gaps', async t => {
  const harness = await boot(t);
  const imported = await importMarkdown(harness);

  const outline = await harness.ok('outline', { materialId: imported.material.id });
  assert.equal(outline.title, '数学分析');
  assert.equal(outline.chunkCount, 2);
  assert.deepEqual(outline.chapters.map(chapter => [chapter.title, chapter.page]), [['第一章 函数', null], ['1.1 极限', 2]]);
  assert.deepEqual(outline.chapters.map(chapter => chapter.chunkCount), [1, 1]);
  assert.deepEqual(outline.pages, { known: 1, unknown: 1, min: 2, max: 2 });
  assert.deepEqual(outline.missing, ['page']);
});

test('deleting a material removes its chunks from search and from reads', async t => {
  const harness = await boot(t);
  const imported = await importMarkdown(harness);
  assert.equal((await harness.ok('search', { query: '极限' })).hits.length, 1);

  const removed = await harness.ok('deleteMaterial', { materialId: imported.material.id });
  assert.equal(removed.deleted, true);
  assert.equal(removed.removedChunks, 2);

  const after = await harness.ok('search', { query: '极限' });
  assert.deepEqual(after.hits, []);
  assert.deepEqual((await harness.ok('list', {})).materials, []);
  assert.equal((await harness.fail('get', { materialId: imported.material.id })).code, 'not_found');
  assert.equal((await harness.fail('chunks', { materialId: imported.material.id })).code, 'not_found');

  const goals = await harness.ok('list', { includeDeleted: true });
  assert.equal(goals.materials.length, 1);
  assert.ok(goals.materials[0].deletedAt);
});

test('importing twice with one requestId keeps one material, and new content conflicts', async t => {
  const harness = await boot(t);
  const payload = { kind: 'notes', title: '笔记', text: '导数的几何意义。' };

  const first = await harness.call('importText', payload, { requestId: 'import-once', actor: 'agent' });
  assert.equal(first.ok, true);
  const replay = await harness.call('importText', payload, { requestId: 'import-once', actor: 'agent' });
  assert.deepEqual(replay, first);

  const list = await harness.ok('list', {});
  assert.equal(list.materials.length, 1);
  assert.equal(list.materials[0].chunkCount, 1);

  const conflict = await harness.call('importText', { ...payload, text: '另一段话。' }, { requestId: 'import-once', actor: 'agent' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');
});

test('import payloads are validated with an actionable reason', async t => {
  const harness = await boot(t);

  const empty = await harness.fail('importText', { kind: 'notes', title: '空', text: '   \n  ' });
  assert.equal(empty.code, 'invalid');
  assert.equal(empty.details.reason, 'empty_text');

  const kind = await harness.fail('importText', { kind: 'novel', title: '书', text: '内容' });
  assert.equal(kind.code, 'invalid');
  assert.equal(kind.details.field, 'kind');

  const format = await harness.fail('importText', { kind: 'notes', title: '书', text: '内容', format: 'pdf' });
  assert.equal(format.code, 'invalid');
  assert.match(format.message, /importFile/);

  const chunkSize = await harness.fail('importText', { kind: 'notes', title: '书', text: '内容', maxChunkChars: 10 });
  assert.equal(chunkSize.details.field, 'maxChunkChars');

  const goal = await harness.fail('importText', { kind: 'notes', title: '书', text: '内容', goalId: 'goal_missing' });
  assert.equal(goal.code, 'not_found');

  assert.deepEqual((await harness.ok('list', {})).materials, []);
});

test('a declared chapter labels an excerpt that has no heading, and stays unverified for pages', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importText', {
    kind: 'workbook',
    title: '配套练习册',
    chapter: '第五章 导数',
    text: '第一题：求下列函数的导数。\n第二题：求切线方程。',
  });

  assert.deepEqual(imported.material.toc.map(entry => [entry.title, entry.source]), [['第五章 导数', 'declared']]);
  assert.deepEqual(imported.material.missing, ['edition', 'page']);
  const chunks = await harness.ok('chunks', { materialId: imported.material.id });
  assert.equal(chunks.items[0].chapter, '第五章 导数');
  assert.equal(chunks.items[0].chapterIndex, null);
  assert.equal(chunks.items[0].locatorSource, 'declared');
  assert.deepEqual(chunks.items[0].unverified, ['page']);
});

test('a goal owns its materials and filters both list and search', async t => {
  const harness = await boot(t);
  const goal = (await harness.ok('saveGoal', { exam: '考研数学一' })).goal;
  const other = (await harness.ok('saveGoal', { exam: '英语四级' })).goal;

  await harness.ok('importText', { goalId: goal.id, kind: 'textbook', title: '数学分析', text: '函数极限的定义。' });
  await harness.ok('importText', { goalId: other.id, kind: 'textbook', title: '英语词汇', text: '函数在英语里叫 function。' });

  const filtered = await harness.ok('list', { goalId: goal.id });
  assert.deepEqual(filtered.materials.map(material => material.title), ['数学分析']);

  const hits = await harness.ok('search', { query: '函数', goalId: goal.id });
  assert.equal(hits.hits.length, 1);
  assert.equal(hits.hits[0].title, '数学分析');
});

test('search is also reachable under a different spelling and matches ASCII words', async t => {
  const harness = await boot(t);
  await harness.ok('importText', { kind: 'notes', title: '术语', text: '函数（function）与映射的关系。' });

  const ascii = await harness.ok('search', { query: 'function' });
  assert.equal(ascii.hits.length, 1);
  assert.deepEqual(ascii.tokens, ['function']);

  // A one-character Chinese query cannot use bigram tokens; it falls back to substring matching.
  const single = await harness.ok('search', { query: '映' });
  assert.equal(single.matchMode, 'substring');
  assert.equal(single.hits.length, 1);
  assert.match(single.notice, /包含/);

  // Punctuation-only queries have nothing to look for.
  const empty = await harness.fail('search', { query: '……' });
  assert.equal(empty.code, 'invalid');
});

test('search paginates and reports whether more hits exist', async t => {
  const harness = await boot(t);
  for (let index = 0; index < 3; index += 1) {
    await harness.ok('importText', { kind: 'notes', title: `笔记 ${index}`, text: `第${index}份笔记：导数的定义。` });
  }

  const first = await harness.ok('search', { query: '导数', limit: 2 });
  assert.equal(first.hits.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 2);

  const second = await harness.ok('search', { query: '导数', limit: 2, offset: 2 });
  assert.equal(second.hits.length, 1);
  assert.equal(second.hasMore, false);
  const titles = [...first.hits, ...second.hits].map(hit => hit.title).sort();
  assert.deepEqual(titles, ['笔记 0', '笔记 1', '笔记 2']);
});

test('imported materials and their index survive a plugin restart', async t => {
  const first = await boot(t);
  const imported = await first.ok('importText', { kind: 'textbook', title: '数学分析', text: '极限的定义。' });
  assert.equal((await first.ok('search', { query: '极限' })).hits.length, 1);
  await first.fiber.dispose();

  // Reopening verifies the recorded module schema against this build before serving anything.
  const second = await boot(t, { directory: first.directory });
  const hits = await second.ok('search', { query: '极限' });
  assert.equal(hits.hits.length, 1);
  assert.equal(hits.hits[0].materialId, imported.material.id);
  const material = await second.ok('get', { materialId: imported.material.id });
  assert.equal(material.material.title, '数学分析');
  assert.equal(material.material.chunkCount, 1);
  await second.fiber.dispose();
});

test('the imported text is stored with today as its source date by default', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importText', { kind: 'notes', title: '今天的笔记', text: '今天的复习内容。' });
  assert.equal(imported.material.source.date, localDate());
});
