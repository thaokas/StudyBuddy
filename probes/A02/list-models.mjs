/** Credential-safe official discovery; prints model catalog only. */
import { authorizedKey } from './credentials.mjs';
const key = await authorizedKey();
console.log(JSON.stringify({ credentialFound: Boolean(key) }));
const response = await fetch('https://api.deepseek.com/models', { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`Official model listing HTTP ${response.status}`);
const data = await response.json();
console.log(JSON.stringify(data));
