// Bounded native Electron --version diagnostics; no DSH profile/model is launched.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidence = dirname(fileURLToPath(import.meta.url));
const source = resolve(evidence, ...Array(7).fill('..'), 'source/deepseek-harness');
const require = createRequire(join(source, 'apps/desktop/package.json'));
const executable = require('electron');
const root = join(source, 'apps/desktop/.desktop-build/a01', `electron-diagnostic-${Date.now()}`);
mkdirSync(root, { recursive: true });
const scrubbed = { ...process.env };
for (const key of Object.keys(scrubbed)) {
  if (/^DSH_|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|^ELECTRON_|^NODE_OPTIONS$|^CHROME_/i.test(key)) delete scrubbed[key];
}
const minimal = {};
for (const key of Object.keys(scrubbed)) {
  if (/^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|SYSTEMDRIVE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)) minimal[key] = scrubbed[key];
}
const runs = [];
for (const [name, file, cwd, env] of [
  ['lexical', executable, source, scrubbed],
  ['realpath', realpathSync(executable), source, scrubbed],
  ['dist-cwd', realpathSync(executable), dirname(realpathSync(executable)), scrubbed],
  ['minimal-env', realpathSync(executable), source, minimal],
]) {
  const directory = join(root, name);
  mkdirSync(directory);
  const log = join(directory, 'chromium.log');
  const args = ['--version', '--enable-logging=file', `--log-file=${log}`, `--user-data-dir=${join(directory, 'user-data')}`];
  const result = spawnSync(file, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  runs.push({ name, executable: file, cwd, args, status: result.status, signal: result.signal,
    stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
    chromiumLog: existsSync(log) ? readFileSync(log, 'utf8') : null });
}
const report = { timestamp: new Date().toISOString(), root, runs };
writeFileSync(join(evidence, 'electron-matrix.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
