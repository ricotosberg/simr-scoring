import { clearSessionCookie } from './_shared/admin-session.mjs';

export const handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Set-Cookie': clearSessionCookie()
  },
  body: JSON.stringify({ authenticated: false })
});
