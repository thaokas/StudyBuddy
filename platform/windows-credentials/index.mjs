/** DSH credential provider backed by Windows CurrentUser DPAPI; UI and adapters retain their native APIs. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const require = createRequire(join(source, 'packages/credentials/credentials-local/package.json'));
const { CredentialProvider } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials')).href);
const { parseCredentialsDocument } = await import(pathToFileURL(join(source, 'packages/credentials/credentials-local/lib/index.js')).href);
const { withFileLock, writeFileAtomic } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href);
const { launchEnvironmentOf } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-launch-environment')).href);
const Schema = require('@deepseek-ai/schemastery');

/** Transform bytes through DPAPI; secrets travel over stdin/stdout, never argv or a temporary plaintext file. */
async function dpapi(input, operation) {
  if (process.platform !== 'win32') throw new Error('Windows DPAPI credentials require Windows');
  const command = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; `
    + `$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); `
    + `$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); `
    + `[Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((done, reject) => {
    const child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); }, 15000);
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.resume(); // Diagnostics can include private process context; callers receive a safe operation failure.
    child.once('error', () => { clearTimeout(timeout); reject(new Error(`Windows credential ${operation} could not start`)); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output)) reject(new Error(`Windows credential ${operation} failed; use the Windows account that saved this project’s credentials`));
      else done(Buffer.from(output, 'base64'));
    });
    child.stdin.on('error', () => {}); // A failed DPAPI subprocess is reported by its close/error handler.
    child.stdin.end(Buffer.from(input).toString('base64'));
  });
}

/** Native credential-reference and record operations, with cross-process locking and encrypted atomic replacement. */
export class WindowsCredentials extends CredentialProvider {
  static Config = Schema.object({ path: Schema.string().required(), lockWaitMs: Schema.number().min(1).default(120000) });

  constructor(ctx, config) {
    super(ctx);
    this.filename = resolve(config.path);
    this.lockWaitMs = config.lockWaitMs ?? 120000;
    this.cachedCiphertext = undefined;
    this.document = { version: 1, refs: {}, records: {} };
    this.pending = new Set();
    this.closed = false;
    ctx.effect(() => async () => { this.closed = true; await Promise.allSettled([...this.pending]); });
  }

  async load() {
    let text;
    try { text = await readFile(this.filename, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read the project credential store', { cause: error });
      this.cachedCiphertext = undefined;
      return { version: 1, refs: {}, records: {} };
    }
    if (text === this.cachedCiphertext) return structuredClone(this.document);
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw new Error('Project credential store has invalid metadata'); }
    if (envelope.version !== 1 || envelope.protection !== 'windows-dpapi-current-user' || typeof envelope.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(envelope.data)) {
      throw new Error('Project credential store has an unsupported format');
    }
    const plaintext = (await dpapi(Buffer.from(envelope.data, 'base64'), 'Unprotect')).toString('utf8');
    const parsed = parseCredentialsDocument(plaintext, this.filename);
    this.document = { version: 1, refs: Object.fromEntries(parsed.refs), records: Object.fromEntries(parsed.records) };
    this.cachedCiphertext = text;
    return structuredClone(this.document);
  }

  async commit(mutate) {
    if (this.closed) throw new Error('Project credential provider is stopping');
    const operation = (async () => {
      await mkdir(dirname(this.filename), { recursive: true });
      return withFileLock(this.filename, async () => {
        const document = await this.load();
        const result = await mutate(document);
        if (!result.changed) return result.value;
        const plaintext = JSON.stringify(document);
        parseCredentialsDocument(plaintext, this.filename);
        const ciphertext = await dpapi(Buffer.from(plaintext), 'Protect');
        const text = JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', data: ciphertext.toString('base64') }) + '\n';
        await writeFileAtomic(this.filename, text, { mode: 0o600, dirMode: 0o700 });
        this.document = document;
        this.cachedCiphertext = text;
        if (result.ref) this.notifyUpdated(result.ref);
        if (result.key) this.notifyRecordUpdated(result.key);
        return result.value;
      }, { waitMs: this.lockWaitMs });
    })();
    this.pending.add(operation);
    try { return await operation; } finally { this.pending.delete(operation); }
  }

  async resolve(ref) {
    const refs = (await this.load()).refs;
    const stored = Object.hasOwn(refs, ref) ? refs[ref] : undefined;
    if (stored) return { value: stored, source: 'file' };
    const fallback = launchEnvironmentOf(this.ctx).get(ref);
    return fallback?.value ? { value: fallback.value, source: fallback.source === 'process' ? 'env' : fallback.source } : undefined;
  }
  async describe(ref) {
    const credential = await this.resolve(ref);
    return { configured: credential !== undefined, ...(credential ? { source: credential.source } : {}), writable: true };
  }
  async set(ref, value) {
    if (typeof value !== 'string' || !value.length) throw new Error('A credential must be non-empty; remove the reference to clear it');
    await this.commit(document => { Object.defineProperty(document.refs, ref, { value, enumerable: true, writable: true, configurable: true }); return { changed: true, ref }; });
  }
  async unset(ref) {
    await this.commit(document => { const changed = Object.hasOwn(document.refs, ref); delete document.refs[ref]; return { changed, ref }; });
  }
  async readRecord(key) { return (await this.load()).records[key]; }
  async describeRecord(key) {
    const record = await this.readRecord(key);
    return { configured: record !== undefined, ...(record ? { kind: record.kind } : {}), writable: true };
  }
  async listRecords() { return Object.entries((await this.load()).records).map(([key, value]) => ({ key, kind: value.kind })); }
  async modifyRecord(key, mutate) {
    return this.commit(async document => {
      const current = document.records[key], next = await mutate(current);
      if (next === undefined) return { changed: false, value: current };
      document.records[key] = next;
      return { changed: true, value: next, key };
    });
  }
  async deleteRecord(key) {
    await this.commit(document => { const changed = Object.hasOwn(document.records, key); delete document.records[key]; return { changed, key }; });
  }
}

export default WindowsCredentials;
