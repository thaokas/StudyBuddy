// Fetch official Breakpad symbols, verifying the release's SHA-256 before extraction.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const evidence = dirname(fileURLToPath(import.meta.url));
const source = resolve(evidence, ...Array(7).fill('..'), 'source/deepseek-harness');
const root = join(source, 'apps/desktop/.desktop-build/a01/electron-symbols');
await mkdir(root, { recursive: true });
const base = 'https://github.com/electron/electron/releases/download/v44.7.0/';
const name = 'electron-v44.7.0-win32-x64-symbols.zip';
const sumsResponse = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(30000) });
if (!sumsResponse.ok) throw new Error(`Checksums HTTP ${sumsResponse.status}`);
const sums = await sumsResponse.text();
const expected = sums.split(/\r?\n/).find((line) => line.endsWith(name))?.split(/\s+/)[0];
if (!expected) throw new Error('Missing official checksum');
const file = join(root, name);
if (!existsSync(file)) {
  const response = await fetch(base + name, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Symbols HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file, { flags: 'wx' }));
}
const hash = createHash('sha256');
for await (const bytes of createReadStream(file)) hash.update(bytes);
const actual = hash.digest('hex');
if (actual !== expected) throw new Error('Symbol archive checksum mismatch');
const require = createRequire(join(source, 'package.json'));
await require('extract-zip')(file, { dir: join(root, 'extracted') });
const report = { root, url: base + name, expected, actual, files: await readdir(join(root, 'extracted')) };
await writeFile(join(evidence, 'electron-symbols.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
