/** Resolve the user-authorized dated Flash model from the official catalog before any paid request. */
export async function officialModel(key) {
  const response = await fetch('https://api.deepseek.com/models', { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Official model listing HTTP ${response.status}`);
  const body = await response.json();
  const entries = Array.isArray(body.data) ? body.data : body.models;
  if (!Array.isArray(entries)) throw new Error('Official model listing did not contain an array');
  let candidates = entries.filter(entry => {
    const identity = `${entry.id} ${entry.name ?? ''} ${entry.display_name ?? ''}`;
    return /flash/i.test(identity) && /1017/.test(identity);
  });
  const dated = candidates.length === 1;
  if (candidates.length === 0) candidates = entries.filter(entry => entry.id === 'deepseek-flash' && /4\.1.*flash|flash.*4\.1/i.test(entry.name ?? entry.display_name ?? ''));
  if (candidates.length !== 1) throw new Error('Expected exactly one official Flash 1017 model; confirm the precise model ID before proceeding');
  return { id: candidates[0].id, name: candidates[0].name ?? candidates[0].display_name ?? candidates[0].id,
    requestedRevision: 'Flash 4.1 1017', datedRevisionConfirmed: dated, listingEndpoint: 'https://api.deepseek.com/models' };
}
