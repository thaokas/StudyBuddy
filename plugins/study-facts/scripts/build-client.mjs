/** Shell entry for the shared, plugin-directory-parameterized client builder. */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import * as shared from '../../study-core/scripts/build-client.mjs';
export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CLIENT_ROOT = join(PLUGIN_ROOT, 'client');
export const BARREL_FILE = join(CLIENT_ROOT, '.build', 'entry.js');
export const OUTPUT_FILE = join(CLIENT_ROOT, 'client.js');
export const SOURCE_ROOT = shared.SOURCE_ROOT;
export const BUNDLE_ID = '@studybuddy/study-facts';
export const discoverContributions = (root = CLIENT_ROOT) => shared.discoverContributions(root);
export const renderBarrel = shared.renderBarrel;
export const wrapBundle = (body, id = BUNDLE_ID) => shared.wrapBundle(body, id);
export const loadEsbuild = () => shared.loadEsbuild(PLUGIN_ROOT);
export const validateContributions = (contributions, root = CLIENT_ROOT) => shared.validateContributions(contributions, root, ['common', 'daily']);
export const buildClient = (options = {}) => shared.buildClient({ pluginRoot: PLUGIN_ROOT, bundleId: BUNDLE_ID, sharedMessages: ['common', 'daily'], ...options });
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await buildClient();
    console.log(JSON.stringify({ ok: true, bundle: 'client/client.js', barrel: 'client/.build/entry.js', bytes: result.bytes, ...result.contributions }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
