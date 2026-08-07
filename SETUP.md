# Setting up Guild Hall for your guild

This walks you from nothing to a working deployment. Budget 30–45 minutes the first time. You'll need:

- A **Discord server** you have admin rights on
- A free **[Supabase](https://supabase.com)** account (Postgres database + file storage)
- A **[Google AI Studio](https://aistudio.google.com/apikey)** API key (Gemini — parses screenshots; free tier is fine to start)
- Somewhere to run one Node process — **[Render](https://render.com)**, Railway, Fly.io, or your own box. This guide uses Render; the included `render.yaml` sets it up as a blueprint.

Rough running costs: hosting is free-tier-viable on Render (the free tier sleeps when idle, which also disconnects the Discord bot — the $7/mo tier keeps it always-on). Gemini charges per screenshot parsed; with `gemini-2.5-flash` a match upload costs a fraction of a cent, and the app rate-limits member gear submissions to 5/hour each.

---

## 1. Brand it as your guild

Edit **`shared/guild.json`**:

```json
{
  "house": "Your Guild Name",
  "tag": "Your Guild Name",
  "aliases": ["Your Guild Name"],
  "timezone": "America/New_York",
  "dayStart": "01:00"
}
```

- `house` — the ceremonial name shown large in the UI.
- `tag` — the in-game guild tag exactly as it appears on scoreboards. **This must match what the game shows**, or every uploaded match will treat your own players as an enemy guild.
- `aliases` — every name your guild has ever gone by in-game, including the current one. If you rename the guild later, **add** the new name; never remove old ones (past scoreboards recorded the old name forever).
- `timezone` — an [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) (`Europe/Berlin`, `Australia/Sydney`, …). Used for "today", event scheduling, LOA nights, and elite timers.
- `dayStart` — when a "guild night" rolls over to the next day. Events before this time count as the previous evening (so a 12:30 AM boss belongs to the night before). Must be later than your latest scheduled event and earlier than the next evening's first one. `01:00` is right for most guilds.

Then edit the motto and creed in **`frontend/src/guild.js`**, and replace **`frontend/public/sigil.svg`** with your own emblem if you have one.

## 2. Create the Discord application

Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.

**OAuth2 (member login):**
1. On the **OAuth2** page, copy the **Client ID** and **Client Secret** → these become `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
2. Under **Redirects**, add exactly:
   `https://<your-deployed-domain>/api/auth/discord/callback`
   (add `http://localhost:3000/api/auth/discord/callback` too if you'll develop locally). The same value goes in `DISCORD_REDIRECT_URI` — all three must match character-for-character.

**Bot (roster, slash commands, voice snapshots, session re-verification):**
1. On the **Bot** page, click **Reset Token** and copy it → `DISCORD_BOT_TOKEN`.
2. Under **Privileged Gateway Intents**, enable **Server Members Intent**. (Voice states, which `/attendance` uses, are a standard intent — nothing to enable.)
3. Invite the bot to your server: OAuth2 → URL Generator → scopes `bot` + `applications.commands`, bot permissions **View Channels**, **Send Messages**, **Embed Links**, **Attach Files** → open the generated URL and pick your server.

**Collect your IDs** (enable Developer Mode in Discord: User Settings → Advanced, then right-click → Copy ID):

| ID | Env var |
|---|---|
| Your server | `DISCORD_GUILD_ID` |
| Role(s) allowed to log in to the site | `DISCORD_ALLOWED_ROLE_IDS` (comma-separated; empty = any member) |
| Officer/admin role(s) — hold every capability, always | `DISCORD_ADMIN_ROLE_IDS` |
| Role(s) that count as "member" for rosters/attendance | `DISCORD_MEMBER_ROLE_IDS` (defaults to the allowed roles) |
| Channel for posted party rosters | `DISCORD_ROSTER_CHANNEL_ID` |
| Channel for LOA announcements | `DISCORD_LOA_CHANNEL_ID` |
| Channel for `/announce` posts | `DISCORD_ANNOUNCE_CHANNEL_ID` |

> `DISCORD_ADMIN_ROLE_IDS` is the escape hatch: anyone holding one of these roles has every permission regardless of what's granted in the site's Permissions page, so a bad grant can never lock everyone out. Set it to your officer role and use the in-app Permissions page for anything finer.

## 3. Create the Supabase project

1. [supabase.com](https://supabase.com) → New project. Pick a strong database password (you won't need it day-to-day).
2. From **Project Settings → API**, copy:
   - **Project URL** → `SUPABASE_URL`
   - **`service_role` secret key** → `SUPABASE_SERVICE_KEY` (⚠️ the *service role* key, not the anon key — and never expose it anywhere client-side)
3. Open the **SQL Editor** and run each file in `migrations/` **in numeric order**, starting with `000_baseline.sql`, then `001` … `011`. Paste one file, Run, repeat. `000` creates every table, the SQL functions, and the public `assets` storage bucket; the rest bring the schema up to current.

That's the whole database setup — the app never needs Supabase Auth or client-side keys.

## 4. Get a Gemini API key

[Google AI Studio](https://aistudio.google.com/apikey) → Create API key → `GEMINI_API_KEY`. The default model (`gemini-2.5-flash`) is set in code; override with `GEMINI_MODEL` if it's ever retired.

Optional but recommended: keep a labeled weapon-icon reference image at `backend/assets/weapon_legend.png` (one is included). It's sent alongside every scoreboard screenshot and is the single biggest accuracy win for weapon detection.

## 5. Deploy

### Render (blueprint)

1. Push your configured copy of this repo to your own GitHub.
2. Render dashboard → **New → Blueprint** → point it at your repo. It reads `render.yaml` and creates the web service.
3. Fill in every environment variable it prompts for (the table below). For `DISCORD_REDIRECT_URI` and `APP_URL` you need the service's URL — Render shows it as soon as the service is created (`https://<name>.onrender.com`), so you can create first, then set the two URL vars and the matching redirect in the Discord portal.
4. Deploy. First build takes a few minutes (it builds the frontend). Watch the logs for the startup checks: `✅ Supabase client initialized`, `✅ Discord gateway connected`.

### Anywhere else

Any host that runs one Node 18+ process works identically:

```bash
npm install    # root postinstall installs backend + frontend and builds the frontend
npm start      # serves API + built frontend on $PORT (default 3000)
```

Set the environment variables below (locally: put them in `backend/.env`).

### Environment variable reference

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_CLIENT_ID` | ✅ | OAuth2 app |
| `DISCORD_CLIENT_SECRET` | ✅ | OAuth2 app |
| `DISCORD_REDIRECT_URI` | ✅ | Must match the Discord portal exactly |
| `DISCORD_GUILD_ID` | ✅ | Your server |
| `JWT_SECRET` | ✅ | Long random string: `openssl rand -hex 32` |
| `SUPABASE_URL` | ✅ | Project URL |
| `SUPABASE_SERVICE_KEY` | ✅ | Service-role key |
| `DISCORD_BOT_TOKEN` | Strongly recommended | Without it: no bot, no slash commands, no rosters, no session re-verification (kicked members keep access until their 7-day session expires) |
| `DISCORD_ADMIN_ROLE_IDS` | Strongly recommended | Empty = nobody is admin until granted via… the admin page. Set it. |
| `GEMINI_API_KEY` | Strongly recommended | Without it, screenshot parsing (matches + gear) is unavailable; CSV upload still works |
| `APP_URL` | Recommended | Your site's public URL; used for post-login redirects (default `/` works when same-origin) |
| `DISCORD_ALLOWED_ROLE_IDS` | Optional | Empty = any server member may log in |
| `DISCORD_MEMBER_ROLE_IDS` | Optional | Defaults to `DISCORD_ALLOWED_ROLE_IDS` |
| `DISCORD_ROSTER_CHANNEL_ID` | Optional | Needed to post rosters |
| `DISCORD_LOA_CHANNEL_ID` | Optional | Needed for LOA announcements |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Optional | Needed for `/announce` |
| `NODE_ENV` | Recommended: `production` | Enables Secure cookies |
| `GEMINI_MODEL` | Optional | Default `gemini-2.5-flash` |
| `GEAR_SUBMIT_LIMIT_PER_HOUR` | Optional | Default 5 |
| `SESSION_REVERIFY_MINUTES` | Optional | Default 60 |
| `MEMBER_CACHE_SECONDS` / `IDENTITY_CACHE_SECONDS` | Optional | Defaults 60 / 30 |
| `WEAPON_LEGEND_PATH` | Optional | Default `backend/assets/weapon_legend.png` |
| `CORS_ORIGINS` | Optional | Only for a trusted separate origin calling the API; local dev doesn't need it (Vite proxies) |
| `PORT` | Optional | Default 3000 |

## 6. First login checklist

1. Open your deployed URL → **Log in with Discord**. If you get `?auth=not_member`, you're not in the configured server; `?auth=forbidden`, you don't hold an allowed role.
2. Confirm the **Admin** section appears in the sidebar (you hold an admin role).
3. Admin → **Event Schedule**: add your recurring events. Everything LOA- and attendance-related keys off this.
4. Admin → **Upload Match**: feed it a scoreboard screenshot and review what comes back.
5. Admin → **Merge Names**: as matches accumulate, map in-game names to Discord members here — it's what links war records, attendance, gear, and loot into one profile per person.
6. Admin → **Permissions**: grant finer capabilities (loot council, attendance, …) to non-admin officer roles as needed.

## Troubleshooting

- **"Discord login is not configured"** — one of the five required auth vars is missing; the app deliberately locks everything until all are present.
- **Login redirects with `?auth=error`** — almost always a `DISCORD_REDIRECT_URI` mismatch (portal vs env var vs actual URL, including http/https).
- **"save_match() is missing"** on match upload — `000_baseline.sql` wasn't run (or not fully).
- **Member list / rosters return 502** — bot token missing, bot not invited to the server, or Server Members Intent not enabled.
- **Slash commands don't appear** — `DISCORD_CLIENT_ID` missing (commands register at gateway connect; check logs), or the bot was invited without the `applications.commands` scope.
- **Screenshot parsing fails immediately** — `GEMINI_API_KEY` missing or over quota; the error message passes through.
- **Bot goes offline periodically on Render free tier** — the service sleeps when idle; upgrade to a paid instance for an always-on bot.

## Updating later

Add the original repo as an upstream remote and merge:

```bash
git remote add upstream https://github.com/KeraunosVT/Guild-Hall.git
git fetch upstream
git merge upstream/main
```

Then run any **new** files in `migrations/` (they're append-only and numbered — run the ones you haven't run yet, in order) and redeploy.
