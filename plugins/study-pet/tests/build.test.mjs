import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import {
  BUNDLE_ID,
  ENTRY_FILE,
  OUTPUT_FILE,
  PLUGIN_ROOT,
  buildClient,
  loadEsbuild,
  wrapBundle,
} from '../scripts/build-client.mjs';

/** @param {string} source @returns {string[]} Bare module requests in the bundle. */
function externalRequests(source) {
  return [...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]);
}

/**
 * Read the pixel size from a PNG IHDR chunk.
 * @param {Buffer} buffer - PNG bytes.
 * @returns {{ width: number, height: number }} Image size.
 */
function pngSize(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('pet client build', () => {
  it('wraps the bundle in the module-loader handoff with the package id', () => {
    const wrapped = wrapBundle('exports.inject = [];');
    assert.match(wrapped, /window\.__ModuleLoader__\.load\(\{/);
    assert.ok(wrapped.includes(`id: ${JSON.stringify(BUNDLE_ID)}`));
    assert.match(wrapped, /factory\(require\)/);
    assert.ok(wrapped.endsWith('\n'));
  });

  it('declares the DSH client manifest the Loader resolves', async () => {
    const manifest = JSON.parse(await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    assert.equal(manifest.name, BUNDLE_ID);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.exports['.'], './host/index.mjs');
    assert.equal(manifest.exports['./client'], './client/client.js');
    assert.equal(manifest.dsh.client.platform, 'web');
    for (const name of [
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-locale',
    ]) {
      assert.ok(manifest.dsh.client.inject.includes(name), `inject lists ${name}`);
    }
  });

  it('ships the user-selected plush logo1 asset at 451x423', async () => {
    const source = await readFile(join(PLUGIN_ROOT, 'client/assets/logo1.png'));
    const size = pngSize(source);
    assert.deepEqual(size, { width: 451, height: 423 });
    assert.ok(source.length > 100_000, `logo1 is a full plush render: ${source.length} bytes`);
  });

  it('builds a self-contained bundle with the logo1 data URL and no SVG figure', async (t) => {
    try {
      loadEsbuild();
    } catch (error) {
      t.skip(`esbuild unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const result = await buildClient({ write: false });
    assert.ok(result.bytes > 150_000, `bundle is unexpectedly small: ${result.bytes} bytes`);
    assert.ok(result.source.includes(BUNDLE_ID));
    assert.ok(result.source.includes('data-study-pet'), 'registers the overlay attribute');
    assert.ok(result.source.includes('data-study-pet-bubble'), 'ships the bubble surface');
    assert.match(result.source, /data:image\/png;base64,[A-Za-z0-9+/=]+/, 'logo1 is inlined as a data URL');
    assert.ok(result.source.includes('sp-photo'), 'renders the plush image');
    assert.equal(result.source.includes('viewBox'), false, 'the hand-drawn SVG figure is gone');
    const requests = externalRequests(result.source);
    assert.deepEqual([...new Set(requests)], ['react'], `external modules: ${requests.join(', ')}`);

    const committed = await readFile(OUTPUT_FILE, 'utf8').catch(() => null);
    if (committed !== null) {
      assert.equal(committed, result.source, 'client/client.js is stale; run node plugins/study-pet/scripts/build-client.mjs');
    }
  });

  it('wires one React entry that exports inject and apply', async () => {
    const entry = await readFile(ENTRY_FILE, 'utf8');
    assert.match(entry, /export const inject/);
    assert.match(entry, /export function apply/);
    assert.match(entry, /createPlugin/);
  });
});
