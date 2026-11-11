/** Read only the user-authorized DeepSeek reference; never return credential documents to logs. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../source/deepseek-harness/apps/cli/package.json', import.meta.url));
const YAML = require('../../node_modules/.pnpm/node_modules/yaml');
export async function authorizedKey() {
  if (process.env.A02_API_KEY_FILE) {
    const value = (await readFile(process.env.A02_API_KEY_FILE, 'utf8')).trim();
    const key = value.startsWith('DEEPSEEK_API_KEY=') ? value.slice('DEEPSEEK_API_KEY='.length).trim().replace(/^['"]|['"]$/g, '') : value;
    if (!key || /\s/.test(key)) throw new Error('Dedicated credential file must contain one Key or one DEEPSEEK_API_KEY assignment');
    return key;
  }
  const inherited = process.env.DEEPSEEK_API_KEY;
  if (inherited) return inherited;
  const document = YAML.parse(await readFile(process.env.A02_DSH_CREDENTIALS_FILE ?? 'C:/Users/35373/.dsh/.credentials.yaml', 'utf8'));
  const entry = document?.refs?.DEEPSEEK_API_KEY ?? document?.DEEPSEEK_API_KEY;
  const key = typeof entry === 'string' ? entry : entry?.value;
  if (!key) throw new Error('Authorized DeepSeek reference was not found; no other credentials were inspected');
  return key;
}
