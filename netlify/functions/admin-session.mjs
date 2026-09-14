import { hasValidSession } from './_shared/admin-session.mjs';

export const handler = async event => {
  const authenticated = hasValidSession(event.headers);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ authenticated })
  };
};
