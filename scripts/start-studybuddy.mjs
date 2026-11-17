/** Start the project’s persistent DSH development profile; model management stays in the original DSH UI. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, delimiter, resolve } from 'node:path';
import { createServer } from 'node:net';
import { project, source, prepareProfile, customKeyRef } from './project-config.mjs';
import { WindowsCredentials } from '../platform/windows-credentials/index.mjs';

const require = createRequire(join(source, 'packages/credentials/credentials-local/package.json'));
const { Context } = require('@deepseek-ai/cordis');
const { parseCredentialsDocument } = require(join(source, 'packages/credentials/credentials-local/lib/index.js'));
if (process.platform !== 'win32') throw new Error('This project profile currently uses Windows DPAPI credentials');
const root = resolve(process.env.STUDYBUDDY_DATA_DIR ?? join(project, '.studybuddy'));
if (existsSync(join(source, '.env'))) throw new Error('Move source/.env credentials to project model settings before using this isolated launcher');
const { home, profilePatch, credentialPath } = await prepareProfile(root);
await mkdir(join(root, 'logs'), { recursive: true });
const marker = join(home, 'model-bootstrap.json');
let seededKey;
if (!existsSync(marker)) {
  const ctx = new Context();
  const fiber = ctx.plugin(WindowsCredentials, { path: credentialPath });
  await fiber.await();
  try {
    if (!(await ctx.credentials.describe(customKeyRef)).configured) {
      const keySource = process.env.STUDYBUDDY_IMPORT_CREDENTIALS;
      if (keySource && existsSync(keySource)) {
        const document = parseCredentialsDocument(await readFile(keySource, 'utf8'), keySource);
        seededKey = document.refs.get('DEEPSEEK_API_KEY');
        if (typeof seededKey !== 'string' || !seededKey) throw new Error('The selected credential document has no DEEPSEEK_API_KEY reference');
        await ctx.credentials.set(customKeyRef, seededKey);
      }
    }
    await writeFile(marker, JSON.stringify({ version: 1, provider: 'studybuddy-deepseek', importedCredential: (await ctx.credentials.describe(customKeyRef)).configured }) + '\n');
  } finally { await fiber.dispose(); }
}
console.log(JSON.stringify({ home, profilePatch, credentialStorage: 'Windows DPAPI CurrentUser', accountLogin: false }));
if (process.argv.includes('--prepare-only')) process.exit(0);

const env = { ...process.env };
for (const name of Object.keys(env)) if (/^DSH_|^ELECTRON_/i.test(name)) delete env[name];
const trayIcon = join(project, 'assets/tray.ico');
Object.assign(env, {
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
  DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'),
  DSH_DESKTOP_USER_DATA_DIR: join(root, 'electron-user-data'),
  DSH_DESKTOP_ACCOUNT_ENABLED: '0', DSH_DESKTOP_OPEN_DEVTOOLS: '0',
  DSH_TELEMETRY_DISABLED: '1', DSH_TELEMETRY_MODE: 'DISABLED',
  // Product branding: the desktop shell reads this instead of its bundled tray icon.
  ...(existsSync(trayIcon) ? { DSH_DESKTOP_TRAY_ICON: trayIcon } : {}),
});
const debug = {};
for (const name of ['DSH_DESKTOP_MAIN_INSPECT_PORT', 'DSH_DESKTOP_RENDERER_DEBUG_PORT', 'DSH_DESKTOP_HOST_INSPECT_PORT']) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  env[name] = String(server.address().port);
  debug[name] = env[name];
  await new Promise(resolve => server.close(resolve));
}
await writeFile(join(root, 'launch.json'), JSON.stringify({ root, home, ...debug }, null, 2) + '\n');
const redact = text => (seededKey ? text.replaceAll(seededKey, '[REDACTED]') : text).replace(/([?&]token=)[^\s"'<>]+/g, '$1[REDACTED]');
const child = spawn(process.execPath, [join(source, 'node_modules/pnpm/bin/pnpm.mjs'), 'run', 'start:desktop'],
  { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
await writeFile(join(root, 'launch.json'), JSON.stringify({ root, home, pid: child.pid, launcherPid: process.pid, ...debug }, null, 2) + '\n');
child.stdout.on('data', chunk => process.stdout.write(redact(chunk.toString())));
child.stderr.on('data', chunk => process.stderr.write(redact(chunk.toString())));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
