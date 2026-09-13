import crypto from 'node:crypto';

const COOKIE_NAME = 'simr_admin';
const MAX_AGE_SECONDS = 12 * 60 * 60;

function secret() {
  const value = process.env.SIMR_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('SIMR_SESSION_SECRET must be at least 32 characters');
  return value;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function passwordMatches(candidate) {
  const expected = process.env.SIMR_ADMIN_PASSWORD || '';
  return expected.length >= 12 && safeEqual(String(candidate || ''), expected);
}

export function createSessionCookie() {
  const payload = Buffer.from(JSON.stringify({ expiresAt: Date.now() + MAX_AGE_SECONDS * 1000 })).toString('base64url');
  return `${COOKIE_NAME}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function hasValidSession(headers = {}) {
  const cookieHeader = headers.cookie || headers.Cookie || '';
  const raw = cookieHeader.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  if (!raw) return false;

  const [payload, signature] = raw.split('.');
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(session.expiresAt) > Date.now();
  } catch {
    return false;
  }
}
