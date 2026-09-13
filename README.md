# SimR Scoring

SimR Scoring is the league website and administration system for SimR's Assetto Corsa racing. It publishes schedules, results, standings, driver profiles, and records, while giving league administrators one place to configure events, enter results, and manage scoring.

This repository is the maintainable source project for the site. The application remains a lightweight single-page website, but its styles, configuration, data access, league rules, tests, and secure server operations are separated instead of being maintained in one large HTML file.

## Public website

- Dashboard with the previous event, next event, recent results, and championship top five.
- Season standings with round-by-round points, drop-round handling, and career efficiency.
- Searchable result history with season, event, session, special-event, and event-group views.
- Driver cards and detailed profiles with career and season statistics.
- All-time records, lap records, sortable driver statistics, class filters, and season spotlights.
- Responsive dark and USA light themes.

## League administration

SimR uses a shared administrator password rather than individual user accounts. The password is checked by a Netlify Function, which creates a signed, secure administrator session. Browser visitors retain public read access, while database changes are sent through authenticated server functions.

Administrators can:

- Create, edit, lock, and complete seasons.
- Create championship rounds and one-off events.
- Group related special events and record round winners.
- Build qualifying, grid, and race session sequences.
- Assign different circuit layouts to individual sessions.
- Configure single-car and multi-car events.
- Maintain circuits, layouts, cars, drivers, display names, numbers, and screenshot aliases.
- Enter results manually or extract them from screenshots with Claude.
- Review extracted results before saving them.
- Configure points by finishing position and save reusable scoring presets.
- Apply per-race points multipliers and event-specific scoring.
- Configure Platinum, Gold, Silver, and Bronze efficiency thresholds.
- Enable or disable the season drop-round rule.
- Add race-director notes and generate screenshot-ready Discord result views.
- Maintain legacy career-stat floors for seasons without complete race data.

## Current scoring and driver classification

Championship points and driver classification are intentionally separate concepts.

- Finishing-position points come from the selected season or one-off event configuration.
- A race's `points_max` determines its multiplier relative to the configured P1 score.
- A DNF receives the points of the last classified finisher.
- When enabled, the drop-round rule removes the driver's lowest eligible event score.
- Current driver grades use career efficiency: points earned divided by the maximum points available in races entered.
- A driver needs at least five race starts before receiving a Platinum, Gold, Silver, or Bronze grade.

The shared implementations of these rules live in `src/domain/` and are covered by automated tests so every page uses the same calculation.

## Architecture

| Area | Technology | Responsibility |
| --- | --- | --- |
| Web application | Vite + vanilla JavaScript | Single-page user interface |
| Database | Supabase Postgres | League, event, driver, session, result, and configuration data |
| Public data access | Supabase publishable key | Read-only website data |
| Secure operations | Netlify Functions | Admin login, database mutations, and AI extraction |
| Screenshot extraction | Anthropic Claude | Converts race screenshots into reviewable result rows |
| Hosting and deployment | Netlify + GitHub | Builds and publishes the site from version-controlled source |

The browser never receives the Supabase service-role key, administrator password, session-signing secret, or Anthropic API key. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for module ownership and migration boundaries.

## Project structure

```text
simr-scoring/
├── index.html                     Application shell and current page markup
├── src/
│   ├── app.js                     Current UI orchestration
│   ├── api/                       Browser data, admin, and extraction clients
│   ├── domain/                    Authoritative scoring and classification rules
│   └── styles/                    Site styles
├── netlify/functions/             Server-only admin and AI endpoints
├── supabase/migrations/           Database security migrations
├── tests/                         Automated rule and security tests
├── docs/                          Architecture and deployment guides
├── netlify.toml                   Netlify build, routing, and headers
└── package.json                   Commands and dependencies
```

`src/app.js` still contains much of the established interface while the refactor proceeds feature by feature. The compatibility layer preserves current behavior during that migration; new business rules should be added to focused domain modules rather than duplicated in page code.

## Local development

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

Before committing a change:

```bash
npm test
npm run build
```

## Deployment

Netlify builds the site with `npm run build`, publishes `dist`, and deploys the functions in `netlify/functions`. Public `VITE_` configuration is embedded at build time; all password and provider keys remain server-only Netlify environment variables.

Follow [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) when configuring a new site or changing database security. In particular, verify the server-side admin workflow before applying the migration that removes anonymous database writes.

## Scope

The application currently presents Assetto Corsa as its active racing series. Historical Forza rows may remain in the database, but they are not loaded by the website and are not deleted by this project.

SimR is a recreational league project built to stay flexible as its rules and features evolve. Future driver-skill ratings can be developed as a separate system without changing championship scoring or erasing the existing career-efficiency statistic.
