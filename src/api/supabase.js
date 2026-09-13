import { config } from '../config.js';
import { adminDataRequest } from './admin.js';

async function request(path, options = {}) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: config.supabasePublishableKey,
      Authorization: `Bearer ${config.supabasePublishableKey}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Database ${response.status}: ${detail}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

export const dbGet = (table, params = '', options = {}) => request(`${table}?${params}`, options);
export const dbPost = (table, body) => adminDataRequest({ method: 'POST', table, body });
export const dbPatch = (table, filter, body) => adminDataRequest({ method: 'PATCH', table, filter, body });
export const dbDelete = (table, filter) => adminDataRequest({ method: 'DELETE', table, filter });
export const dbUpsert = (table, body) => adminDataRequest({
  method: 'POST', table, body, prefer: 'resolution=merge-duplicates,return=representation'
});
