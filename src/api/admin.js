async function callAdminFunction(name, body) {
  const response = await fetch(`/.netlify/functions/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Admin request failed (${response.status})`);
  return payload;
}

export const loginWithSharedPassword = password => callAdminFunction('admin-login', { password });
export const logoutAdmin = () => callAdminFunction('admin-logout');

export async function getAdminSession() {
  try {
    const response = await fetch('/.netlify/functions/admin-session', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const adminDataRequest = request => callAdminFunction('admin-data', request)
  .then(payload => payload.data || []);
