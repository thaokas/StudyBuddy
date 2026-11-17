/**
 * T16 configuration and reference contracts.
 *
 * These checks run without an application: they prove the isolated profile
 * enables the personalized-recommendations bundle, the StudyBuddy Creator
 * reference is mounted where DSH discovers skills, and the reference keeps the
 * StudyBuddy placement and data rules the smoke evidence depends on.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  creatorBundle, deploymentPolicy, ensureProfileBundles, prepareProfile,
} from '../../scripts/project-config.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const skill = join(project, 'skills/study-creator');

/** Read one reference file. */
async function reference(name) {
  return readFile(join(skill, 'references', name), 'utf8');
}

test('creator bundle and the four shipped presets stay wired to the isolated profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-creator-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await prepareProfile(root);
  const manifest = JSON.parse(await readFile(join(first.home, 'profiles/desktop/package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles.slice(0, 3), [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', creatorBundle,
  ]);
  assert.equal(manifest.dsh.profile.bundles.filter(name => name === creatorBundle).length, 1);
  assert.equal(manifest.name, 'dsh-profile-desktop');
  assert.equal(manifest.private, true);

  // The skill is mounted in the DSH user skill root, which every preset scans.
  const sk = await readFile(join(first.home, 'skills/study-creator/SKILL.md'), 'utf8');
  assert.match(sk, /^---\nname: study-creator\n/);
  await readFile(join(first.home, 'skills/study-creator/references/locations.md'));
  await readFile(join(first.home, 'skills/study-creator/references/data.md'));

  // A second launch neither duplicates the bundle nor rewrites DSH-owned keys.
  await ensureProfileBundles(first.home);
  const again = JSON.parse(await readFile(join(first.home, 'profiles/desktop/package.json'), 'utf8'));
  assert.deepEqual(again.dsh.profile.bundles, manifest.dsh.profile.bundles);

  const policy = deploymentPolicy(root);
  const study = policy.flatMap(row => row.insert ?? []).find(row => row.id === 'study-core');
  assert.ok(study, '部署策略必须插入 study 插件');
  assert.equal(study.config.dataDir, join(root, 'study'));
});

test('existing profile bundles, dependencies and unknown keys are preserved', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-creator-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const profile = join(home, 'profiles/desktop');
  await mkdir(profile, { recursive: true });
  const before = {
    name: 'dsh-profile-desktop', private: true,
    dependencies: { '@dsh-local/view-abc': 'link:./created-plugins/abc' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'custom-bundle'] } },
    customKey: { keep: true },
  };
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(before, undefined, 2)}\n`);
  const result = await ensureProfileBundles(home);
  assert.deepEqual(result.added, [creatorBundle]);
  const after = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.deepEqual(after.dsh.profile.bundles, [...before.dsh.profile.bundles, creatorBundle]);
  assert.deepEqual(after.dependencies, before.dependencies);
  assert.deepEqual(after.customKey, before.customKey);
});

test('a creator bundle removed after first enable is not re-enabled on the next launch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-creator-toggle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { home } = await prepareProfile(root);
  const manifestPath = join(home, 'profiles/desktop/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== creatorBundle);
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  const result = await ensureProfileBundles(home);
  assert.deepEqual(result.added, []);
  const after = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(after.dsh.profile.bundles.includes(creatorBundle), false, '插件页关闭后启动器不应把它加回来');
  assert.ok(after.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'));
});

test('creator skill frontmatter is discoverable and short enough to load', async () => {
  const text = await readFile(join(skill, 'SKILL.md'), 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(front, 'SKILL.md 必须有 YAML frontmatter');
  assert.match(front[1], /^name: study-creator$/m);
  assert.match(front[1], /^description: .{20,}$/m);
  assert.ok(text.length < 8192, `SKILL.md 超过 8192 字符：${text.length}`);
});

test('skill teaches the allowed placements and refuses the study layout', async () => {
  const body = await readFile(join(skill, 'SKILL.md'), 'utf8');
  const locations = await reference('locations.md');
  assert.match(body, /references\/locations\.md/);
  assert.match(body, /references\/data\.md/);
  for (const slot of ['conversation.view', 'sidebar.panellist', 'sidebar.right.pane.tab']) {
    assert.match(locations, new RegExp(slot.replaceAll('.', '\\.')));
  }
  assert.match(locations, /workbench/i);
  assert.match(locations, /compact display/i);
  assert.doesNotMatch(locations, /studyleft/);
  assert.match(locations, /iframe/);
  assert.match(locations, /must be removed on unload/i);
});

test('data reference shows both service entry points and names the forbidden files', async () => {
  const data = await reference('data.md');
  assert.match(data, /ctx\.study\.call\('tasks', 'day'/);
  assert.match(data, /POST \/api\/study\/<namespace>\/<method>/);
  for (const name of ['tasks', 'plans', 'materials', 'outcomes', 'followup', 'timer', 'memory']) {
    assert.match(data, new RegExp('`' + name + '`'));
  }
  for (const file of ['study.db', 'study.db-wal', 'memory.json', 'credentials.dpapi']) {
    assert.match(data, new RegExp(file.replaceAll('.', '\\.')));
  }
  assert.match(data, /expectedRevision/);
  assert.match(data, /requestId/);
  assert.match(data, /not a sandbox|not\s+a sandbox|is not a sandbox/i);
});

test('user documentation states the modes, default, switch timing, and recovery', async () => {
  const doc = await readFile(join(project, 'docs/creator.md'), 'utf8');
  assert.match(doc, /标准模式/);
  assert.match(doc, /PTC 模式/);
  assert.match(doc, /极简模式/);
  assert.match(doc, /创造模式/);
  assert.match(doc, /默认是标准模式/);
  assert.match(doc, /显式切换/);
  assert.match(doc, /切换只影响后续请求/);
  assert.match(doc, /重启/);
  assert.match(doc, /撤销/);
  assert.match(doc, /恢复/);
  assert.match(doc, /ctx\.study/);
  assert.match(doc, /不是沙箱/);
});
