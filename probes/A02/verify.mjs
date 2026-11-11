/** Recompute A02 evidence checks without model calls or printing credential values. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { authorizedKey } from './credentials.mjs';
const probe = dirname(fileURLToPath(import.meta.url));
const project = resolve(probe, '../..');
const source = join(project, 'source/deepseek-harness');
const evidence = join(project, 'docs/superpowers/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02');
const taskFile = resolve(evidence, '../../A02-dsh-extension-spike.md');
const pin = JSON.parse(await readFile(join(evidence, '../A01/baseline.lock.json'), 'utf8'));
const git = args => spawnSync('git', ['-c', `safe.directory=${source.replaceAll('\\', '/')}`, '-C', source, ...args], { encoding: 'utf8', windowsHide: true });
const report = { checkedAt: new Date().toISOString(), passed: false, checks: {} };
try {
  const head = git(['rev-parse', 'HEAD']);
  assert.equal(head.status, 0);
  assert.equal(head.stdout.trim(), pin.source.commit);
  report.checks.commit = head.stdout.trim();
  const status = git(['status', '--porcelain']);
  assert.equal(status.status, 0);
  assert.equal(status.stdout.trim(), '');
  report.checks.upstreamWorktreeClean = true;
  report.checks.hashes = {};
  for (const [name, expected] of Object.entries(pin.sha256)) {
    const actual = createHash('sha256').update(await readFile(join(source, name))).digest('hex').toUpperCase();
    assert.equal(actual, expected);
    report.checks.hashes[name] = actual;
  }
  report.checks.results = {};
  const passed = ['ui-result.json', 'cancel-result.json', 'attachment-result.json', 'resume-ui-result.json', 'interfaces-result.json',
    'native-result.json', 'credentials-result.json', 'desktop-ui-result.json', 'desktop-settings-result.json', 'desktop-attachment-result.json',
    'real-ui-result.json', 'real-extra-result.json', 'real-resume-result.json', 'desktop-real-result.json', 'desktop-real-resume-result.json'];
  for (const name of passed) {
    const result = JSON.parse(await readFile(join(evidence, name), 'utf8'));
    assert.equal(result.passed, true, name);
    assert.ok(result.root.startsWith(join(source, 'apps/desktop/.desktop-build/a02')), name);
    report.checks.results[name] = true;
  }
  const model = JSON.parse(await readFile(join(evidence, 'official-model.json'), 'utf8'));
  assert.equal(model.id, 'deepseek-flash');
  assert.equal(model.datedRevisionConfirmed, false);
  report.checks.model = model;
  const build = await readFile(join(evidence, 'build-check.log'), 'utf16le');
  assert.ok(/2 passed, 0 failed, 0 skipped/.test(build));
  report.checks.buildCheck = '2 passed, 0 failed, 0 skipped';
  const key = await authorizedKey();
  assert.ok(key);
  const secretHits = [];
  let scanned = 0;
  for (const directory of [evidence, probe]) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(json|log|md|mjs|js|html)$/.test(entry.name)) continue;
      const file = join(directory, entry.name);
      const bytes = await readFile(file);
      if (bytes.includes(Buffer.from(key))) secretHits.push(relative(project, file));
      scanned++;
    }
  }
  assert.deepEqual(secretHits, []);
  assert.ok(!(await readFile(taskFile)).includes(Buffer.from(key)));
  const real = JSON.parse(await readFile(join(evidence, 'real-ui-result.json'), 'utf8'));
  const newCredentials = join(real.root, 'home/.credentials.yaml');
  assert.ok(!existsSync(newCredentials) || !(await readFile(newCredentials)).includes(Buffer.from(key)));
  report.checks.credentialSafety = { textFilesScanned: scanned, realKeyMatches: 0, realKeyPersistedInOfficialProfile: false, sourceCredentialDocumentExported: false };
  let syntaxCount = 0;
  for (const name of await readdir(probe)) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', join(probe, name)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    syntaxCount++;
  }
  report.checks.syntaxFiles = syntaxCount;
  let linkCount = 0;
  for (const file of [taskFile, join(probe, 'README.md'), ...['extension-map.md', 'validation-matrix.md', 'commands.md'].map(name => join(evidence, name))]) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(file), target)), `${relative(project, file)}: ${target}`);
      linkCount++;
    }
  }
  report.checks.relativeLinks = linkCount;
  const processes = JSON.parse((await readFile(join(evidence, 'process-check.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(processes.ownedProcessesRemaining, 0);
  report.checks.ownedProcessesRemaining = 0;
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
await writeFile(join(evidence, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
