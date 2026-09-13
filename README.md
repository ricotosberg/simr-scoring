# SimR Scoring

This is the maintainable SimR source project: Vite + vanilla JavaScript modules, Supabase, and Netlify Functions. It preserves the existing UI and league behavior while progressively extracting authoritative domain rules and server-only operations.

## Local commands

```bash
npm install
npm test
npm run dev
npm run build
```

Create `.env` from `.env.example` before running the app. See `docs/DEPLOYMENT.md` for the safe live migration order and `docs/ARCHITECTURE.md` for ownership rules.

## Structured-project baseline

- AC is the only active series in the application; existing Forza data is not deleted.
- CSS, configuration, API access, league rules, and server functions are separated.
- Points, multipliers, DNF scoring, drop rounds, and grade calculation have authoritative modules with tests.
- Anthropic credentials and calls are removed from browser code.
- The shared admin-password experience remains, but authentication and database mutations move to Netlify Functions.

The uploaded v25 file remains the behavior reference outside this project. It is deliberately not copied into the repository because it contained exposed credentials.
