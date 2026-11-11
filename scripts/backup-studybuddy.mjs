#!/usr/bin/env node
/**
 * StudyBuddy cold backup, verification, and restore.
 *
 * A cold backup is taken only after the desktop app is closed. The script
 * checks the launcher pid file and asks Windows for an Electron process that
 * uses this data root, then copies the whole data root (database, WAL files,
 * memory, profile, agents, workspace) into a timestamped directory. It writes
 * a manifest with SHA-256 hashes, rechecks that the source did not change while
 * copying, and opens a temporary copy of the database for SQLite integrity
 * checks. `--verify` repeats the checks later; `--restore` verifies first and
 * keeps the previous data root beside the target unless the target was empty.
 *
 * The JSON export in `plugins/study/host/modules/export.mjs` is the student
 * data subset and must not contain credentials. A cold backup is a byte copy
 * of the whole data root, so it also contains `home/credentials.dpapi`; that
 * file is DPAPI-encrypted, and the backup directory must be protected like the
 * original data.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createReadStream, existsSync, readFileSync, rmSync,
} from 'node:fs';
import {
  copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import {
  basename, dirname, join, relative, resolve, sep,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const FORMAT = 'studybuddy-cold-backup';
const FORMAT_VERSION = 1;
const MAX_DETAIL_ITEMS = 50;

const EXIT = Object.freeze({
  ok: 0,
  unexpected: 1,
  invalid: 2,
  appRunning: 3,
  verification: 4,
  sourceChanged: 5,
});

const EXIT_BY_CODE = Object.freeze({
  usage: EXIT.invalid,
  invalid_backup: EXIT.invalid,
  data_root_missing: EXIT.invalid,
  data_root_empty: EXIT.invalid,
  out_inside_data_root: EXIT.invalid,
  target_not_empty: EXIT.invalid,
  invalid_target: EXIT.invalid,
  app_running: EXIT.appRunning,
  source_changed: EXIT.sourceChanged,
  database_unusable: EXIT.verification,
  verification_failed: EXIT.verification,
  restore_verification_failed: EXIT.verification,
  drill_failed: EXIT.verification,
});

const USAGE = `StudyBuddy 冷备份

  node scripts/backup-studybuddy.mjs [--data-dir <数据根>] [--out <备份目录>]
  node scripts/backup-studybuddy.mjs --verify <备份目录>
  node scripts/backup-studybuddy.mjs --restore <备份目录> [--to <数据根>] [--force]
  node scripts/backup-studybuddy.mjs --drill [--keep]

默认数据根：环境变量 STUDYBUDDY_DATA_DIR，否则 <项目>/.studybuddy
默认备份目录：<用户目录>/StudyBuddy Backups（不要放在数据根里面）
--verify    只校验备份的清单、文件哈希与数据库完整性
--restore   先校验，再把备份的 data/ 恢复到 --to（默认数据根）
--force     目标数据根非空时，先改名为 <目标>.pre-restore-<时间> 再恢复
--drill     在临时目录里演练：进程拒绝、备份、校验、恢复、导出交叉核对
--keep      演练结束后保留临时目录，便于排查
`;

/** A failure that maps to a stable exit code and a user-safe message. */
class CliError extends Error {
  /**
   * @param {string} code - Stable failure code.
   * @param {string} message - Actionable explanation.
   * @param {object} [details] - Machine-readable context; never credentials.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

await main();

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failurePayload(error), null, 2)}\n`);
    process.exitCode = EXIT.invalid;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  try {
    const report = await run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.ok !== true) process.exitCode = report.exitCode ?? EXIT.verification;
  } catch (error) {
    const payload = failurePayload(error);
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = error instanceof CliError
      ? (EXIT_BY_CODE[error.code] ?? EXIT.unexpected)
      : EXIT.unexpected;
  }
}

function failurePayload(error) {
  if (error instanceof CliError) {
    return { ok: false, code: error.code, message: error.message, details: error.details };
  }
  return {
    ok: false,
    code: 'unexpected',
    message: error instanceof Error ? error.message : String(error),
    details: { reason: error instanceof Error ? error.message : String(error) },
  };
}

/**
 * Parse command-line flags.
 * @param {string[]} argv - Arguments after the script name.
 * @returns {object} Normalized options; throws `CliError` for unknown combinations.
 */
function parseArguments(argv) {
  const options = {
    mode: 'backup',
    dataDir: process.env.STUDYBUDDY_DATA_DIR ?? join(project, '.studybuddy'),
    outDir: join(homedir(), 'StudyBuddy Backups'),
    backupDir: undefined,
    target: undefined,
    force: false,
    keep: false,
    help: false,
  };
  let verify;
  let restore;
  let drill = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliError('usage', `参数 ${argument} 需要一个路径`, { argument });
      }
      index += 1;
      return next;
    };
    switch (argument) {
      case '--data-dir': options.dataDir = value(); break;
      case '--out': options.outDir = value(); break;
      case '--verify': verify = value(); break;
      case '--restore': restore = value(); break;
      case '--to': options.target = value(); break;
      case '--force': options.force = true; break;
      case '--drill': drill = true; break;
      case '--keep': options.keep = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default:
        throw new CliError('usage', `未知参数 ${JSON.stringify(argument)}；用 --help 查看用法`, { argument });
    }
  }
  if (verify !== undefined && restore !== undefined) {
    throw new CliError('usage', '--verify 与 --restore 不能同时使用');
  }
  if (drill && (verify !== undefined || restore !== undefined)) {
    throw new CliError('usage', '--drill 不能与 --verify 或 --restore 同时使用');
  }
  if (drill) {
    options.mode = 'drill';
  } else if (verify !== undefined) {
    options.mode = 'verify';
    options.backupDir = verify;
  } else if (restore !== undefined) {
    options.mode = 'restore';
    options.backupDir = restore;
  }
  if (options.keep && options.mode !== 'drill') {
    throw new CliError('usage', '--keep 只用于 --drill');
  }
  if (options.force && options.mode !== 'restore') {
    throw new CliError('usage', '--force 只用于 --restore');
  }
  options.dataDir = resolve(options.dataDir);
  options.outDir = resolve(options.outDir);
  options.target = resolve(options.target ?? options.dataDir);
  if (options.backupDir !== undefined) options.backupDir = resolve(options.backupDir);
  return options;
}

/** Dispatch one parsed command. */
async function run(options) {
  if (options.help) return { ok: true, mode: 'help' };
  if (options.mode === 'drill') return runDrill(options);
  if (options.mode === 'verify') return verifyBackup(options.backupDir);
  if (options.mode === 'restore') {
    return restoreBackup({ backupDir: options.backupDir, target: options.target, force: options.force });
  }
  return createBackup({ dataDir: options.dataDir, outDir: options.outDir });
}

/* ------------------------------------------------------------------ backup */

/**
 * Copy one closed data root into a timestamped backup directory.
 * @param {{ dataDir: string, outDir: string, now?: () => Date }} options - Source, destination parent, clock.
 * @returns {Promise<object>} Backup report with manifest paths and study counts.
 */
async function createBackup({ dataDir, outDir, now = () => new Date() }) {
  const root = resolve(dataDir);
  const out = resolve(outDir);
  const startedAt = now();
  if (!existsSync(root)) {
    throw new CliError('data_root_missing', `找不到数据根 ${root}。请先用 StudyBuddy 启动一次，或用 --data-dir 指定正确目录。`, { dataDir: root });
  }
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new CliError('data_root_missing', `数据根不是目录：${root}`, { dataDir: root });
  }
  if (isInside(root, out)) {
    throw new CliError('out_inside_data_root', `备份目录不能放在数据根里面：${out}。请用 --out 选择数据根之外的目录。`, { dataDir: root, outDir: out });
  }

  const beforeCheck = await checkProcesses(root);
  if (beforeCheck.running) throw appRunningError(root, beforeCheck);

  const sourceSnapshot = await snapshotDirectory(root);
  if (sourceSnapshot.length === 0) {
    throw new CliError('data_root_empty', `数据根 ${root} 是空的，没有可备份的学习数据。`, { dataDir: root });
  }
  const sourceHashes = new Map();
  for (const entry of sourceSnapshot) {
    sourceHashes.set(entry.path, await hashFile(fileAt(root, entry.path)));
  }

  const backupDir = await createUniqueDirectory(out, `studybuddy-backup-${fileStamp(startedAt)}`);
  const dataCopy = join(backupDir, 'data');
  let completed = false;
  try {
    try {
      await cp(root, dataCopy, {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
    } catch (error) {
      throw new CliError('copy_failed', `复制数据根失败，已丢弃这份备份：${error.message}`, {
        dataDir: root,
        backupDir,
        reason: error.message,
      });
    }

    const afterSnapshot = await snapshotDirectory(root);
    const changed = compareSnapshots(sourceSnapshot, afterSnapshot);
    const afterCheck = await checkProcesses(root);
    if (changed.length > 0 || afterCheck.running) {
      throw new CliError(
        'source_changed',
        '备份期间数据根发生变化，这份备份不可信，已丢弃。请完全关闭应用后重试。',
        { changed: changed.slice(0, MAX_DETAIL_ITEMS), processCheck: afterCheck },
      );
    }

    const copiedSnapshot = await snapshotDirectory(dataCopy);
    const copiedPaths = new Set(copiedSnapshot.map(entry => entry.path));
    const sourcePaths = new Set(sourceSnapshot.map(entry => entry.path));
    const missing = [...sourcePaths].filter(path => !copiedPaths.has(path));
    const extra = [...copiedPaths].filter(path => !sourcePaths.has(path));
    if (missing.length > 0 || extra.length > 0) {
      throw new CliError('copy_failed', '备份文件清单与数据根不一致，已丢弃。', {
        missing: missing.slice(0, MAX_DETAIL_ITEMS),
        extra: extra.slice(0, MAX_DETAIL_ITEMS),
      });
    }

    const sourceByPath = new Map(sourceSnapshot.map(entry => [entry.path, entry]));
    const files = [];
    for (const entry of copiedSnapshot) {
      const copiedHash = await hashFile(fileAt(dataCopy, entry.path));
      if (copiedHash !== sourceHashes.get(entry.path)) {
        throw new CliError('copy_failed', `备份文件与源文件哈希不一致：${entry.path}`, { path: entry.path });
      }
      const source = sourceByPath.get(entry.path);
      files.push({
        path: entry.path,
        size: entry.size,
        sha256: copiedHash,
        mtimeMs: source?.mtimeMs ?? entry.mtimeMs,
      });
    }

    const study = await inspectStudy(dataCopy);
    if (study.present && study.usable !== true) {
      throw new CliError('database_unusable', '复制出来的学习数据库未通过完整性检查，已丢弃这份备份。', { study });
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const createdAt = now().toISOString();
    const manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      createdAt,
      tool: 'scripts/backup-studybuddy.mjs',
      source: {
        root,
        files: files.length,
        bytes: totalBytes,
        latestMtimeMs: files.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0),
      },
      processCheck: {
        before: beforeCheck,
        after: afterCheck,
      },
      study,
      files,
      excluded: ['launch.json'],
      note: '整份数据根的冷备份（launch.json 每次启动由启动器重写，故不复制），包含 DPAPI 加密的凭据文件；请像保护原数据一样保护备份目录。',
    };
    await writeFile(join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(backupDir, 'checksums.sha256'), checksumLines(files), { mode: 0o600 });
    completed = true;

    return {
      ok: true,
      mode: 'backup',
      backupDir,
      createdAt,
      durationMs: Date.now() - startedAt.getTime(),
      source: { root, files: files.length, bytes: totalBytes },
      processCheck: manifest.processCheck,
      study,
      manifest: join(backupDir, 'manifest.json'),
      checksums: join(backupDir, 'checksums.sha256'),
    };
  } finally {
    if (!completed) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Build the user-facing refusal for a running app. */
function appRunningError(root, check) {
  return new CliError(
    'app_running',
    `检测到 StudyBuddy 仍在运行：${describeRunning(check)}。请先关闭应用窗口并等待进程退出，再重新备份；热备份可能复制到不一致的数据库。`,
    { dataDir: root, processCheck: check },
  );
}

function describeRunning(check) {
  const parts = [];
  const seen = new Set();
  for (const item of check.detected ?? []) {
    const key = `${item.source}:${item.pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.source === 'launch.json') parts.push(`launch.json 记录的进程 ${item.pid}`);
    else parts.push(`${item.name ?? '进程'} ${item.pid}`);
  }
  return parts.length === 0 ? '未能识别进程' : parts.join('、');
}

/* ---------------------------------------------------------------- verify */

/**
 * Verify a backup without modifying it.
 * @param {string} backupDir - Directory written by {@link createBackup}.
 * @returns {Promise<object>} Verification report; `ok` is false when anything differs.
 */
async function verifyBackup(backupDir) {
  const root = resolve(backupDir);
  const manifestPath = join(root, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new CliError('invalid_backup', `无法读取备份清单 ${manifestPath}`, {
      reason: error.message,
      hint: '请选择 --out 下以 studybuddy-backup- 开头的目录。',
    });
  }
  validateManifest(manifest, manifestPath);

  const errors = [];
  const warnings = [];
  const dataDir = join(root, 'data');
  if (!existsSync(dataDir)) {
    errors.push({ check: 'data-directory', message: '备份缺少 data/ 目录' });
  }

  const manifestFiles = new Map();
  for (const file of manifest.files) {
    if (manifestFiles.has(file.path)) {
      errors.push({ check: 'manifest', message: `清单里重复出现 ${file.path}` });
      continue;
    }
    manifestFiles.set(file.path, file);
  }

  if (existsSync(dataDir)) {
    const actualSnapshot = await snapshotDirectory(dataDir);
    const actualPaths = new Set(actualSnapshot.map(entry => entry.path));
    for (const path of manifestFiles.keys()) {
      if (!actualPaths.has(path)) errors.push({ check: 'missing-file', path, message: `缺少 ${path}` });
    }
    for (const path of actualPaths) {
      if (!manifestFiles.has(path)) errors.push({ check: 'extra-file', path, message: `清单外多出 ${path}` });
    }
    for (const entry of actualSnapshot) {
      const expected = manifestFiles.get(entry.path);
      if (expected === undefined) continue;
      if (entry.size !== expected.size) {
        errors.push({ check: 'size', path: entry.path, message: `大小不一致：${entry.path}` });
        continue;
      }
      const actualHash = await hashFile(fileAt(dataDir, entry.path));
      if (actualHash !== expected.sha256) {
        errors.push({ check: 'sha256', path: entry.path, message: `哈希不一致：${entry.path}` });
      }
    }
  }

  const checksumsPath = join(root, 'checksums.sha256');
  try {
    const checksumMap = parseChecksums(await readFile(checksumsPath, 'utf8'));
    if (checksumMap.size !== manifestFiles.size) {
      errors.push({ check: 'checksums', message: `checksums.sha256 有 ${checksumMap.size} 行，清单有 ${manifestFiles.size} 个文件` });
    }
    for (const [path, hash] of manifestFiles) {
      if (checksumMap.get(path) !== hash.sha256) {
        errors.push({ check: 'checksums', path, message: `checksums.sha256 与清单不一致：${path}` });
      }
    }
  } catch (error) {
    errors.push({ check: 'checksums', message: `无法读取 checksums.sha256：${error.message}` });
  }

  let study = { present: false };
  try {
    study = await inspectStudy(dataDir);
  } catch (error) {
    errors.push({ check: 'study-database', message: `无法检查学习数据库：${error.message}` });
  }
  if (manifest.study?.present === true) {
    if (study.present !== true) {
      errors.push({ check: 'study-database', message: '清单记录了 study.db，但备份里没有' });
    } else if (study.usable !== true) {
      errors.push({ check: 'study-database', message: '学习数据库未通过完整性检查', study });
    } else {
      for (const field of ['revision', 'tables', 'core']) {
        if (!sameJson(manifest.study[field], study[field])) {
          errors.push({ check: `study-${field}`, message: `学习数据库的 ${field} 与清单不一致`, expected: manifest.study[field], actual: study[field] });
        }
      }
    }
  } else if (study.present === true) {
    errors.push({ check: 'study-database', message: '清单没有记录 study.db，但备份里出现了数据库' });
  }

  return {
    ok: errors.length === 0,
    mode: 'verify',
    backupDir: root,
    createdAt: manifest.createdAt,
    source: manifest.source,
    totals: { files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) },
    study,
    errors: errors.slice(0, MAX_DETAIL_ITEMS),
    errorCount: errors.length,
    warnings,
  };
}

function validateManifest(manifest, path) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new CliError('invalid_backup', `备份清单不是对象：${path}`);
  }
  if (manifest.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION) {
    throw new CliError('invalid_backup', `备份清单格式或版本不受支持：${path}`, {
      format: manifest.format,
      formatVersion: manifest.formatVersion,
      supportedFormat: FORMAT,
      supportedVersion: FORMAT_VERSION,
    });
  }
  if (!Array.isArray(manifest.files) || manifest.files.some(file => typeof file?.path !== 'string' || !/^[a-f0-9]{64}$/.test(file?.sha256 ?? ''))) {
    throw new CliError('invalid_backup', `备份清单的文件列表不完整：${path}`);
  }
  for (const file of manifest.files) {
    const segments = file.path.split('/');
    if (file.path.startsWith('/') || file.path.includes('\\') || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new CliError('invalid_backup', `备份清单包含不安全的相对路径：${JSON.stringify(file.path)}`, { path: file.path });
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new CliError('invalid_backup', `备份清单缺少文件大小：${file.path}`, { path: file.path });
    }
  }
}

function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (match === null) throw new Error(`无法解析校验行：${line.slice(0, 80)}`);
    map.set(match[2], match[1]);
  }
  return map;
}

function checksumLines(files) {
  return `${files.map(file => `${file.sha256}  ${file.path}`).join('\n')}\n`;
}

/* --------------------------------------------------------------- restore */

/**
 * Verify a backup and copy its data/ back over a closed data root.
 * @param {{ backupDir: string, target: string, force: boolean }} options - Backup, destination, overwrite flag.
 * @returns {Promise<object>} Restore report with the previous root location when one was moved aside.
 */
async function restoreBackup({ backupDir, target, force }) {
  const backup = resolve(backupDir);
  const destination = resolve(target);
  const verification = await verifyBackup(backup);
  if (!verification.ok) {
    throw new CliError('verification_failed', '备份校验未通过，已拒绝恢复。请换一份通过 --verify 的备份。', {
      backupDir: backup,
      errors: verification.errors,
      errorCount: verification.errorCount,
    });
  }
  if (isInside(destination, backup) || isInside(backup, destination)) {
    throw new CliError('invalid_target', '恢复目标不能与备份目录互相包含。', { backupDir: backup, target: destination });
  }
  if (dirname(destination) === destination) {
    throw new CliError('invalid_target', `拒绝把备份恢复到磁盘根目录：${destination}`, { target: destination });
  }
  if (existsSync(destination) && !(await stat(destination)).isDirectory()) {
    throw new CliError('invalid_target', `恢复目标不是目录：${destination}`, { target: destination });
  }

  const processCheck = await checkProcesses(destination);
  if (processCheck.running) {
    throw new CliError('app_running', `目标数据根仍被 StudyBuddy 使用：${describeRunning(processCheck)}。请先关闭应用。`, {
      target: destination,
      processCheck,
    });
  }

  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
  const source = join(backup, 'data');
  let previousRootAside = null;
  let copied = false;
  try {
    if (existsSync(destination)) {
      const entries = await readdir(destination);
      if (entries.length > 0) {
        if (!force) {
          throw new CliError(
            'target_not_empty',
            `目标数据根非空：${destination}。确认要覆盖时加 --force；脚本会先把现有目录改名为 ${basename(destination)}.pre-restore-<时间>。`,
            { target: destination },
          );
        }
        previousRootAside = await createUniquePath(dirname(destination), `${basename(destination)}.pre-restore-${fileStamp(new Date())}`);
        await rename(destination, previousRootAside);
      }
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });
    copied = true;
    await cp(source, destination, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: false,
      force: true,
      verbatimSymlinks: true,
    });

    const restoredErrors = await compareRestoredTree(destination, manifest);
    if (restoredErrors.length > 0) {
      throw new CliError('restore_verification_failed', '恢复后的文件与备份不一致，请检查下方错误。', {
        target: destination,
        previousRootAside,
        errors: restoredErrors.slice(0, MAX_DETAIL_ITEMS),
        errorCount: restoredErrors.length,
      });
    }
    const study = await inspectStudy(destination);
    if (manifest.study?.present === true && study.usable !== true) {
      throw new CliError('restore_verification_failed', '恢复后的学习数据库未通过完整性检查。', {
        target: destination,
        previousRootAside,
        study,
      });
    }
    return {
      ok: true,
      mode: 'restore',
      backupDir: backup,
      target: destination,
      previousRootAside,
      createdAt: manifest.createdAt,
      files: manifest.files.length,
      bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
      study,
    };
  } catch (error) {
    if (copied) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
    }
    if (previousRootAside !== null) {
      await rename(previousRootAside, destination).catch(() => {});
    }
    throw error;
  }
}

async function compareRestoredTree(root, manifest) {
  const errors = [];
  const actual = await snapshotDirectory(root);
  const actualByPath = new Map(actual.map(entry => [entry.path, entry]));
  const expectedPaths = new Set(manifest.files.map(file => file.path));
  for (const file of manifest.files) {
    const entry = actualByPath.get(file.path);
    if (entry === undefined) {
      errors.push({ check: 'missing-file', path: file.path, message: `恢复后缺少 ${file.path}` });
      continue;
    }
    if (entry.size !== file.size) {
      errors.push({ check: 'size', path: file.path, message: `恢复后大小不一致：${file.path}` });
      continue;
    }
    const hash = await hashFile(fileAt(root, file.path));
    if (hash !== file.sha256) errors.push({ check: 'sha256', path: file.path, message: `恢复后哈希不一致：${file.path}` });
  }
  for (const entry of actual) {
    if (!expectedPaths.has(entry.path)) errors.push({ check: 'extra-file', path: entry.path, message: `恢复后多出 ${entry.path}` });
  }
  return errors;
}

/* --------------------------------------------------------------- process */

/**
 * Check whether this data root is still in use, by launcher pids and by an
 * Electron process that carries `--user-data-dir=<root>/electron-user-data`.
 * @param {string} root - Data root.
 * @returns {Promise<{ running: boolean, detected: object[], warnings: string[] }>} Check result.
 */
async function checkProcesses(root) {
  const detected = [];
  const warnings = [];
  const launchFile = join(root, 'launch.json');
  let launch = null;
  if (existsSync(launchFile)) {
    try {
      launch = JSON.parse(await readFile(launchFile, 'utf8'));
    } catch (error) {
      warnings.push(`launch.json 无法解析，已跳过其中的 pid：${error.message}`);
    }
  }
  if (launch !== null && typeof launch === 'object') {
    for (const field of ['pid', 'launcherPid']) {
      const pid = launch[field];
      if (Number.isSafeInteger(pid) && pid > 0 && isPidAlive(pid)) {
        detected.push({ source: 'launch.json', field, pid, name: 'launcher' });
      }
    }
  }

  const scan = await scanWindowsProcesses(root);
  if (scan.supported !== true) {
    warnings.push(scan.skipped ?? scan.error ?? '当前平台无法扫描应用进程');
  } else {
    for (const processInfo of scan.processes) detected.push({ source: 'process-scan', ...processInfo });
  }

  return {
    checkedAt: new Date().toISOString(),
    running: detected.length > 0,
    detected,
    warnings,
    launchFile: existsSync(launchFile) ? launchFile : null,
  };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Ask Windows for processes whose command line points at this Electron user
 * data directory. PowerShell writes JSON to a temp file so the call works even
 * where stdio pipes are unavailable.
 * @param {string} root - Data root.
 * @returns {Promise<{ supported: boolean, processes: object[], error?: string }>} Scan result.
 */
async function scanWindowsProcesses(root) {
  if (process.platform !== 'win32') return { supported: false, processes: [], skipped: 'process-scan-unavailable-on-this-platform' };
  const electronData = join(root, 'electron-user-data');
  const needles = [
    `--user-data-dir=${electronData}`,
    `--user-data-dir=${electronData.replaceAll('\\', '/')}`,
  ];
  const outputFile = join(tmpdir(), `studybuddy-processes-${process.pid}-${Date.now()}.json`);
  const quotedNeedles = needles.map(value => `'${value.replaceAll("'", "''")}'`).join(', ');
  const script = [
    `$needles = @(${quotedNeedles})`,
    `$found = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {`,
    `  $line = $_.CommandLine`,
    `  if (-not $line) { return $false }`,
    `  if ($_.ProcessId -eq ${process.pid}) { return $false }`,
    `  if ($_.Name -eq 'powershell.exe' -or $_.Name -eq 'pwsh.exe') { return $false }`,
    `  foreach ($needle in $needles) { if ($line.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true } }`,
    `  return $false`,
    `} | Select-Object ProcessId, Name)`,
    `if ($found.Count -eq 0) { '[]' | Set-Content -LiteralPath '${outputFile.replaceAll("'", "''")}' -Encoding UTF8 }`,
    `else { $found | ConvertTo-Json -Compress | Set-Content -LiteralPath '${outputFile.replaceAll("'", "''")}' -Encoding UTF8 }`,
  ].join('\n');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 30_000,
    });
    if (result.error) return { supported: false, processes: [], error: result.error.message };
    if (result.status !== 0) return { supported: false, processes: [], error: `PowerShell 进程扫描退出码 ${result.status}` };
    let text = '';
    try {
      text = readFileSync(outputFile, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch (error) {
      return { supported: false, processes: [], error: `无法读取进程扫描结果：${error.message}` };
    }
    if (text.length === 0) return { supported: true, processes: [] };
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const processes = list
      .filter(item => Number.isSafeInteger(Number(item?.ProcessId)))
      .map(item => ({ pid: Number(item.ProcessId), name: typeof item.Name === 'string' ? item.Name : 'process' }));
    return { supported: true, processes };
  } catch (error) {
    return { supported: false, processes: [], error: error.message };
  } finally {
    rmSync(outputFile, { force: true });
  }
}

/* ----------------------------------------------------------- study files */

/**
 * Inspect the copied study database without touching the backup: the database
 * trio is opened from a temporary directory, so SQLite may recover the WAL.
 * @param {string} dataRoot - Backup data directory.
 * @returns {Promise<object>} Counts and integrity results.
 */
async function inspectStudy(dataRoot) {
  const databaseFile = join(dataRoot, 'study', 'study.db');
  if (!existsSync(databaseFile)) return { present: false };
  const temporary = await mkdtemp(join(tmpdir(), 'studybuddy-inspect-'));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const sourceFile = `${databaseFile}${suffix}`;
      if (existsSync(sourceFile)) await copyFile(sourceFile, join(temporary, `study.db${suffix}`));
    }
    let database;
    try {
      database = new DatabaseSync(join(temporary, 'study.db'));
    } catch (error) {
      return { present: true, file: 'study/study.db', usable: false, error: `无法打开数据库：${error.message}` };
    }
    try {
      const integrityCheck = pragmaRows(database, 'PRAGMA integrity_check');
      const quickCheck = pragmaRows(database, 'PRAGMA quick_check');
      const writerVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map(row => String(row.name))
        .filter(name => name.startsWith('study_') && !name.includes('_fts'))
        .sort();
      const counts = {};
      for (const table of tables) counts[table] = countRows(database, table);
      const hasMeta = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined;
      const revision = hasMeta
        ? Number(database.prepare("SELECT value FROM meta WHERE key = 'revision'").get()?.value ?? Number.NaN)
        : null;
      const modules = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'module_schema'").get() === undefined
        ? []
        : database.prepare('SELECT module_id, schema_version FROM module_schema ORDER BY module_id').all()
          .map(row => ({ id: String(row.module_id), schemaVersion: Number(row.schema_version) }));
      const core = {
        changeLog: countIfPresent(database, 'change_log'),
        requestLog: countIfPresent(database, 'request_log'),
        daySnapshots: countIfPresent(database, 'day_snapshot'),
      };
      const usable = hasMeta
        && integrityCheck.every(value => value === 'ok')
        && quickCheck.every(value => value === 'ok');
      return {
        present: true,
        file: 'study/study.db',
        writerVersion,
        revision: Number.isSafeInteger(revision) ? revision : null,
        modules,
        tables: counts,
        core,
        integrityCheck,
        quickCheck,
        usable,
      };
    } finally {
      database.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

function pragmaRows(database, sql) {
  return database.prepare(sql).all().map(row => Object.values(row)[0]).map(value => String(value));
}

function countRows(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM "${String(table).replaceAll('"', '""')}"`).get().count);
}

function countIfPresent(database, table) {
  const exists = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return exists === undefined ? 0 : countRows(database, table);
}

/* ------------------------------------------------------------------ files */

/**
 * List every regular file under a directory, rejecting links and special files.
 * `launch.json` at the data-root top level is skipped: the launcher rewrites it
 * on every start, and a restored copy with old pids would make the next backup
 * mistake unrelated (or reused) pids for a running app.
 * @param {string} root - Directory to walk.
 * @returns {Promise<string[]>} Absolute file paths, sorted.
 */
async function listFiles(root) {
  const files = [];
  const walk = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (directory === root && entry.name === 'launch.json') continue;
      if (entry.isSymbolicLink()) {
        throw new CliError('source_changed', `数据根里包含符号链接，冷备份不会跟随：${full}`, { path: full });
      }
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
      else throw new CliError('source_changed', `数据根里有不支持的文件类型：${full}`, { path: full });
    }
  };
  await walk(root);
  return files.sort();
}

async function snapshotDirectory(root) {
  const files = await listFiles(root);
  const entries = [];
  for (const file of files) {
    const info = await stat(file);
    entries.push({
      path: relativePath(root, file),
      size: info.size,
      mtimeMs: Math.round(info.mtimeMs),
    });
  }
  return entries;
}

function compareSnapshots(before, after) {
  const beforeMap = new Map(before.map(entry => [entry.path, entry]));
  const afterMap = new Map(after.map(entry => [entry.path, entry]));
  const changes = [];
  for (const [path, entry] of beforeMap) {
    const next = afterMap.get(path);
    if (next === undefined) changes.push(`removed:${path}`);
    else if (next.size !== entry.size || next.mtimeMs !== entry.mtimeMs) changes.push(`changed:${path}`);
  }
  for (const path of afterMap.keys()) {
    if (!beforeMap.has(path)) changes.push(`added:${path}`);
  }
  return changes;
}

function relativePath(root, file) {
  return relative(root, file).split(sep).join('/');
}

function fileAt(root, relativeEntryPath) {
  return join(root, ...relativeEntryPath.split('/'));
}

function hashFile(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

/* ------------------------------------------------------------------ paths */

function isInside(parent, child) {
  const parentPath = normalizeForCompare(parent);
  const childPath = normalizeForCompare(child);
  return childPath === parentPath || childPath.startsWith(parentPath.endsWith(sep) ? parentPath : `${parentPath}${sep}`);
}

function normalizeForCompare(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function createUniqueDirectory(parent, name) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const candidate = join(parent, attempt === 1 ? name : `${name}-${attempt}`);
    try {
      await mkdir(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new CliError('copy_failed', `无法创建备份目录 ${candidate}`, { reason: error.message });
      }
    }
  }
  throw new CliError('copy_failed', `备份目录重名过多：${parent}`);
}

async function createUniquePath(parent, name) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const candidate = join(parent, attempt === 1 ? name : `${name}-${attempt}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new CliError('invalid_target', `无法为旧数据根找到空闲的备份名：${parent}`);
}

function fileStamp(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/* ------------------------------------------------------------------ drill */

/**
 * Self-contained rehearsal on a synthetic data root: refuse a live app, back
 * up, verify, restore, tamper detection, and the JSON export cross-checks.
 * @param {{ keep: boolean }} options - Keep temporary directories.
 * @returns {Promise<object>} Drill report with every check.
 */
async function runDrill({ keep }) {
  const startedAt = new Date();
  const root = await mkdtemp(join(tmpdir(), 'studybuddy-drill-'));
  const dataRoot = join(root, 'data-root');
  const studyDir = join(dataRoot, 'study');
  const checks = [];
  const expect = (name, condition, detail) => {
    const check = { name, ok: Boolean(condition), detail: detail ?? null };
    checks.push(check);
    if (!check.ok) {
      throw new CliError('drill_failed', `演练检查失败：${name}`, { checks, detail: detail ?? null });
    }
  };
  let exportedFile;
  try {
    await createDrillFixture(dataRoot, studyDir);

    await writeFile(join(dataRoot, 'launch.json'), `${JSON.stringify({ pid: process.pid, launcherPid: process.pid })}\n`);
    let refused = null;
    try {
      await createBackup({ dataDir: dataRoot, outDir: join(root, 'refused-backups'), now: () => new Date() });
    } catch (error) {
      refused = error;
    }
    expect('运行中的应用会被拒绝', refused instanceof CliError && refused.code === 'app_running', refused?.message ?? 'backup unexpectedly succeeded');
    await rm(join(dataRoot, 'launch.json'), { force: true });

    const backup = await createBackup({ dataDir: dataRoot, outDir: join(root, 'backups'), now: () => new Date() });
    expect('备份写入清单与校验文件', existsSync(backup.manifest) && existsSync(backup.checksums));
    expect('备份记录学习数据库修订 7', backup.study?.revision === 7, backup.study);
    expect('备份清单列出数据库、记忆与凭据文件', backup.source.files >= 5, backup.source);

    const verification = await verifyBackup(backup.backupDir);
    expect('备份校验通过', verification.ok === true, verification.errors);

    const restored = await restoreBackup({ backupDir: backup.backupDir, target: join(root, 'restored'), force: true });
    expect('恢复后文件哈希一致', restored.ok === true);
    expect('恢复后修订与表计数一致', restored.study?.revision === 7
      && restored.study?.tables?.study_task === 2
      && restored.study?.tables?.study_plan_progress === 2, restored.study);

    const tampered = join(root, 'tampered-backup');
    await cp(backup.backupDir, tampered, { recursive: true });
    const memoryFile = join(tampered, 'data', 'study', 'memory.json');
    await writeFile(memoryFile, `${await readFile(memoryFile, 'utf8')}\n`);
    const tamperedReport = await verifyBackup(tampered);
    expect('被篡改的备份会被拒绝', tamperedReport.ok === false
      && tamperedReport.errors.some(error => error.check === 'sha256' || error.check === 'size'), tamperedReport.errors);

    const exportModule = await import('../plugins/study/host/modules/export.mjs');
    const adapter = databaseAdapter(join(restored.target, 'study', 'study.db'));
    const restoresStudyDir = join(restored.target, 'study');
    let document;
    try {
      document = exportModule.buildStudyExport({ database: adapter, dataDir: restoresStudyDir, now: () => new Date('2026-11-10T12:00:00.000Z') });
      expect('导出格式与修订', document.format === 'studybuddy-export' && document.revision === 7);
      expect('导出覆盖目标/资料/任务/计划/进度/记忆', document.summary.goals === 1
        && document.summary.materials === 1
        && document.summary.tasks === 2
        && document.summary.plans === 1
        && document.summary.progress === 2
        && document.summary.memories === 1, document.summary);
      expect('成果列表为空且标明原因', document.availability.outcomes.available === false
        && document.availability.outcomes.reason === 'outcomes_module_not_available_in_this_build'
        && Array.isArray(document.data.outcomes) && document.data.outcomes.length === 0);
      expect('导出含计划修订快照', document.data.planRevisions[0]?.snapshot?.items?.length === 2, document.data.planRevisions);
      expect('导出不含请求缓存', document.data.requestLog === undefined
        && !JSON.stringify(document).includes('__REQUEST_LOG_MARKER__'));
      expect('导出不含凭据与日志内容', !JSON.stringify(document).includes('sk-DRILL-CREDENTIAL-SENTINEL')
        && !JSON.stringify(document).includes('credentials.dpapi'));
      expect('导出校验和是 SHA-256', /^[a-f0-9]{64}$/.test(document.checksum?.value ?? ''));

      const memoryPath = join(restoresStudyDir, 'memory.json');
      const memoryText = await readFile(memoryPath, 'utf8');
      const memoryDocument = JSON.parse(memoryText);
      memoryDocument.items[0].text = '帮我记住 sk-DRILL-EXPORT-SECRET-1234567890';
      await writeFile(memoryPath, `${JSON.stringify(memoryDocument, null, 2)}\n`);
      let credentialRejected = null;
      try {
        exportModule.buildStudyExport({ database: adapter, dataDir: restoresStudyDir });
      } catch (error) {
        credentialRejected = error;
      }
      await writeFile(memoryPath, memoryText);
      expect('导出扫描会拒绝疑似凭据且不回显',
        credentialRejected?.code === 'unavailable'
          && /凭据/.test(credentialRejected?.message ?? '')
          && !String(credentialRejected?.message).includes('DRILL-EXPORT-SECRET'),
        credentialRejected?.message ?? 'export unexpectedly succeeded');

      assertCrossChecks(document, expect);

      const tools = [];
      const routes = [];
      const scoped = {
        effect(work) {
          const disposer = work();
          return typeof disposer === 'function' ? disposer : () => {};
        },
        connection: {
          fetch: {
            register(route) {
              routes.push(route);
              return () => {};
            },
          },
        },
      };
      exportModule.apply({
        effect(work) {
          const disposer = work();
          return typeof disposer === 'function' ? disposer : () => {};
        },
        inject(_deps, callback) { callback(scoped); },
        tools: {
          register(definition) {
            tools.push(definition);
            return () => {};
          },
        },
      }, { database: adapter });

      const tool = tools.find(candidate => candidate.name === 'study_export');
      expect('应用内导出工具已注册', tool !== undefined);
      const toolResult = await tool.execute({}, { signal: new AbortController().signal });
      exportedFile = toolResult.path;
      expect('导出工具写出文件', existsSync(exportedFile), toolResult);
      const written = JSON.parse(await readFile(exportedFile, 'utf8'));
      expect('导出文件包含数据且不含缓存', written.summary.tasks === 2
        && !JSON.stringify(written).includes('__REQUEST_LOG_MARKER__'));

      const route = routes.find(candidate => candidate.path === '/api/study/export.json');
      expect('应用内导出路由已注册', route !== undefined);
      const response = await route.fetch(new Request('http://localhost/api/study/export.json'));
      const routeBody = await response.text();
      expect('导出路由返回 JSON 附件', response.status === 200
        && String(response.headers.get('content-disposition')).includes('studybuddy-export-')
        && JSON.parse(routeBody).format === 'studybuddy-export');
      expect('导出路由不含凭据或请求缓存', !routeBody.includes('sk-DRILL-CREDENTIAL-SENTINEL')
        && !routeBody.includes('__REQUEST_LOG_MARKER__')
        && !routeBody.includes('credentials.dpapi'));
    } finally {
      adapter.close();
    }

    return {
      ok: true,
      mode: 'drill',
      synthetic: true,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      temporaryRoot: keep ? root : null,
      checks,
      files: {
        backup: backup.backupDir,
        restored: restored.target,
        export: exportedFile ?? null,
      },
    };
  } finally {
    if (!keep) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function databaseAdapter(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  return {
    file,
    get: (sql, ...params) => database.prepare(sql).get(...params),
    all: (sql, ...params) => database.prepare(sql).all(...params),
    close: () => database.close(),
  };
}

function assertCrossChecks(document, expect) {
  const taskIds = new Set(document.data.tasks.map(task => task.id));
  expect('时间块能对应任务', document.data.timeBlocks.every(block => block.task_id === null || taskIds.has(block.task_id)));
  const goalIds = new Set(document.data.goals.map(goal => goal.id));
  expect('计划能对应目标', document.data.plans.every(plan => plan.goal_id === null || goalIds.has(plan.goal_id)));
  const materialIds = new Set(document.data.materials.map(material => material.id));
  expect('资料片段能对应资料', document.data.materialChunks.every(chunk => materialIds.has(chunk.material_id)));
  const revisions = new Map(document.data.planRevisions.map(revision => [`${revision.plan_id}:${revision.number}`, revision]));
  expect('进度能对应计划修订中的条目', document.data.progress.every(progress => {
    const revision = revisions.get(`${progress.plan_id}:${progress.revision}`);
    return revision !== undefined && (revision.snapshot?.items ?? []).some(item => item.id === progress.item_id);
  }));
}

/**
 * Create a representative data root with linked task/plan/progress rows.
 * The DDL mirrors the shipped modules so the drill exercises real column names.
 */
async function createDrillFixture(dataRoot, studyDir) {
  await mkdir(join(dataRoot, 'home'), { recursive: true });
  await mkdir(join(dataRoot, 'logs'), { recursive: true });
  await mkdir(join(dataRoot, 'workspace'), { recursive: true });
  await mkdir(studyDir, { recursive: true });
  await writeFile(join(dataRoot, 'home', 'credentials.dpapi'), 'sk-DRILL-CREDENTIAL-SENTINEL-1234567890\n', { mode: 0o600 });
  await writeFile(join(dataRoot, 'logs', 'app.log'), 'started\nsk-DRILL-CREDENTIAL-SENTINEL-1234567890\n');
  await writeFile(join(dataRoot, 'workspace', 'note.txt'), '学习工作区文件\n');
  await writeFile(join(studyDir, 'memory.json'), `${JSON.stringify({
    version: 1,
    updatedAt: '2026-11-10T08:00:00.000Z',
    items: [{
      id: 'mem_aaaaaaaaaaaa',
      kind: 'preference',
      text: '我更喜欢在上午学习数学。',
      createdAt: '2026-11-09T08:00:00.000Z',
      updatedAt: '2026-11-10T08:00:00.000Z',
      expiresAt: null,
      source: { actor: 'ui' },
    }],
    tombstones: [{ id: 'mem_bbbbbbbbbbbb', contentHash: 'deadbeef', deletedAt: '2026-11-09T09:00:00.000Z' }],
  }, null, 2)}\n`, { mode: 0o600 });

  const database = new DatabaseSync(join(studyDir, 'study.db'));
  try {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE module_schema (module_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL) STRICT;
      CREATE TABLE request_log (request_id TEXT PRIMARY KEY, ns TEXT NOT NULL, method TEXT NOT NULL, fingerprint TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE change_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, action TEXT NOT NULL, before_json TEXT, after_json TEXT, reason TEXT) STRICT;
      CREATE TABLE day_snapshot (date TEXT PRIMARY KEY, plan_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE study_goal (id TEXT PRIMARY KEY, exam TEXT NOT NULL, exam_year INTEGER, deadline TEXT, daily_minutes INTEGER, note TEXT, active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE study_material (id TEXT PRIMARY KEY, goal_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, edition TEXT, subject TEXT, source_kind TEXT NOT NULL, source_ref TEXT, source_date TEXT NOT NULL, format TEXT NOT NULL, verification TEXT NOT NULL, toc_json TEXT NOT NULL DEFAULT '[]', deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE study_material_chunk (id TEXT PRIMARY KEY, material_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, page INTEGER, chapter TEXT, chapter_index INTEGER, locator_source TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, source_date TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE study_task (id TEXT PRIMARY KEY, title TEXT NOT NULL, subject TEXT, material_ref TEXT, completion_criteria TEXT, estimated_minutes INTEGER, prerequisites_json TEXT NOT NULL DEFAULT '[]', deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE study_time_block (id TEXT PRIMARY KEY, date TEXT NOT NULL, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL, fixed INTEGER NOT NULL DEFAULT 0, task_id TEXT, title TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE study_plan (id TEXT PRIMARY KEY, goal_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, revision_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE study_plan_revision (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, number INTEGER NOT NULL, status TEXT NOT NULL, action TEXT NOT NULL, reason TEXT, actor TEXT NOT NULL, snapshot_json TEXT NOT NULL, diff_json TEXT NOT NULL DEFAULT '{}', undone_by INTEGER, created_at TEXT NOT NULL, applied_at TEXT NOT NULL, UNIQUE (plan_id, number)) STRICT;
      CREATE TABLE study_plan_draft (plan_id TEXT PRIMARY KEY, id TEXT NOT NULL, base_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, reason TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE study_plan_progress (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, item_id TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, quantity_done INTEGER, quantity_total INTEGER, note TEXT, confirmed INTEGER NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL) STRICT;
    `);
    database.prepare("INSERT INTO meta (key, value) VALUES ('revision', ?)").run('7');
    const moduleInsert = database.prepare('INSERT INTO module_schema (module_id, schema_version, applied_at) VALUES (?, ?, ?)');
    for (const module of [['materials', 1], ['plans', 1], ['tasks', 1]]) moduleInsert.run(module[0], module[1], '2026-11-10T00:00:00.000Z');
    database.prepare('INSERT INTO request_log VALUES (?, ?, ?, ?, ?, ?)').run('req-1', 'tasks', 'listTasks', 'fingerprint', JSON.stringify({
      ok: true, value: { __REQUEST_LOG_MARKER__: true },
    }), '2026-11-10T00:00:00.000Z');
    database.prepare('INSERT INTO change_log (at, actor, entity, entity_id, action, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('2026-11-10T08:00:00.000Z', 'ui', 'task', 'task_1', 'create', null, JSON.stringify({ title: '复习函数定义域' }), '学生新建');
    database.prepare('INSERT INTO day_snapshot VALUES (?, ?, ?)').run('2026-11-10', JSON.stringify({ date: '2026-11-10', revision: 7, items: [] }), '2026-11-10T00:00:00.000Z');

    database.prepare('INSERT INTO study_goal VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'goal_1', '高考', 2027, '2027-06-07', 120, '每天两小时', 1,
      '2026-11-09T00:00:00.000Z', '2026-11-10T00:00:00.000Z',
    );
    database.prepare('INSERT INTO study_material VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'material_1', 'goal_1', 'textbook', '数学必修一', null, '数学', 'student', '学生自述', '2026-11-09',
      'text', 'verified', JSON.stringify([{ title: '第一章 函数', page: 1 }]), null,
      '2026-11-09T00:00:00.000Z', '2026-11-10T00:00:00.000Z',
    );
    const chunkInsert = database.prepare('INSERT INTO study_material_chunk VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    chunkInsert.run('chunk_1', 'material_1', 0, '函数是描述两个变量之间关系的对应。', 1, '第一章 函数', 0, 'page', 0, 21, '2026-11-09', '2026-11-09T00:00:00.000Z');
    chunkInsert.run('chunk_2', 'material_1', 1, '定义域是自变量的取值范围。', 2, '第一章 函数', 0, 'page', 22, 38, '2026-11-09', '2026-11-09T00:00:00.000Z');

    const taskInsert = database.prepare('INSERT INTO study_task VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    taskInsert.run('task_1', '复习函数定义域', '数学', 'material_1#第一章', '能说出定义域求法', 40, '[]', null, '2026-11-09T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
    taskInsert.run('task_2', '复习函数值域', '数学', 'material_1#第一章', '能独立完成 3 题', 30, JSON.stringify(['task_1']), null, '2026-11-09T00:00:00.000Z', '2026-11-10T00:00:00.000Z');

    const blockInsert = database.prepare('INSERT INTO study_time_block VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    blockInsert.run('block_1', '2026-11-11', 540, 580, 0, 'task_1', '复习函数定义域', null, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
    blockInsert.run('block_2', '2026-11-11', 600, 660, 1, null, '数学课', '固定课程', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');

    database.prepare('INSERT INTO study_plan VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'plan_1', 'goal_1', '函数复习计划', 'active', 1, 'revision_1',
      '2026-11-09T00:00:00.000Z', '2026-11-10T00:00:00.000Z',
    );
    const snapshot = {
      title: '函数复习计划',
      items: [
        { id: 'item_1', title: '定义域', date: '2026-11-11', start: '09:00', end: '09:40', estimateMinutes: 40, source: 'student' },
        { id: 'item_2', title: '值域', date: null, estimateMinutes: 30, source: 'agent' },
      ],
      stageGoals: ['掌握函数概念'],
      weekGoals: ['完成第一周计划'],
    };
    database.prepare('INSERT INTO study_plan_revision VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'revision_1', 'plan_1', 1, 'applied', 'confirm', '初版', 'ui',
      JSON.stringify(snapshot), '{}', null, '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z',
    );
    database.prepare('INSERT INTO study_plan_draft VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'plan_1', 'draft_1', 1, JSON.stringify({ ...snapshot, items: [...snapshot.items, { id: 'item_3', title: '函数图像', estimateMinutes: 20 }] }),
      '下次加图像', 'agent', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z',
    );
    const progressInsert = database.prepare('INSERT INTO study_plan_progress (plan_id, revision, item_id, date, status, quantity_done, quantity_total, note, confirmed, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    progressInsert.run('plan_1', 1, 'item_1', '2026-11-11', 'done', 1, 1, '完成', 1, 'ui', '2026-11-11T01:00:00.000Z');
    progressInsert.run('plan_1', 1, 'item_2', '2026-11-11', 'cancelled', null, null, '临时取消', 1, 'ui', '2026-11-11T02:00:00.000Z');
  } finally {
    database.close();
  }
}
