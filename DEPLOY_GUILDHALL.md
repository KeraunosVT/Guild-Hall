# Guild Hall — Fresh Deployment Runbook (guild-hall.gg)

Everything from zero: new GitHub repo, new Discord application, new Supabase
project, new droplet, new domain. Nothing from the TNL Stats era is reused.
One $12/mo DigitalOcean droplet, app as a systemd service behind Caddy
(automatic HTTPS). Budget ~90 minutes end to end.

Replace throughout: `github.com/KeraunosVT/guild-hall` with your repo,
`YOUR_DROPLET_IP` with the IP from step 4.

---

## 0. The codebase, renamed and pushed

In your local working copy (the one with the Path A overlay applied):

1. `package.json` × 3 (root, backend, frontend): `"name"` → `guild-hall`,
   `guild-hall-backend`, `guild-hall-frontend`.
2. `README.md` / `SETUP.md`: retitle to Guild Hall; URLs → guild-hall.gg.
3. `frontend/index.html`: `<title>Guild Hall</title>`.
4. `shared/guild.json`: YOUR guild's identity — in-game tag exactly as it
   appears on scoreboards, aliases, timezone, dayStart. (The app is Guild
   Hall; the guild is whatever yours is called. These never mix.)
5. `frontend/src/guild.js`: your motto/creed; `frontend/public/sigil.svg`:
   your emblem.

New GitHub repo (create it EMPTY — no README/license checkboxes), then:

```powershell
git remote set-url origin https://github.com/KeraunosVT/guild-hall.git
git add -A && git commit -m "Guild Hall"
git push -u origin main
```

Settings → check **Template repository** whenever you're ready for other
guilds to copy it.

## 1. New Discord application

[Discord Developer Portal](https://discord.com/developers/applications) →
New Application → **Guild Hall**.

1. **OAuth2:** copy Client ID + Client Secret. Add BOTH redirects now:
   - `https://guild-hall.gg/api/auth/discord/callback`
   - `http://localhost:3000/api/auth/discord/callback`
2. **Bot:** Reset Token → copy. Enable **Server Members Intent**.
3. **Invite:**
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands&permissions=52224`
4. Collect IDs (Discord Developer Mode on; right-click → Copy ID):
   server ID, admin role(s), allowed/member role(s), and the roster / LOA /
   announce channel IDs.

## 2. New Supabase project

1. [supabase.com](https://supabase.com) → New project (Pro tier if this is
   the real home — no pausing, daily backups; free tier is fine to rehearse).
2. Project Settings → API: copy **Project URL** and the **service_role
   secret** key (not anon/publishable).
3. SQL Editor → run every file in `migrations/` **in numeric order**,
   `000_baseline.sql` first, then 001 → 011. The baseline creates all
   tables, the four SQL functions, the public `assets` storage bucket, RLS,
   and — after the fix we shipped — the service_role grants, so the
   permission-denied saga cannot recur however the SQL is executed.
4. Sanity check from your PC (should return `[]`, not an error):

```powershell
curl.exe "https://YOUR_PROJECT.supabase.co/rest/v1/player_identities?select=id&limit=1" -H "apikey: SERVICE_KEY" -H "Authorization: Bearer SERVICE_KEY"
```

## 3. Domain

Register `guild-hall.gg` (confirm the RENEWAL price at checkout). Leave DNS
unpointed until step 8.

## 4. Droplet

DigitalOcean → Create → Droplet: **Ubuntu 24.04 LTS**, Basic **$12/mo
(2 GB)**, region nearest your members, **SSH key** auth, monitoring on.
Note the IP, then `ssh root@YOUR_DROPLET_IP`.

## 5. Base setup (as root, once)

```bash
# Deploy user
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
rsync -a ~/.ssh /home/deploy/ && chown -R deploy:deploy /home/deploy/.ssh
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy

# Firewall
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Automatic security updates
apt-get update && apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# Swap: headroom for the Vite build
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Node 22, git, Caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git caddy

# Lock down SSH
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh
```

Log out; reconnect as `ssh deploy@YOUR_DROPLET_IP`.

## 6. Code + environment

```bash
sudo mkdir -p /srv/guild-hall && sudo chown deploy:deploy /srv/guild-hall
git clone https://github.com/KeraunosVT/guild-hall.git /srv/guild-hall
cd /srv/guild-hall
nano backend/.env
chmod 600 backend/.env
```

`backend/.env` — every value fresh, from steps 1–2:

```
# Discord application (step 1)
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=https://guild-hall.gg/api/auth/discord/callback
DISCORD_GUILD_ID=
DISCORD_BOT_TOKEN=
DISCORD_ADMIN_ROLE_IDS=
DISCORD_ALLOWED_ROLE_IDS=
DISCORD_MEMBER_ROLE_IDS=
DISCORD_ROSTER_CHANNEL_ID=
DISCORD_LOA_CHANNEL_ID=
DISCORD_ANNOUNCE_CHANNEL_ID=

# Supabase (step 2)
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# Session — generate on the droplet: openssl rand -hex 32
JWT_SECRET=

# Gemini — aistudio.google.com/apikey
GEMINI_API_KEY=

APP_URL=https://guild-hall.gg
NODE_ENV=production
PORT=3000
```

Build:

```bash
npm install                      # postinstall builds the frontend
ls frontend/dist/index.html      # must exist
```

## 7. Service + reverse proxy

```bash
sudo tee /etc/systemd/system/guildhall.service > /dev/null << 'EOF'
[Unit]
Description=Guild Hall
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/guild-hall/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now guildhall
curl -s localhost:3000/api/health          # {"status":"ok"}
journalctl -u guildhall -n 20 --no-pager   # ✅ Supabase … ✅ Discord gateway connected
```

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
guild-hall.gg {
    reverse_proxy localhost:3000
    encode gzip
}
www.guild-hall.gg {
    redir https://guild-hall.gg{uri} permanent
}
EOF
sudo systemctl reload caddy
```

## 8. DNS + first login

Point `guild-hall.gg` (and `www`) A records at YOUR_DROPLET_IP. Watch
`journalctl -u caddy -f` — certificates issue within a minute of propagation.

Then the checklist that proves the whole stack:

1. https://guild-hall.gg loads with a valid padlock.
2. **Log in with Discord** — the consent screen says Guild Hall.
3. Admin section visible in the sidebar (you hold an admin role).
4. Admin → Event Schedule: add your recurring events first — LOA and
   attendance key off this.
5. Admin → Upload Match: feed it a scoreboard screenshot end-to-end
   (exercises multer → Gemini with the legend → save_match → stats pages).
6. Run a slash command in Discord; check a roster post lands in its channel.

Fresh database means empty pages everywhere until data flows — that's
correct, not broken.

## 9. Deploy script + aftercare

```bash
tee /srv/guild-hall/deploy.sh > /dev/null << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /srv/guild-hall
git pull
npm install
sudo systemctl restart guildhall
sleep 2
curl -sf localhost:3000/api/health && echo " ✓ deployed"
EOF
chmod +x /srv/guild-hall/deploy.sh
```

Future updates: commit+sync in VS Code →
`ssh deploy@guild-hall.gg '/srv/guild-hall/deploy.sh'`

- **Uptime:** UptimeRobot (free) → `https://guild-hall.gg/api/health` →
  alert to a Discord webhook in your officer channel.
- **Secrets:** keep the filled `backend/.env` in a password manager — it's
  the only thing on the droplet that isn't reproducible from repo + runbook.
- **Data:** lives in Supabase (Pro = daily backups). The droplet is
  disposable by design: worst case, re-run steps 4–8 on a new one.
- **Old world:** whenever convenient, delete the Hostinger app, the old
  Discord application, the old Supabase project, and let tnlstats.com lapse
  — nothing references them.

## Troubleshooting

| Symptom | Check |
|---|---|
| Site down | `systemctl status guildhall` → `journalctl -u guildhall -n 50` |
| Build OOM | `free -h` (swap on?); fallback: build locally, commit `frontend/dist` |
| No HTTPS | `journalctl -u caddy -n 50`; DNS not propagated / port 80 blocked |
| `?auth=error` on login | Redirect URI mismatch: portal ↔ `.env` ↔ actual URL |
| `?auth=not_member` | Bot invited? `DISCORD_GUILD_ID` right? You're in that server? |
| Slash commands missing | Invite included `applications.commands`? Gateway log shows registration? |
| permission denied for table … | Baseline grants ran? (They're in `000_baseline.sql` now — re-run its Grants block) |
| Could not find function … without parameters | Deployed code is pre-Path-A — confirm `p_guild_names` exists in `backend/server.js` on the droplet |
