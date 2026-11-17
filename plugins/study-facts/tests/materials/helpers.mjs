import { randomUUID } from 'node:crypto';
import { fixtureCaller } from '../../../../tests/support/write-fixture.mjs';
/**
 * Shared fixture for the materials tests: boot the shipped plugin against fake
 * host services (tools + connection) in a temporary data directory, and build
 * small PDF files whose structure the importer has to read.
 *
 * The plugin is booted through `host/index.mjs`, so these tests also exercise
 * module discovery and the real service contract rather than the module alone.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import * as study from '../../../../tests/support/composed-host.mjs';

const sourceDirectory = fileURLToPath(new URL('../../../../source/deepseek-harness/', import.meta.url));
const requireFromSource = createRequire(join(sourceDirectory, 'apps/cli/package.json'));
const { Context } = requireFromSource('@deepseek-ai/cordis');

function mountServices(ctx) {
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
  return { tools, routes };
}

/**
 * Boot the study plugin in a temporary data directory, or in an existing one to
 * test what a restart reads back.
 * @param {import('node:test').TestContext} t - Test context that owns teardown.
 * @param {{ directory?: string }} [options] - Existing data directory to reopen.
 * @returns {Promise<{ ctx: object, fiber: object, tools: Array<object>, routes: Array<object>, directory: string, call: Function, ok: Function, fail: Function, tool: Function }>}
 *   Harness handle: `call` returns the raw service envelope, `ok`/`fail` assert one,
 *   and `tool` executes the registered `study_materials` tool.
 */
export async function boot(t, { directory: existingDirectory } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'study-materials-'));
  const ctx = new Context();
  const { tools, routes } = mountServices(ctx);
  const fiber = ctx.plugin(study, { dataDir: directory });
  await fiber;
  t.after(async () => {
    try { await fiber.dispose(); } catch { /* Already disposed by the test. */ }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const fixtureCall = fixtureCaller((...args) => ctx.study.call(...args));
  const call = (method, payload, options) => fixtureCall('materials', method, payload, options);
  const ok = async (method, payload, options) => {
    const envelope = await call(method, payload, options);
    assert.equal(envelope.ok, true, `expected materials.${method} to succeed: ${JSON.stringify(envelope)}`);
    return envelope.value;
  };
  const fail = async (method, payload, options) => {
    const envelope = await call(method, payload, options);
    assert.equal(envelope.ok, false, `expected materials.${method} to fail: ${JSON.stringify(envelope)}`);
    return envelope;
  };
  const toolExecute = async args => {
    const definition = tools.find(item => item.name === 'study_materials');
    assert.ok(definition, 'study_materials tool should be registered');
    return definition.execute(args, { callId: randomUUID(), signal: new AbortController().signal });
  };
  const toolNamed = async (name, args, exec = {}) => {
    const definition = tools.find(item => item.name === name);
    assert.ok(definition, `${name} tool should be registered`);
    return definition.execute(args, {
      callId: exec.callId ?? randomUUID(),
      signal: exec.signal ?? new AbortController().signal,
    });
  };
  return { ctx, fiber, tools, routes, directory, call, ok, fail, tool: toolExecute, toolNamed };
}

/** Build one PDF file from object bodies; object 1 must be the catalog. */
export function buildPdf(objects, { trailer = '' } = {}) {
  const header = '%PDF-1.4\n';
  let body = '';
  objects.forEach((object, index) => {
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const trailerText = `trailer\n<< /Root 1 0 R /Size ${objects.length + 1}${trailer === '' ? '' : ` ${trailer}`} >>\n%%EOF\n`;
  return Buffer.from(header + body + trailerText, 'latin1');
}

/** Build a PDF from an explicit object-number map, so object numbers may have gaps. */
export function buildPdfFromMap(objects, { trailer = '' } = {}) {
  const numbers = [...objects.keys()].sort((left, right) => left - right);
  const header = '%PDF-1.4\n';
  let body = '';
  for (const number of numbers) body += `${number} 0 obj\n${objects.get(number)}\nendobj\n`;
  const size = (numbers.at(-1) ?? 0) + 1;
  const trailerText = `trailer\n<< /Root 1 0 R /Size ${size}${trailer === '' ? '' : ` ${trailer}`} >>\n%%EOF\n`;
  return Buffer.from(header + body + trailerText, 'latin1');
}

/**
 * Build a PDF that keeps the page tree, page, and font inside a compressed
 * object stream (as PDF 1.5+ writers do) and holds the content stream separately.
 * @param {string} line - Text shown on the page.
 */
export function objectStreamPdf(line) {
  const numbers = [3, 4, 6];
  const bodies = [
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let header = '';
  let payload = '';
  bodies.forEach((body, index) => {
    header += `${numbers[index]} ${payload.length} `;
    payload += `${body} `;
  });
  const compressed = deflateSync(Buffer.from(header + payload, 'latin1'));
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 3 0 R >>'],
    [2, `<< /Type /ObjStm /N 3 /First ${header.length} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n${compressed.toString('latin1')}\nendstream`],
    [5, streamObject(`BT /F1 12 Tf 72 720 Td (${line}) Tj ET`)],
  ]);
  return buildPdfFromMap(objects);
}

/** Wrap a content stream as a PDF stream object body. */
export function streamObject(content) {
  const length = Buffer.byteLength(content, 'latin1');
  return `<< /Length ${length} >>\nstream\n${content}\nendstream`;
}

/**
 * Build a PDF whose pages each show one ASCII line of text with a standard font.
 * @param {string[]} lines - One text line per page.
 */
export function textPdf(lines) {
  const fontId = 3 + lines.length * 2;
  const kids = lines.map((_line, index) => `${4 + index * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${lines.length} >>`,
  ];
  lines.forEach((line, index) => {
    objects.push(streamObject(`BT /F1 12 Tf 72 720 Td (${line}) Tj ET`));
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${3 + index * 2} 0 R >>`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  return buildPdf(objects);
}

/** Build a one-page PDF that only paints an image, like a scanned page. */
export function scannedPdf() {
  const image = '<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 16 >>\nstream\n0000000000000000\nendstream';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    streamObject('q 595 0 0 842 0 0 cm /Im1 Do Q'),
    image,
  ];
  return buildPdf(objects);
}

/**
 * Build a two-page PDF whose first page has a text layer and whose second page is image-only.
 * @param {string} line - Text shown on the first page.
 */
export function mixedPdf(line) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 8 0 R >> >> /Contents 4 0 R >>',
    streamObject(`BT /F1 12 Tf 72 720 Td (${line}) Tj ET`),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 7 0 R >> >> /Contents 6 0 R >>',
    streamObject('q 595 0 0 842 0 0 cm /Im1 Do Q'),
    '<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 16 >>\nstream\n0000000000000000\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  return buildPdf(objects);
}

/**
 * Build a one-page PDF whose text uses a two-byte identity encoding with no
 * ToUnicode CMap, the way some Chinese PDFs are written. The characters such a
 * font paints cannot be recovered, so the importer has to say so.
 */
export function cjkPdfWithoutUnicodeMap() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    streamObject('BT /F1 12 Tf 72 720 Td <00010002> Tj ET'),
    '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H >>',
  ];
  return buildPdf(objects);
}

/**
 * Build a one-page PDF whose text uses a two-byte identity encoding mapped by a
 * ToUnicode CMap, the way Chinese e-book PDFs carry a text layer.
 * @param {string} text - Characters to show; each one is mapped from a sequential code.
 */
export function cjkPdf(text) {
  const characters = [...text];
  const mappings = characters.map((character, index) => {
    const code = (index + 1).toString(16).toUpperCase().padStart(4, '0');
    const hex = character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    return `<${code}> <${hex}>`;
  });
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CMapName /StudyBuddy-Test-UCS def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${mappings.length} beginbfchar`,
    ...mappings,
    'endbfchar',
    'endcmap',
    'end',
    'end',
  ].join('\n');
  const codes = characters.map((_character, index) => (index + 1).toString(16).toUpperCase().padStart(4, '0')).join('');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    streamObject(`BT /F1 12 Tf 72 720 Td <${codes}> Tj ET`),
    '<< /Type /Font /Subtype /Type0 /BaseFont /StudyBuddySong /Encoding /Identity-H /ToUnicode 6 0 R >>',
    streamObject(cmap),
  ];
  return buildPdf(objects);
}
