# Deploying v26 to Netlify

## 1. Configure environment variables

Copy the names from `.env.example` into the Netlify site's environment variables. Use the AC series UUID for `VITE_AC_SERIES_ID`. The service-role key and all password/secret values are server-only.

Generate `SIMR_SESSION_SECRET` as a long random value. Choose a new shared admin password; do not reuse the password that was exposed in v25.

## 2. Rotate the exposed AI key

Revoke the Anthropic key embedded in v25, create a replacement, and store the replacement only as `ANTHROPIC_API_KEY` in Netlify.

## 3. Deploy without changing RLS yet

Build command: `npm run build`

Publish directory: `dist`

Functions directory: `netlify/functions`

Confirm public pages load, screenshot extraction works, the shared password signs in, and at least one reversible admin edit succeeds.

## 4. Lock public database writes

After the Netlify admin path is verified, run `supabase/migrations/20260912_lock_public_writes.sql` in the Supabase SQL editor. This deletes the old database-stored password, removes permissive policies, keeps public reads, and makes writes available only through the server function.

Do not run the migration before the server-side admin path has been tested. The old v25 deployment will no longer be able to write afterward.

## 5. Final verification

- Incognito visitors can view public results but cannot call database writes with the publishable key.
- The shared password enables admin controls.
- Signing out invalidates the admin cookie.
- Result entry, session edits, scoring edits, and deletes still work.
- No secret appears in built JavaScript under `dist/assets`.
