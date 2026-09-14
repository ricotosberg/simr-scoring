import test from 'node:test';
import assert from 'node:assert/strict';
import { handler as login } from '../netlify/functions/admin-login.mjs';
import { handler as session } from '../netlify/functions/admin-session.mjs';
import { handler as adminData } from '../netlify/functions/admin-data.mjs';
import { createSessionCookie } from '../netlify/functions/_shared/admin-session.mjs';

process.env.SIMR_ADMIN_PASSWORD = 'test-password-long-enough';
process.env.SIMR_SESSION_SECRET = 'test-session-secret-that-is-longer-than-thirty-two-characters';

test('rejects the wrong shared password', async () => {
  const response = await login({
    httpMethod: 'POST',
    body: JSON.stringify({ password: 'wrong-password' })
  });
  assert.equal(response.statusCode, 401);
});

test('creates and verifies an httpOnly admin session', async () => {
  const loginResponse = await login({
    httpMethod: 'POST',
    body: JSON.stringify({ password: process.env.SIMR_ADMIN_PASSWORD })
  });
  assert.equal(loginResponse.statusCode, 200);
  assert.match(loginResponse.headers['Set-Cookie'], /HttpOnly/);
  assert.match(loginResponse.headers['Set-Cookie'], /SameSite=Strict/);

  const sessionResponse = await session({
    headers: { cookie: loginResponse.headers['Set-Cookie'] }
  });
  assert.equal(sessionResponse.statusCode, 200);
  assert.equal(JSON.parse(sessionResponse.body).authenticated, true);
});

test('reports a signed-out visitor without a console-level HTTP error', async () => {
  const response = await session({ headers: {} });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { authenticated: false });
});

test('blocks database mutations without an admin session', async () => {
  const response = await adminData({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ method: 'DELETE', table: 'events', filter: 'id=eq.test' })
  });
  assert.equal(response.statusCode, 401);
});

test('uses a modern Supabase secret key without treating it as a JWT', async () => {
  const originalFetch = global.fetch;
  const originalSecretKey = process.env.SUPABASE_SECRET_KEY;
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalUrl = process.env.SUPABASE_URL;
  let requestHeaders;

  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test-value';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  global.fetch = async (_url, options) => {
    requestHeaders = options.headers;
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const response = await adminData({
      httpMethod: 'POST',
      headers: { cookie: createSessionCookie() },
      body: JSON.stringify({ method: 'PATCH', table: 'events', filter: 'id=eq.test', body: { name: 'Test' } })
    });

    assert.equal(response.statusCode, 200);
    assert.equal(requestHeaders.apikey, 'sb_secret_test-value');
    assert.equal(Object.hasOwn(requestHeaders, 'Authorization'), false);
  } finally {
    global.fetch = originalFetch;
    if (originalSecretKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = originalSecretKey;
    if (originalServiceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
  }
});
