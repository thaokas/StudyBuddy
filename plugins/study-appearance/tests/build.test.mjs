import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  BUNDLE_ID,
  OUTPUT_FILE,
  PLUGIN_ROOT,
  buildClient,
  loadEsbuild,
  wrapBundle,
} from '../scripts/build-client.mjs';

describe('appearance client build', () => {
  it('wraps the bundle in the module-loader handoff with the package id', () => {
    const wrapped = wrapBundle('exports.inject = [];');
    assert.match(wrapped, /window\.__ModuleLoader__\.load\(\{/);
    assert.ok(wrapped.includes(`id: "${BUNDLE_ID}"`));
    assert.match(wrapped, /factory\(require\)/);
  });

  it('ships the plush portrait and its derived head crop, not the retired mark', async () => {
    const assets = await readdir(join(PLUGIN_ROOT, 'client', 'assets'));
    assert.ok(assets.includes('logo1.png'), 'the full plush portrait must ship');
    assert.ok(assets.includes('logo1-head.png'), 'the derived sidebar head crop must ship');
    assert.equal(assets.includes('logo-start.png'), false, 'the retired MVP mark must not ship');
  });

  it('builds a bundle carrying the palette packs, top-bar rule, logo data and loader id', async (t) => {
    try {
      loadEsbuild();
    } catch (error) {
      t.skip(`esbuild unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const result = await buildClient({ write: false });
    // Two inline PNGs (the full portrait plus the head crop) dominate the bundle.
    assert.ok(result.bytes > 100000, `bundle is unexpectedly small: ${result.bytes} bytes`);
    assert.ok(result.source.includes(BUNDLE_ID));
    const inlineImages = result.source.match(/data:image\/png;base64,/g) ?? [];
    assert.ok(inlineImages.length >= 2, `expected the portrait and head crop inlined, found ${inlineImages.length}`);
    // One light surface, one dark surface, the shared light/dark accents, and the
    // plugin-owned top-bar token plus its selector must reach the browser.
    for (const marker of ['#FBF7EC', '#0F1A2A', '#3F6B26', '#86B4FF', '#4E7FD8', '#3F6FC4', '--study-topbar', 'header[data-window-drag]']) {
      assert.ok(result.source.includes(marker), `bundle is missing ${marker}`);
    }
    for (const pack of ['sprout-paper', 'mint-mist', 'celadon-page', 'deep-sea', 'midnight-indigo', 'starry-blue']) {
      assert.ok(result.source.includes(pack), `bundle is missing pack ${pack}`);
    }

    const committed = await readFile(OUTPUT_FILE, 'utf8').catch(() => null);
    if (committed !== null) {
      assert.equal(committed, result.source, 'client/client.js is stale; run node plugins/study-appearance/scripts/build-client.mjs');
    }
  });
});
