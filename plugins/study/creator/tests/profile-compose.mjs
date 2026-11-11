/**
 * T16 profile composition evidence.
 *
 * `prepareProfile` writes the isolated Desktop profile; this script loads that
 * profile exactly as the Desktop Host does (installation-first bundle
 * resolution) and proves the personalized-recommendations layer composes with
 * the base and Web layers, with no skipped bundle and the Creator reference
 * mounted in the DSH user skill root. It needs no browser or model.
 *
 * Run: `node plugins/study/creator/tests/profile-compose.mjs`
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareProfile, creatorBundle, project } from '../../../../scripts/project-config.mjs';

const SOURCE = join(project, 'source/deepseek-harness');
const EVIDENCE = fileURLToPath(new URL('../evidence/', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'study-creator-compose-'));
const report = { started: new Date().toISOString(), passed: false };
try {
  const { home } = await prepareProfile(root);
  const profileDir = join(home, 'profiles/desktop');
  const { loadProfileDirectory } = await import(
    pathToFileURL(join(SOURCE, 'packages/boot/app-boot/lib/index.js')).href
  );
  const profile = loadProfileDirectory('t16-compose', profileDir, join(SOURCE, 'apps/cli/package.json'));
  const layers = profile.layers.map(layer => layer.packageName);
  const creatorLayer = profile.layers.find(layer => layer.packageName === creatorBundle);
  assert.ok(creatorLayer, `profile 应解析 ${creatorBundle}：${JSON.stringify(profile.skippedBundles)}`);
  assert.deepEqual(profile.skippedBundles, []);
  assert.deepEqual(layers.slice(0, 3), [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', creatorBundle,
  ]);
  const rows = creatorLayer.patches.flatMap(patch => patch.insert ?? []);
  for (const id of [
    'action-cards', 'client-ui-action-cards', 'creation-recommendations',
    'client-ui-creation-recommendations', 'plugin-recommendations', 'client-ui-plugin-recommendations',
  ]) {
    assert.ok(rows.some(row => row.id === id), `creator 层缺少 ${id}`);
  }
  const skill = join(home, 'skills/study-creator/SKILL.md');
  assert.ok((await stat(skill)).isFile(), 'Creator 参考应挂载到 DSH user skill root');
  const text = await readFile(skill, 'utf8');
  assert.match(text, /^---\nname: study-creator\n/);
  const marker = join(home, '.studybuddy-creator-enabled');
  assert.ok((await stat(marker)).isFile(), '首次启用应留下标记文件');
  report.checks = { layers, skipped: profile.skippedBundles, creatorRows: rows.map(row => row.id), skill, marker };
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(join(EVIDENCE, 'profile-compose.json'), `${JSON.stringify(report, undefined, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, undefined, 2));
}
