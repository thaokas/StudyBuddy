import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { boot, buildPdf, cjkPdf, cjkPdfWithoutUnicodeMap, mixedPdf, objectStreamPdf, scannedPdf, textPdf } from './helpers.mjs';

function filePayload(name, bytes, overrides = {}) {
  return { kind: 'textbook', name, base64: bytes.toString('base64'), ...overrides };
}

test('a text-layer PDF is imported page by page', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importFile', filePayload('math-notes.pdf', textPdf([
    'Hello PDF page one about limits.',
    'Second page about derivatives.',
  ]), { title: '数学讲义' }));

  assert.equal(imported.material.title, '数学讲义');
  assert.equal(imported.material.format, 'pdf');
  assert.equal(imported.material.source.kind, 'file');
  assert.equal(imported.material.source.ref, 'math-notes.pdf');
  assert.equal(imported.chunkCount, 2);

  const chunks = await harness.ok('chunks', { materialId: imported.material.id });
  assert.deepEqual(chunks.items.map(chunk => chunk.page), [1, 2]);
  assert.deepEqual(chunks.items.map(chunk => chunk.unverified), [['chapter'], ['chapter']]);
  assert.match(chunks.items[0].text, /Hello PDF page one/);
  assert.match(chunks.items[1].text, /derivatives/);

  const { hits } = await harness.ok('search', { query: 'page one' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].locator.page, 1);
  assert.match(hits[0].citation, /第1页/);
  assert.deepEqual(imported.warnings, []);
});

test('pages kept inside a compressed object stream are still read', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importFile', filePayload('compressed.pdf', objectStreamPdf('Compressed object stream page.')));
  assert.equal(imported.chunkCount, 1);
  const chunks = await harness.ok('chunks', { materialId: imported.material.id });
  assert.match(chunks.items[0].text, /Compressed object stream page/);
  assert.equal(chunks.items[0].page, 1);
});

test('a Chinese PDF with a ToUnicode text layer is decoded through its CMap', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importFile', filePayload('中文教材.pdf', cjkPdf('第三极限')));

  const chunks = await harness.ok('chunks', { materialId: imported.material.id });
  assert.equal(chunks.items[0].text, '第三极限');
  assert.equal(chunks.items[0].page, 1);

  const { hits } = await harness.ok('search', { query: '极限' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, '中文教材');
});

test('a Chinese PDF without a Unicode map fails instead of importing gibberish', async t => {
  const harness = await boot(t);
  const result = await harness.fail('importFile', filePayload('无映射.pdf', cjkPdfWithoutUnicodeMap()));
  assert.equal(result.code, 'invalid');
  assert.equal(result.details.reason, 'pdf_text_encoding_unsupported');
  assert.ok(result.details.unsupportedFonts >= 1);
  assert.match(result.message, /Unicode/);
  assert.deepEqual((await harness.ok('list', {})).materials, []);
});

test('a text layer that mentions /Encrypt is not mistaken for an encrypted file', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importFile', filePayload('notes.pdf', textPdf(['The /Encrypt keyword appears on this page.'])));
  const chunks = await harness.ok('chunks', { materialId: imported.material.id });
  assert.match(chunks.items[0].text, /Encrypt/);
});

test('a scanned PDF fails with a reason the student can act on', async t => {
  const harness = await boot(t);
  const result = await harness.fail('importFile', filePayload('扫描件.pdf', scannedPdf()));
  assert.equal(result.code, 'invalid');
  assert.equal(result.details.reason, 'pdf_no_text_layer');
  assert.match(result.message, /文字层/);
  assert.match(result.message, /扫描/);
  assert.deepEqual((await harness.ok('list', {})).materials, []);
});

test('an encrypted PDF and a broken PDF fail with distinct reasons', async t => {
  const harness = await boot(t);

  const encrypted = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [] /Count 0 >>',
  ], { trailer: '/Encrypt 3 0 R' });
  const locked = await harness.fail('importFile', filePayload('locked.pdf', encrypted));
  assert.equal(locked.details.reason, 'pdf_encrypted');

  const broken = await harness.fail('importFile', filePayload('broken.pdf', Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF')));
  assert.equal(broken.details.reason, 'pdf_invalid');
  assert.ok(broken.details.hint);
});

test('a PDF with one image-only page imports the rest and warns about the gap', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importFile', filePayload('mixed.pdf', mixedPdf('Only page one has text.')));

  assert.equal(imported.chunkCount, 1);
  assert.equal(imported.warnings.length, 1);
  assert.equal(imported.warnings[0].code, 'pdf_pages_without_text');
  assert.deepEqual(imported.warnings[0].pages, [2]);
  assert.match(imported.warnings[0].message, /第 2 页/);

  const chunks = await harness.ok('chunks', { materialId: imported.material.id });
  assert.deepEqual(chunks.items.map(chunk => chunk.page), [1]);
});

test('a non-UTF-8 text file is decoded as GB18030 and the guess is reported', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importFile', filePayload('gbk.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4])));
  assert.equal(imported.warnings.length, 1);
  assert.equal(imported.warnings[0].code, 'decoded_as_gb18030');
  const chunks = await harness.ok('chunks', { materialId: imported.material.id });
  assert.equal(chunks.items[0].text, '中文');
});

test('file imports read the format from the name and refuse unsupported types', async t => {
  const harness = await boot(t);
  const markdown = Buffer.from('# 第一章 导数\n\n导数的定义。', 'utf8');
  const imported = await harness.ok('importFile', filePayload('chapter.md', markdown));
  assert.equal(imported.material.format, 'markdown');
  assert.deepEqual(imported.material.toc.map(entry => entry.title), ['第一章 导数']);
  assert.match(imported.material.title, /chapter/);

  const unsupported = await harness.fail('importFile', filePayload('course.docx', Buffer.from('PK\u0003\u0004', 'latin1')));
  assert.equal(unsupported.code, 'invalid');
  assert.equal(unsupported.details.reason, 'unsupported_file_type');

  const mismatch = await harness.fail('importFile', filePayload('book.pdf', textPdf(['text']), { format: 'text' }));
  assert.equal(mismatch.code, 'invalid');
  assert.equal(mismatch.details.reason, 'format_mismatch');
});

test('file imports accept a local path and report a missing one', async t => {
  const harness = await boot(t);
  const directory = await mkdtemp(join(tmpdir(), 'study-materials-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'notes.txt');
  await writeFile(path, '本地文件的极限笔记。', 'utf8');

  const imported = await harness.ok('importFile', { kind: 'notes', path });
  assert.equal(imported.material.source.ref, 'notes.txt');
  assert.equal(imported.material.title, 'notes');

  const missing = await harness.fail('importFile', { kind: 'notes', path: join(directory, 'absent.txt') });
  assert.equal(missing.code, 'not_found');

  const neither = await harness.fail('importFile', { kind: 'notes' });
  assert.equal(neither.details.field, 'path');
});

test('an update changes metadata and moves the verification flag', async t => {
  const harness = await boot(t);
  const imported = await harness.ok('importText', { kind: 'textbook', title: '数学分析', text: '极限的定义。' });
  assert.equal(imported.material.verification, 'unverified');

  const updated = await harness.ok('updateMaterial', {
    materialId: imported.material.id,
    edition: '第四版',
    verification: 'verified',
  });
  assert.equal(updated.material.edition, '第四版');
  assert.equal(updated.material.verification, 'verified');
  assert.ok(!updated.material.missing.includes('edition'));

  const missing = await harness.fail('updateMaterial', { materialId: 'mat_missing', title: 'x' });
  assert.equal(missing.code, 'not_found');
  const empty = await harness.fail('updateMaterial', { materialId: imported.material.id });
  assert.equal(empty.code, 'invalid');
});
