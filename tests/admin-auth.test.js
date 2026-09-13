import test from 'node:test';
import assert from 'node:assert/strict';
import { handler as login } from '../netlify/functions/admin-login.mjs';
import { handler as session } from '../netlify/functions/admin-session.mjs';
import { handler as adminData } from '../netlify/functions/admin-data.mjs';

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
});

test('blocks database mutations without an admin session', async () => {
  const response = await adminData({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ method: 'DELETE', table: 'events', filter: 'id=eq.test' })
  });
  assert.equal(response.statusCode, 401);
});
