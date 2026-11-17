/**
 * Build pipeline behavior: contribution discovery, the generated barrel, the
 * module-loader wrapper, and the served artifact's freshness.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  BUNDLE_ID, OUTPUT_FILE, buildClient, discoverContributions, loadEsbuild, renderBarrel, wrapBundle,
} from '../../scripts/build-client.mjs';

const roots = [];

/**
 * Create a throwaway client tree.
 * @param {Record<string, string[]>} layout - Directory name to file names (without `.js`).
 * @returns {Promise<string>} Absolute client root.
 */
async function fixture(layout) {
  const root = await mkdtemp(join(tmpdir(), 'study-client-'));
  roots.push(root);
  for (const [directory, names] of Object.entries(layout)) {
    await mkdir(join(root, directory), { recursive: true });
    for (const name of names) await writeFile(join(root, directory, `${name}.js`), 'export default {};\n');
  }
  return root;
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('discoverContributions', () => {
  it('lists each contribution directory in sorted order', async () => {
    const root = await fixture({ pages: ['today', 'alpha'], messages: ['common', 'today', 'alpha'], actions: ['refresh'] });
    assert.deepEqual(await discoverContributions(root), {
      pages: ['alpha', 'today'],
      messages: ['alpha', 'common', 'today'],
      actions: ['refresh'],
    });
  });

  it('treats a missing directory as empty', async () => {
    const root = await fixture({ pages: ['today'], messages: ['today'] });
    assert.deepEqual(await discoverContributions(root), { pages: ['today'], messages: ['today'], actions: [] });
  });

  it('rejects a page without a same-named dictionary module', async () => {
    const root = await fixture({ pages: ['today'], messages: ['common'] });
    await assert.rejects(discoverContributions(root), /每个页面都要有同名文案模块.*today/);
  });

  it('rejects a module file name the barrel would silently skip', async () => {
    const root = await fixture({ pages: ['Today'], messages: ['Today'] });
    await assert.rejects(discoverContributions(root), /文件名必须是小写字母开头/);
  });
});

describe('renderBarrel', () => {
  const barrel = renderBarrel({ pages: ['memory', 'today'], messages: ['common', 'today'], actions: ['refresh'] });

  it('imports every contribution in discovery order', () => {
    assert.match(barrel, /import page0 from '\.\.\/pages\/memory\.js';/);
    assert.match(barrel, /import page1 from '\.\.\/pages\/today\.js';/);
    assert.match(barrel, /import messages0 from '\.\.\/messages\/common\.js';/);
    assert.match(barrel, /import action0 from '\.\.\/actions\/refresh\.js';/);
    assert.match(barrel, /import \{ createPlugin \} from '\.\.\/plugin\.js';/);
  });

  it('passes file attributions the plugin validates against the definitions', () => {
    assert.match(barrel, /\{ file: "today", definition: page1 \}/);
    assert.match(barrel, /\{ file: "common", dictionary: messages0 \}/);
    assert.match(barrel, /\{ file: "refresh", definition: action0 \}/);
  });

  it('exports the two names the client module system reads', () => {
    assert.match(barrel, /export const inject = plugin\.inject;/);
    assert.match(barrel, /export const apply = plugin\.apply;/);
  });
});

describe('wrapBundle', () => {
  const wrapped = wrapBundle('module.exports = { apply() {} };\n');

  it('registers the package name the Loader row resolves', () => {
    assert.match(wrapped, /window\.__ModuleLoader__\.load\(\{/);
    assert.match(wrapped, new RegExp(`id: ${JSON.stringify(BUNDLE_ID).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('hands the bundle a CommonJS module scope and returns its exports', () => {
    assert.match(wrapped, /factory\(require\) \{/);
    assert.match(wrapped, /const module = \{ exports: \{\} \};/);
    assert.match(wrapped, /module\.exports = \{ apply\(\) \{\} \};/);
    assert.match(wrapped, /return module\.exports;/);
  });
});

describe('loadEsbuild', () => {
  it('finds an esbuild build function', () => {
    const esbuild = loadEsbuild();
    assert.equal(typeof esbuild.build, 'function');
    assert.match(esbuild.version, /^\d+\.\d+\.\d+$/);
  });
});

describe('buildClient', () => {
  it('serves an artifact that matches the current sources', async (t) => {
    try {
      loadEsbuild();
    } catch (error) {
      return t.skip(`esbuild 不可用：${error.message}`);
    }
    const root = await mkdtemp(join(tmpdir(), 'study-bundle-'));
    roots.push(root);
    const result = await buildClient({ outputFile: join(root, 'client.js') });
    const served = await readFile(OUTPUT_FILE, 'utf8');
    assert.equal(served, result.source, 'client/client.js 与当前源码不一致，请运行 node plugins/study-outcomes/scripts/build-client.mjs');
    assert.equal(result.contributions.pages.includes('today'), false, 'today belongs to core');
    assert.equal(result.contributions.pages.includes('workbench'), false, 'workbench belongs to facts');
    assert.ok(result.contributions.pages.includes('outcomes'));
    assert.match(result.source, /require\("react"\)/, 'react 必须外置，由宿主模块表提供');
  });
});
