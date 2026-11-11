/** Project deployment policy and first-run model defaults. Native DSH owns all later model edits. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('../', import.meta.url));
export const source = join(project, 'source/deepseek-harness');
const require = createRequire(join(source, 'packages/credentials/credentials-local/package.json'));
export const YAML = require('yaml');
export const customProvider = 'studybuddy-deepseek';
export const customKeyRef = 'STUDYBUDDY_DEEPSEEK_API_KEY';

/** The experimental bundle that ships personalized page cards, action cards, and their Creator. */
export const creatorBundle = '@deepseek-ai/dsh-personalized-recommendations';

/** Bundles every StudyBuddy Desktop profile loads; existing user bundles keep their order. */
const profileBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', creatorBundle];

/** Skill root discovered from the DSH user skill directory by every Agent preset. */
const creatorSkillSource = join(project, 'plugins/study/creator/skills/study-creator');

/** Account and storage policy contains no model-provider settings that would override native UI edits. */
export function deploymentPolicy(root) {
  return [
    ...['deepseek-account', 'llm-deepseek-account', 'ui-settings-account', 'account-controller',
      'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics'].map(id => ({ id, disabled: true })),
    { id: 'credentials', disabled: true },
    { id: 'workspace-controller', config: { documentsDirectory: join(root, 'workspace') } },
    { insert: [
      { id: 'project-credentials', name: join(project, 'platform/windows-credentials/index.mjs').replaceAll('\\', '/'), config: { path: join(root, 'home/credentials.dpapi') } },
      { id: 'study', name: join(project, 'plugins/study/host/index.mjs').replaceAll('\\', '/'), config: { dataDir: join(root, 'study') } },
      { id: 'a02-probe', name: join(project, 'probes/A02/index.mjs').replaceAll('\\', '/') },
    ] },
  ];
}

/**
 * Keep the Desktop profile manifest listing the bundles the product ships on.
 * The creator bundle is enabled once per data root: a later removal from the
 * Plugins page survives restarts, while a root created before this release is
 * migrated on its first launch. DSH owns the manifest after first boot, so
 * existing keys, dependencies and user-installed bundles are preserved.
 * @param {string} home - Harness home (`<data root>/home`).
 * @returns {Promise<{ profile: string, added: string[] }>} Manifest path and appended bundle ids.
 */
export async function ensureProfileBundles(home) {
  const profile = join(home, 'profiles/desktop');
  const manifestPath = join(profile, 'package.json');
  const marker = join(home, '.studybuddy-creator-enabled');
  await mkdir(profile, { recursive: true });
  let manifest = { name: 'dsh-profile-desktop', private: true, dependencies: {} };
  if (existsSync(manifestPath)) manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const current = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const creatorDisabledByUser = existsSync(marker) && !current.includes(creatorBundle);
  const added = profileBundles.filter(bundle => !current.includes(bundle)
    && (bundle !== creatorBundle || !creatorDisabledByUser));
  if (added.length === 0) {
    // The bundle may already be present (for example enabled from Plugins in an
    // older build); the marker records that the launcher has seen it enabled.
    if (!existsSync(marker) && current.includes(creatorBundle)) {
      await writeFile(marker, 'Enabled by scripts/start-studybuddy.mjs; remove to re-enable after disabling it in Plugins.\n');
    }
    return { profile, added };
  }
  const bundles = [...current, ...added];
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
  await writeFile(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n');
  if (!existsSync(marker)) await writeFile(marker, 'Enabled by scripts/start-studybuddy.mjs; remove to re-enable after disabling it in Plugins.\n');
  return { profile, added };
}

/**
 * Copy the StudyBuddy Creator reference into the DSH user skill root, where
 * every Agent preset (including the Creator child) discovers it. The runtime
 * copy is launcher-owned, so a repository edit reaches the next launch.
 * @param {string} home - Harness home (`<data root>/home`).
 * @returns {Promise<string>} Installed skill directory.
 */
export async function installCreatorSkill(home) {
  const destination = join(home, 'skills/study-creator');
  await rm(destination, { recursive: true, force: true });
  await cp(creatorSkillSource, destination, { recursive: true });
  return destination;
}

/** Create an editable native profile once, keeping saved models and defaults unchanged on later launches. */
export async function prepareProfile(root) {
  const home = join(root, 'home');
  const profilePatch = join(home, 'profiles/desktop/cordis.patch.yml');
  await mkdir(join(home, 'profiles/desktop'), { recursive: true });
  await ensureProfileBundles(home);
  await installCreatorSkill(home);
  const initial = [
    { id: 'llm-pi-ai', config: { providers: { [customProvider]: {
      displayName: 'StudyBuddy DeepSeek', apiKeyEnv: customKeyRef,
      api: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic',
      reasoning: 'high', models: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash',
        contextWindow: 1048576, maxTokens: 393216, input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
      }],
    } } } },
    { id: 'agent-default-model', config: { provider: customProvider, model: 'deepseek-flash', reasoningEffort: 'high' } },
  ];
  try { await writeFile(profilePatch, YAML.stringify(initial), { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // This file is launcher-owned policy. User-editable model settings live in the profile patch above.
  await writeFile(join(home, 'cordis.patch.yml'), '# Managed by scripts/start-studybuddy.mjs; edit models through DSH Settings.\n' + YAML.stringify(deploymentPolicy(root)));
  return { home, profilePatch, credentialPath: join(home, 'credentials.dpapi') };
}
