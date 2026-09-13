import { createSessionCookie, passwordMatches } from './_shared/admin-session.mjs';

const json = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  body: JSON.stringify(body)
});

export const handler = async event => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let input;
  try { input = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid request' }); }

  if (!passwordMatches(input.password)) return json(401, { error: 'Incorrect password' });
  return json(200, { authenticated: true }, { 'Set-Cookie': createSessionCookie() });
};
