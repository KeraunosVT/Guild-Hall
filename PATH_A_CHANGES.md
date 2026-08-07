# Path A changes — what's in this package and how to apply it

## New files
| File | What it is |
|---|---|
| `migrations/000_baseline.sql` | The reconstructed base schema: every table, index, the four SQL functions (`save_match`, `get_player_stats`, `get_stats_summary`, `get_guild_player_counts`), the `assets` storage bucket, and RLS enabled everywhere. Verified by running 000→011 in order on a clean Postgres 16 and exercising the functions. |
| `SETUP.md` | Zero-to-deployed guide: Discord app, Supabase, migrations, full env var table, first-login checklist, troubleshooting, update procedure. |
| `render.yaml` | Render blueprint — New → Blueprint → your fork, fill in the prompted secrets. |
| `LICENSE` | AGPL-3.0 (official text via SPDX). Anyone running a **modified** copy as a network service must publish their modifications. If you want to keep the option of relicensing or dual-licensing later, merge outside contributions only with that in mind — see the licensing note below. |

## Changed files
| File | Change |
|---|---|
| `shared/guild.json` | Added `timezone` and `dayStart` — the last two guild-specific values that were hardcoded. |
| `backend/loa.js` | Reads timezone/dayStart from guild.json (fallbacks preserve old behavior). |
| `backend/eliteTimers.js` | Reads timezone from guild.json. |
| `frontend/src/timeUtils.js` | Reads both from guild.json — backend and frontend can no longer drift. |
| `backend/ingest.js` | Fixed the legend filename (`weapon-legend.png` → `weapon_legend.png`) — the reference legend was silently never being sent to Gemini. |
| `backend/server.js` | (1) RPCs now take `p_guild_names` so the SQL functions are guild-agnostic; (2) JSON error handler added — oversized uploads now return a 413 JSON error instead of an HTML stack page; (3) rate-limit message interpolates the configured limit. |
| `backend/admin.js` | `get_guild_player_counts` now takes `p_guild_names`. |
| `frontend/vite.config.js` | Dev proxy for `/api` → `:3000`, making the documented two-server dev workflow actually work (no CORS needed). |
| `README.md` | Dev instructions updated for the proxy; guild-night section points at guild.json; legend filename fixed; links to SETUP.md. |
| `.gitignore` | Removed the line that ignored `.gitignore` itself. |

## ⚠️ Action needed on YOUR existing deployment

The three read RPCs changed signature (they now take `p_guild_names text[]`). Your live Supabase still has the old zero-argument versions, so **before deploying the updated backend**, run this in your SQL editor (it's the function block copied from `000_baseline.sql`):

1. Open `migrations/000_baseline.sql`, copy everything from `-- ── SQL functions` down to (but not including) `-- ── Storage`, and run it. `create or replace` handles `save_match`; the three read functions changed signatures, so drop the old ones first:
   ```sql
   drop function if exists get_player_stats();
   drop function if exists get_stats_summary();
   drop function if exists get_guild_player_counts();
   ```
2. Deploy the updated code. (Order matters only in the sense that old-code + new-functions also fails — do both in one maintenance window; it takes a minute.)

Do NOT run `000_baseline.sql` itself against your live database — it creates tables you already have.

## Making the repo a template

1. On GitHub: repo → Settings → check **Template repository**. Guilds click "Use this template" and get a clean copy (no history).
2. Optional: add a deploy badge to the README:
   `[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)`
   — Render picks up `render.yaml` from the repo it's launched against.
3. Consider a `CHANGELOG.md` going forward, since template users upgrade by merging your main (documented at the end of SETUP.md).

## Still open (known, deliberate)
- The Lucent-request "mark paid" double-grant race and the `/api/players` full-history scan from the code review are unchanged — worth fixing before wide adoption but not setup blockers.
- The market-potentials scraper (`scrappers/`) is referenced by migration 010 but not in the repo; SETUP.md doesn't cover it since the feature degrades gracefully (prices just age out / show empty).

## Licensing note (AGPL-3.0)

- Guilds self-hosting **unmodified** copies have nothing to do — the source is already public (this repo).
- A guild that **modifies** the code and runs it for their members must make their modified source available to those users (a "Source" link in the footer pointing at their fork is the conventional way to satisfy §13).
- **You retain special power only while you own all the copyright.** Right now you can relicense, dual-license, or sell exceptions freely. Once you merge someone else's PR, the combined work is jointly owned and relicensing needs their consent too. If keeping that door open matters, either keep a simple CLA/DCO for contributors, or accept that the license is effectively permanent once contributions land — most projects just accept it.
- Add `"license": "AGPL-3.0-only"` to the three `package.json` files (root, backend, frontend) so GitHub and npm tooling detect it. (Done in this package for the root; mirror it if you add the field elsewhere.)
