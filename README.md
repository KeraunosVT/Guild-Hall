# Gear Gap — Guild Hall

A guild-management web app for *Throne & Liberty* guilds, built around Discord: members log in with Discord OAuth, officers run the "war table" (attendance, loot council, rosters), and a companion Discord bot handles slash commands, timers, and announcements.

One deployment serves **many guilds**. Each Discord server is a tenant row in the `guilds` table carrying its own name, tag, timezone, roles and channels, and every query is scoped to it — there is no shared "the guild" anywhere in the code. Officers change their own settings in-app on the Guild Settings page; a new tenant is created with `backend/scripts/onboardGuild.js`. See [Configuration](#configuration).

## Features

**For members**
- **Roster & War Record** — every member's all-time PvP stats, drill into a player's match history
- **Loot Wishlist** — pick items you want per build (PvP / PvE / Second Build); see live demand
- **Archboss Shards** — track how many of each archboss shard type you need, plus a weapon wishlist
- **Gear Level** — upload an in-game Equipment Level screenshot, parsed automatically (Gemini)
- **My Classes** — rank up to 3 classes per mode so officers can plan parties around your build
- **Leave of Absence** — submit LOA for a single event, a date range, or recurring days (pick more than one at once); optionally scope any of these to a time window (e.g. "I can make the 6pm event but I'm out after that," or "out 7–8pm, back after") — also via `/loa` in Discord
- **Signups** — say you're coming to a given night, from the website or from the buttons on the Discord post. Opt-in only: a signup means *I'm coming*, and there is no way to record "not coming" — that stays LOA's job, so the two records can never disagree. Optional capacity with a waitlist that promotes itself the moment someone withdraws

**For officers**
- **Attendance** — one row across the top logs a night: the attendance voice channel is set once in Guild Settings and snapped from there, so the only per-night choices are the event, its date and the party fielded. Also runnable straight from Discord via `/attendance`. Below it, every member's attendance rate over the last week, fortnight or 30 days, with the past events in that same window listed beside it — one filter governs both, so the rate and the events explaining it can never disagree
- **The night itself** — every logged event gets its own page: one row per member with their role and class, a single status (*attended*, *pending approval*, *no-show (signed up)*, *LOA*), when they signed up and when the record last changed. Anyone who never answered at all is listed separately underneath. Sortable, paginated, and selectable so officers can approve, add or remove people in bulk. A **Details** tab carries the night's numbers and a **Parties** tab the frozen copy of the party it fielded — editing a saved roster later can't rewrite what a past night says it ran with. Member-visible with the officer controls gated inline; the free text behind an absence stays officer-only
- **Late attendance** — a member the snapshot missed can ask to be added, from the website or `/attendance-late`, for 24 hours after attendance was taken. An officer approves or denies it; nobody writes their own attendance. Denials stay on the record, because "did anyone actually look at this" is a question worth being able to answer
- **Loot Council** — see wishlist demand, award items, track Lucent and archboss-shard grants per member
- **Parties** — drag-and-drop party builder with roles, saved rosters, posts directly to Discord. Each roster is saved against the date/event it's for, so reopening it re-checks LOA for that occasion and reports what changed since — who has filed since you built it, and who's since cancelled. The posted image lists who's on leave underneath the parties, so members can see they were accounted for
- **Signups** — open a night for signups and post it to Discord with an optional role @-mention; set a capacity, add someone who asked in voice chat, and DM a reminder to exactly the people who have neither signed up nor filed an LOA. Feeds the party builder (seed parties straight from who's coming) and the attendance breakdown (a *signed up, didn't show* bucket)
- **Gear Levels / Merge Names** — guild-wide gear-level leaderboard; reconcile OCR-misread in-game names to the right player
- **Guild Settings** — house name, past in-game names, timezone, guild-night rollover, and every Discord role and channel, editable in-app. Every change is audited, and the two changes that could lock the guild out of its own hall are refused rather than confirmed
- **Admin** — match/screenshot ingestion, member role management, event schedule management, per-capability permission grants

**Discord bot**
- `/elitetimer`, `/elitetimers` — report and check elite boss respawn timers
- `/loa` — submit or cancel leave of absence from Discord
- `/attendance` — snap the caller's voice channel and log attendance for a scheduled event
- `/announce` — post a timed announcement (e.g. "get into CTA Comms") with a timestamp that renders in each viewer's own timezone
- **Signup buttons** — not a command: signup posts carry *I'm in* / *Withdraw* / *Who's coming?*. Everything needed to act on a click is in the button itself, so posts stay live across restarts and deploys. The full member-facing reference is served at `/commands`

## Tech stack

- **Frontend**: React + Vite, React Router, Tailwind CSS
- **Backend**: Node.js + Express, `discord.js` (bot/gateway), Discord OAuth2 (login)
- **Database**: Supabase (Postgres)
- **AI**: Google Gemini — parses screenshot uploads (match scoreboards, gear level windows)

Backend and frontend deploy as a single process: `server.js` serves the built frontend (`frontend/dist`) statically alongside the `/api` routes, so there's one server to run.

## Project structure

```
backend/     Express API, Discord bot/gateway, Supabase access
frontend/    React app (Vite)
shared/      Game-data JSON shared by both (shards, weapons, elite boss locations, etc.)
migrations/  SQL, run by hand in the Supabase editor. 000–012 are the original
             single-tenant schema; the multi-tenant line starts at saas_000_baseline.sql
```

## Local development

Requires Node 18+ and a Supabase project (Postgres).

```bash
# from the repo root
npm install        # installs backend + frontend deps, builds the frontend once

# then, for active development with hot reload:
cd backend && npm start      # API on :3000
cd frontend && npm run dev   # Vite dev server on :5173
```

The Vite dev server proxies `/api` to the backend on `:3000` (see `frontend/vite.config.js`), so no CORS configuration is needed for local development — the browser only ever talks to `:5173`. `CORS_ORIGINS` exists only for the unusual case of a trusted separate origin calling the API directly.

## Tests

```bash
cd backend && npm test
```

Six suites, cheapest first, stopping at the first failure. The first is static and needs no database, so a structural mistake is reported in about a second:

- **leak audit** — reads the source, not the runtime: every Supabase query is scoped by guild or explicitly allow-listed, every module-level cache is keyed by guild, every `onConflict` target includes `guild_id`, and no per-guild config is read from the environment
- **login flow** — OAuth, the session cookie, and which guilds a session may touch
- **bot isolation** — the real interaction handler against the real database with a fake Discord client. No gateway connection, no bot token, no message ever sent
- **API isolation** — two tenants with *deliberately colliding* data, sweeping every route and then pointing guild A's officer at guild B's row ids
- **signup semantics** — correctness within one guild rather than isolation between two: capacity, waitlist order, and the races the signup Postgres functions exist to serialise, driven concurrently against a real database
- **late attendance semantics** — the same shape of question for late requests: both sides of the 24-hour boundary, two officers approving the same request at once producing one attendance row and one refusal, and a request belonging to whoever filed it. Every one of these fails silently when it's wrong, which is why it gets a suite

Set `TEST_SUPABASE_URL` / `TEST_SUPABASE_SERVICE_KEY` to point the database-backed suites at a scratch project. The harness refuses to run against a database that already holds real guild data.

## Configuration

Configuration comes in two halves, and which half a setting belongs in is not a matter of taste:

**Deployment secrets** are environment variables, read from `backend/.env` (see `require('dotenv')` in `server.js`) or injected by your host. These are the same for every guild the deployment serves.

| Variable | Purpose |
|---|---|
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` | Discord OAuth2 app (member login) |
| `DISCORD_BOT_TOKEN` | Discord bot (gateway, slash commands, session re-verification) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Database connection |
| `JWT_SECRET` | Signs the session cookie |
| `GEMINI_API_KEY` | Screenshot parsing (match stats, gear level) |
| `GEMINI_MODEL` | Optional, defaults to `gemini-2.5-flash` |
| `PORT` | Optional, defaults to `3000` |
| `CORS_ORIGINS` | Optional, comma-separated trusted origins (local dev only — production is same-origin) |
| `SINGLE_GUILD_ID` | Optional. Pins the whole deployment to one tenant's `guilds.id`, for a private single-guild install |
| `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_KEY` | Optional. A scratch Supabase project for the test suite to write to, so tests never touch live data |
| `APP_URL`, `NODE_ENV`, `SESSION_REVERIFY_MINUTES`, `GEAR_SUBMIT_LIMIT_PER_HOUR`, `IDENTITY_CACHE_SECONDS`, `MEMBER_CACHE_SECONDS`, `GUILD_REGISTRY_CACHE_SECONDS`, `WEAPON_LEGEND_PATH` | Secondary tuning, all have sensible defaults |

**Per-guild config** lives on that guild's row in the `guilds` table — house name, tag, past-name aliases, motto, creed, timezone, guild-night rollover, officer/allow-list/roster role ids, every channel the bot posts to, and one it reads from (`attendance_voice_channel_id`, the voice channel `/attendance` snaps when nobody names another). Officers edit it themselves at **Guild Settings** in the app; a new tenant is seeded with `node backend/scripts/onboardGuild.js --config guild.json` (`--dry-run` prints what it would write).

None of this may ever move into an environment variable. One deployment serves many Discord servers, so an env var holding a role or channel id would silently apply one guild's configuration to all of them — posting House A's LOAs into House B's channel with no error anywhere. `backend/test/leakAudit.js` fails the build if any of the old `DISCORD_*_ROLE_IDS` / `DISCORD_*_CHANNEL_ID` names is read from `process.env` again.

**Setting this up for your own guild?** [`SETUP.md`](SETUP.md) walks through the Discord application, the Supabase project and every environment variable. ⚠️ It has not been revised since the multi-tenant conversion: it still tells you to edit a `shared/guild.json` that no longer exists, and its migration list stops at `011` without mentioning the `saas_*` line. Use it for the Discord and Supabase setup, then create your tenant with `onboardGuild.js` rather than a config file.

### Guild nights run past midnight

A guild night doesn't end at midnight. The 12:30 AM Guild Field Boss is the tail of the previous evening's block, not the start of a new day — so "Saturday's events" means Saturday 8 PM through Sunday 12:30 AM, and a member who files *"out from 9 PM Saturday"* is out for that 12:30 AM boss too.

The schedule stores each event on the calendar day it **actually occurs** (the 12:30 AM boss is stored under Sunday). The code maps that back to the night it belongs to: anything before the rollover (default 01:00 in the guild's timezone) counts as the night before. Both the timezone and the rollover are per-guild — `guilds.timezone` and `guilds.day_start`, edited on the Guild Settings page — and the same rules are implemented once in `backend/loa.js` and mirrored in `frontend/src/timeUtils.js` so the two surfaces can't disagree. `day_start` must sit after the guild's latest event and before the earliest of the next evening.

Two consequences worth knowing:

- Times are never compared as `"HH:MM"` strings, since `"00:30" < "21:00"` is true as text but false as a night. Everything goes through `daySlot()`, which measures minutes from the start of the guild night.
- An LOA whose end time is earlier than its start is read as crossing midnight, so *"out 11 PM–1 AM"* is a valid window.

To check which day each event is filed under: `node scripts/dumpEventSchedule.js` (read-only).

### Weapon legend (optional, improves screenshot accuracy)

Place a reference image at `backend/assets/weapon_legend.png` (or override the path with `WEAPON_LEGEND_PATH`) showing each Throne & Liberty weapon icon next to its name. When present, it's sent to Gemini as the first image on every screenshot parse so the model can compare each scoreboard icon against a labeled reference — the single biggest accuracy win for weapon detection. Without it, screenshot reading still works from the text descriptions in the prompt, just a bit less reliably.

## Deployment

This runs as a single Node process (Render, Railway, Fly, or similar all work with zero code changes) — the root `postinstall` script installs both `backend/` and `frontend/` and builds the frontend; `npm start` runs `backend/server.js`, which serves everything. Make sure `DISCORD_REDIRECT_URI` matches both your deployed URL and the redirect registered in the Discord Developer Portal.

## License

[AGPL-3.0](LICENSE). Self-host it, re-theme it, run it for your guild freely. If you modify it and run it as a service, the license requires making your modified source available to your users — a link to your fork covers it.
