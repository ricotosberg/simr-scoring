import { hasValidSession } from './_shared/admin-session.mjs';

export const handler = async event => ({
  statusCode: hasValidSession(event.headers) ? 200 : 401,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ authenticated: hasValidSession(event.headers) })
});
