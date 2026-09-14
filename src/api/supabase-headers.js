export function createSupabaseHeaders(apiKey, { prefer = 'return=representation', headers = {} } = {}) {
  const requestHeaders = {
    apikey: apiKey,
    'Content-Type': 'application/json',
    Prefer: prefer,
    ...headers
  };

  if (!apiKey.startsWith('sb_publishable_') && !apiKey.startsWith('sb_secret_')) {
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }

  return requestHeaders;
}
