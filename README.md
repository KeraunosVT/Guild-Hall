# Gear Gap — Guild Hall

A guild-management web app for a *Throne & Liberty* guild, built around Discord: members log in with Discord OAuth, officers run the "war table" (attendance, loot council, rosters), and a companion Discord bot handles slash commands, timers, and announcements. Branding (house name, tag, motto) lives in one file and is meant to be re-themed per guild — see [Configuration](#configuration).

## Features

**For members**
- **Roster & War Record** — every member's all-time PvP stats, drill into a player's match history
- **Loot Wishlist** — pick items you want per build (PvP / PvE / Second Build); see live demand
- **Archboss Shards** — track how many of each archboss shard type you need, plus a weapon wishlist
- **Gear Level** — upload an in-game Equipment Level screenshot, parsed automatically (Gemini)
- **My Classes** — rank up to 3 classes per mode so officers can plan parties around your build
- **Leave of Absence** — submit LOA for a single event, a date range, or recurring days (pick more than one at once); optionally scope any of these to a time window (e.g. "I can make the 6pm event but I'm out after that," or "out 7–8pm, back after") — also via `/loa` in Discord

**For officers**
- **Attendance** — snap a voice channel's members into a logged event, tied to the recurring event schedule; also runnable straight from Discord via `/attendance`. Expanding a logged event splits everyone who didn't show into *excused* (an LOA was on file for that date) and *no-show* (neither turned up nor filed)
- **Loot Council** — see wishlist demand, award items, track Lucent and archboss-shard grants per member
- **Parties** — drag-and-drop party builder with roles, saved rosters, posts directly to Discord. Each roster is saved against the date/event it's for, so reopening it re-checks LOA for that occasion and reports what changed since — who has filed since you built it, and who's since cancelled. The posted image lists who's on leave underneath the parties, so members can see they were accounted for
- **Gear Levels / Merge Names** — guild-wide gear-level leaderboard; reconcile OCR-misread in-game names to the right player
- **Admin** — match/screenshot ingestion, member role management, event schedule management

**Discord bot**
- `/elitetimer`, `/elitetimers` — report and check elite boss respawn timers
- `/loa` — submit or cancel leave of absence from Discord
- `/attendance` — snap the caller's voice channel and log attendance for a scheduled event
- `/announce` — post a timed announcement (e.g. "get into CTA Comms") with a timestamp that renders in each viewer's own timezone

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

## Configuration

All configuration is environment variables, read from `backend/.env` (see `require('dotenv')` in `server.js`) or injected directly by your host. Nothing below is hardcoded except guild branding.

| Variable | Purpose |
|---|---|
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` | Discord OAuth2 app (member login) |
| `DISCORD_BOT_TOKEN` | Discord bot (gateway, slash commands, session re-verification) |
| `DISCORD_GUILD_ID` | The one Discord server this deployment is bound to |
| `DISCORD_ALLOWED_ROLE_IDS` | Comma-separated role IDs allowed to log in (empty = any member) |
| `DISCORD_ADMIN_ROLE_IDS` | Comma-separated role IDs granted officer/admin access |
| `DISCORD_MEMBER_ROLE_IDS` | Roles counted as "member" for roster display |
| `DISCORD_ROSTER_CHANNEL_ID`, `DISCORD_LOA_CHANNEL_ID`, `DISCORD_ANNOUNCE_CHANNEL_ID` | Channels each feature posts to |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Database connection |
| `JWT_SECRET` | Signs the session cookie |
| `GEMINI_API_KEY` | Screenshot parsing (match stats, gear level) |
| `GEMINI_MODEL` | Optional, defaults to `gemini-2.5-flash` |
| `PORT` | Optional, defaults to `3000` |
| `CORS_ORIGINS` | Optional, comma-separated trusted origins (local dev only — production is same-origin) |
| `APP_URL`, `NODE_ENV`, `SESSION_REVERIFY_MINUTES`, `GEAR_SUBMIT_LIMIT_PER_HOUR`, `IDENTITY_CACHE_SECONDS`, `MEMBER_CACHE_SECONDS`, `WEAPON_LEGEND_PATH` | Secondary tuning, all have sensible defaults |

Guild branding is edited in two files: the name, past-name aliases, timezone, and guild-night rollover in [`shared/guild.json`](shared/guild.json) (shared with the backend, which uses the aliases to keep a renamed guild's war record together), and the motto and creed in [`frontend/src/guild.js`](frontend/src/guild.js).

**Setting this up for your own guild?** Follow [`SETUP.md`](SETUP.md) — it walks through the Discord application, Supabase project, migrations, and every environment variable from zero to a working deployment.

### Guild nights run past midnight

A guild night doesn't end at midnight. The 12:30 AM Guild Field Boss is the tail of the previous evening's block, not the start of a new day — so "Saturday's events" means Saturday 8 PM through Sunday 12:30 AM, and a member who files *"out from 9 PM Saturday"* is out for that 12:30 AM boss too.

The schedule stores each event on the calendar day it **actually occurs** (the 12:30 AM boss is stored under Sunday). The code maps that back to the night it belongs to: anything before the `dayStart` rollover (default 01:00 in the guild's timezone) counts as the night before. Both the timezone and the rollover are set in [`shared/guild.json`](shared/guild.json) (`timezone`, `dayStart`) and read by backend and frontend alike, so they can't drift apart. `dayStart` must sit after the guild's latest event and before the earliest of the next evening.

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
