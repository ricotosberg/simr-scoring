import { hasValidSession } from './_shared/admin-session.mjs';

const TABLES = new Set([
  'series', 'drivers', 'seasons', 'events', 'sessions', 'results',
  'scoring_config', 'classification_config', 'career_stats', 'admin_config',
  'circuits', 'circuit_layouts', 'season_drivers', 'cars', 'event_groups'
]);
const METHODS = new Set(['POST', 'PATCH', 'DELETE']);

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

export const handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!hasValidSession(event.headers)) return json(401, { error: 'Admin session required' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !secretKey) return json(500, { error: 'Database admin access is not configured' });

  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid request' }); }

  const method = String(input.method || '').toUpperCase();
  const table = String(input.table || '');
  if (!METHODS.has(method) || !TABLES.has(table)) return json(400, { error: 'Invalid operation' });

  const rawFilter = input.filter ? String(input.filter) : '';
  if (/\s|#|\?/.test(rawFilter)) return json(400, { error: 'Invalid database filter' });
  const filter = rawFilter ? `?${rawFilter}` : '';

  const headers = {
    apikey: secretKey,
    'Content-Type': 'application/json',
    Prefer: input.prefer || 'return=representation'
  };
  if (!secretKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secretKey}`;

  const response = await fetch(`${supabaseUrl}/rest/v1/${table}${filter}`, {
    method,
    headers,
    body: method === 'DELETE' ? undefined : JSON.stringify(input.body)
  });

  const text = await response.text();
  if (!response.ok) {
    console.error('Admin data request failed', response.status, text.slice(0, 300));
    return json(response.status, { error: 'Database operation failed' });
  }
  return json(200, { data: text ? JSON.parse(text) : [] });
};
