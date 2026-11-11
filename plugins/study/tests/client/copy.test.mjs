/**
 * Copy audit: user-visible text of the client tree lives in the dictionary
 * modules, never inline. Chinese characters outside `client/messages/` mean a
 * hardcoded string escaped the locale pass.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { mergeMessages } from '../../client/lib/definitions.js';

const CLIENT_ROOT = fileURLToPath(new URL('../../client/', import.meta.url));
const CJK = /[\u3400-\u9fff]/;

/**
 * Collect the hand-written modules that render copy, skipping dictionaries,
 * the generated bundle, and `lib/` (whose Chinese text is developer
 * diagnostics thrown as errors, not rendered strings).
 * @param {string} directory - Directory to walk.
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'messages' || entry.name === '.build' || entry.name === 'lib') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
      continue;
    }
    if (entry.name.endsWith('.js') && entry.name !== 'client.js') files.push(path);
  }
  return files;
}

describe('client copy', () => {
  it('keeps every page, action and plugin module free of inline Chinese', async () => {
    const offenders = [];
    for (const file of await sourceFiles(CLIENT_ROOT)) {
      if (CJK.test(await readFile(file, 'utf8'))) offenders.push(relative(CLIENT_ROOT, file));
    }
    assert.deepEqual(offenders, [], `这些文件把中文写死在代码里，请移到 client/messages：${offenders.join('、')}`);
  });

  it('ships an en and a zh dictionary with identical keys', async () => {
    const names = (await readdir(join(CLIENT_ROOT, 'messages'))).filter(name => name.endsWith('.js')).sort();
    const modules = [];
    for (const name of names) {
      const module = await import(new URL(`../../client/messages/${name}`, import.meta.url).href);
      modules.push({ file: name.slice(0, -'.js'.length), dictionary: module.default });
    }
    const merged = mergeMessages(modules);
    assert.deepEqual(Object.keys(merged.en).sort(), Object.keys(merged.zh).sort());
    assert.ok(Object.keys(merged.zh).length > 0);
  });
});
