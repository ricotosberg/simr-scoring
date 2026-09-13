function requireEnv(name) {
  const value = import.meta.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = Object.freeze({
  supabaseUrl: requireEnv('VITE_SUPABASE_URL'),
  supabasePublishableKey: requireEnv('VITE_SUPABASE_PUBLISHABLE_KEY'),
  series: Object.freeze({
    id: requireEnv('VITE_AC_SERIES_ID'),
    name: import.meta.env.VITE_AC_SERIES_NAME || 'Assetto Corsa'
  })
});
