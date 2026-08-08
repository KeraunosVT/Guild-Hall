// backend/server.js
const path = require('path');
// Load environment variables from backend/.env for local development.
// On hosts that inject env vars (Render, Railway, etc.) the .env is simply absent
// and this is a no-op; existing process.env values are never overwritten.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const {
  router: authRouter, requireAuth, requireAdminArea, requirePermission, userHas, hasValidSession,
  applyGuildAccess,
} = require('./auth');
const { listMembers } = require('./discord');
const createGuildContext = require('./guildContext');
const { tenantDb } = require('./tenantDb');
const SHARDS = require('../shared/shards.json');
const BOSS_WEAPONS = require('../shared/archbossWeapons.json');
const BUILDS = ['PvP', 'PvE'];
const VALID_BOSS_WEAPONS = new Set(
  Object.entries(BOSS_WEAPONS).flatMap(([boss, list]) => list.map((w) => `${boss}|${w}`))
);
const createLootCatalog = require('./lootCatalog');
const createEliteTimers = require('./eliteTimers');
const createGearIlvl = require('./gearIlvl');
const createIdentities = require('./identities');
const createLoa = require('./loa');
const createAuditLog = require('./auditLog');

const gearUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

const gateway = require('./discordGateway');

const app = express();

// Render/Railway/etc. sit behind one reverse proxy — needed for req.ip and
// req.secure to reflect the real client rather than the proxy.
app.set('trust proxy', 1);

// Per-member throttle for endpoints that call Gemini (each request costs real
// API money). Keyed on the session user id; IP is only a fallback in case this
// is ever mounted before auth.
const GEAR_SUBMIT_LIMIT = parseInt(process.env.GEAR_SUBMIT_LIMIT_PER_HOUR, 10) || 5;
const gearSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: GEAR_SUBMIT_LIMIT,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: `Too many gear submissions — the limit is ${GEAR_SUBMIT_LIMIT} per hour. Try again later.` },
});

// CORS allowlist. The frontend is served same-origin by this server, so no
// cross-origin access is needed in production — `origin: false` sends no CORS
// headers at all (same-origin requests are unaffected). For local dev (Vite on
// :5173) or any other trusted origin, set CORS_ORIGINS to a comma-separated
// list of full origins, e.g. CORS_ORIGINS=http://localhost:5173
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
// Security headers. The CSP is deliberately permissive enough for what the app
// actually loads — Google Fonts, Discord avatars, the Supabase image bucket,
// and the landing page's inline <style>/<script> — while still shutting down
// the obvious vectors (framing, plugin embeds, base-tag hijacking). If you add
// a new external asset host, add it here or it'll be blocked.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],       // landing page inline script
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://*.supabase.co'],
      connectSrc: ["'self'", 'https://*.supabase.co'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  // The app is same-origin; this header can interfere with OAuth popups/redirects
  // on some setups and buys little here, so keep it relaxed.
  crossOriginOpenerPolicy: false,
}));

app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : false, credentials: true }));
app.use(express.json());
app.use(cookieParser());

console.log("✅ Server started successfully");

// ── SUPABASE SETUP ───────────────────────────────────────────────────────────
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  console.log("✅ Supabase client initialized");
} catch (e) {
  console.error("❌ Supabase failed to initialize:", e.message);
}

const lootCatalog = supabase ? createLootCatalog(supabase) : null;
const eliteTimers = supabase ? createEliteTimers(supabase) : null;
const gearIlvl = supabase ? createGearIlvl(supabase) : null;
const identities = supabase ? createIdentities(supabase) : null;
const loa = supabase ? createLoa(supabase) : null;
const auditLog = supabase ? createAuditLog(supabase) : null;
// Guild resolution needs the client to read the tenant registry, so it's built
// here alongside the other factories rather than imported as a bare middleware.
// applyGuildAccess is passed in, not imported by guildContext: auth.js already
// imports GUILD_HEADER from it, and requiring back the other way would be a
// cycle. See the note on createGuildContext.
const { resolveGuildOrSingle } = createGuildContext(supabase, applyGuildAccess);

// The gateway needs Supabase for /elitetimer persistence, so start it after setup.
gateway.start(supabase);

// ── GUILD ALIASES ────────────────────────────────────────────────────────────
// Our guild has changed names over time. Collapse all past names to the current
// one so stats aren't split across what looks like several separate guilds. Any
// name NOT in this list is treated as an enemy guild and kept as-is.
//
// Read from shared/guild.json, the same file the frontend brands itself from —
// these used to be two hand-maintained lists, and a rename that updated only one
// would silently orphan match rows into an enemy guild rather than error.
//
// Renaming is ADDITIVE: a scoreboard records whatever the guild was called the
// day it was uploaded, so every past name has to stay listed forever. And note
// "Highly Regarded" is a *different* guild — it must not be added.
// These used to be module-level constants read from shared/guild.json at boot,
// which pinned the whole process to one guild's tag and alias list. They are now
// derived per request from req.guild (the guilds row), so guild.json is only the
// template a new tenant is seeded from — plan task 9.
//
// aliasesOf falls back to [tag] rather than [] on an empty alias list: an empty
// array passed to .in('guild_name', []) matches NOTHING, which would silently
// show a brand-new guild an empty war record instead of its own matches.
const aliasesOf = (guild) => {
  const list = Array.isArray(guild && guild.aliases) ? guild.aliases.filter(Boolean) : [];
  return list.length ? list : [guild && guild.tag].filter(Boolean);
};

// Collapse any of this guild's past names onto its current tag; anything else is
// an enemy guild and passes through unchanged.
const canonicalGuildFor = (guild, name) => {
  const trimmed = (name || '').trim();
  if (!trimmed) return 'Unknown';
  return aliasesOf(guild).includes(trimmed) ? guild.tag : trimmed;
};

// Shorthand for the scoped client inside a route handler.
const dbFor = (req) => tenantDb(supabase, req.guildId);

// Health check (public)
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── EARLY ACCESS (public) ────────────────────────────────────────────────────
// The landing page's "request early access" form posts here. We forward the
// submission to a Discord webhook (officer channel) — no database, no stored
// PII beyond what Discord keeps. Rate-limited to blunt spam/abuse of an
// unauthenticated endpoint. If EARLY_ACCESS_WEBHOOK_URL isn't set, the route
// reports itself unavailable rather than pretending to succeed.
const EARLY_ACCESS_WEBHOOK_URL = process.env.EARLY_ACCESS_WEBHOOK_URL || '';
const earlyAccessLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,                 // 5 requests/hour per IP — a person, not a bot
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again later.' },
});

app.post('/api/early-access', earlyAccessLimiter, async (req, res) => {
  if (!EARLY_ACCESS_WEBHOOK_URL) {
    return res.status(503).json({ error: 'Early access signups are not currently open.' });
  }

  // Accept a Discord handle plus optional context. Everything is trimmed and
  // length-capped so a submission can't bloat or break the webhook payload.
  const clean = (v, max) => String(v || '').trim().slice(0, max);
  const discord = clean(req.body.discord, 64);
  const guild = clean(req.body.guild, 100);
  const game = clean(req.body.game, 60);
  const note = clean(req.body.note, 500);

  if (!discord) {
    return res.status(400).json({ error: 'Please include a Discord handle so we can reach you.' });
  }

  // Discord webhooks treat certain sequences as formatting/mentions; strip @
  // and backticks defensively and disable mention parsing on the payload.
  const sanitize = (s) => s.replace(/[`@]/g, '').replace(/\n{3,}/g, '\n\n');
  const lines = [
    `**New early-access request**`,
    `**Discord:** ${sanitize(discord)}`,
    guild && `**Guild:** ${sanitize(guild)}`,
    game && `**Game:** ${sanitize(game)}`,
    note && `**Note:** ${sanitize(note)}`,
  ].filter(Boolean);

  try {
    const resp = await fetch(EARLY_ACCESS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: lines.join('\n'),
        allowed_mentions: { parse: [] }, // never ping anyone from user input
      }),
    });
    if (!resp.ok) throw new Error(`webhook responded ${resp.status}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Early-access webhook failed:', err.message);
    return res.status(502).json({ error: 'Could not submit right now — please try again later.' });
  }
});

// Discord login routes (public)
app.use('/api/auth', authRouter);

// Everything else under /api requires a valid guild-member session, and then a
// resolved guild. Full login wall: stats, matches, and match detail are gated.
//
// The two run CHAINED, never swapped: resolveGuildOrSingle reads req.user to
// prove the caller belongs to the guild they asked for, so it is meaningless
// without requireAuth having populated req.user first — and putting it in place
// of requireAuth drops the login wall on every route below.
//
// In single-tenant mode (SINGLE_GUILD_ID set) resolution just pins that guild,
// so this works against the current session shape unchanged; multi-guild mode
// additionally needs the session to carry a guild list (Phase 3, task 10).
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth')) return next();
  return requireAuth(req, res, () => resolveGuildOrSingle(req, res, next));
});

// ── ADMIN AREA (requires a capability) ───────────────────────────────────────
// requireAdminArea resolves which capability the requested path needs and checks
// it — see backend/permissions.js for the route table. A path with no rule is
// denied rather than admitted, so a new admin route can't ship as public.
//
// Audit log's viewer is mounted separately, before the general /api/admin
// router, so its gate stays structurally independent of admin.js's routing. It
// takes the 'audit' capability directly since its own paths ('/', '/filters')
// don't carry the /audit-log prefix once Express has stripped the mount point.
app.use('/api/admin/audit-log', requirePermission('audit'), auditLog
  ? auditLog.router
  : (req, res) => res.status(503).json({ error: 'Database not configured.' }));

const createAdminRouter = require('./admin');
app.use('/api/admin', requireAdminArea, auditLog ? auditLog.log : (req, res, next) => next(), createAdminRouter(supabase, gateway, lootCatalog, identities));

// ── MEMBERS AREA: Class builds ───────────────────────────────────────────────
app.get('/api/my-classes', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { data } = await dbFor(req).from('member_roles').select('pvp_classes, pve_classes').eq('discord_id', req.user.id).single();
  res.json({
    pvp_classes: Array.isArray(data?.pvp_classes) ? data.pvp_classes : [],
    pve_classes: Array.isArray(data?.pve_classes) ? data.pve_classes : [],
  });
});

app.put('/api/my-classes', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { pvp_classes, pve_classes } = req.body || {};
  const clean = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).slice(0, 3) : []);
  const { error } = await dbFor(req).from('member_roles')
    .upsert({
      discord_id: req.user.id,
      pvp_classes: clean(pvp_classes),
      pve_classes: clean(pve_classes),
      updated_at: new Date().toISOString(),
      // Composite target: Phase 1 widened member_roles' PK from discord_id to
      // (guild_id, discord_id), so 'discord_id' alone matches no constraint and
      // Postgres rejects the upsert outright.
    }, { onConflict: 'guild_id,discord_id', ignoreDuplicates: false });
  if (error) return res.status(500).json({ error: 'Failed to save classes.' });
  res.json({ ok: true });
});

// ── MEMBERS AREA: my own player profile ──────────────────────────────────────
// Profiles are addressed by in-game name (/roster/:name), but a session only
// knows a Discord id — so "my profile" needs the identity mapping to bridge the
// two. Reports why there's no profile rather than just failing, since both
// causes are things a member can act on: nobody has mapped their Discord
// account to an in-game name yet, or they have no logged matches.
app.get('/api/my-profile', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const ids = await identities.load(req.guildId);
    const name = ids.displayNameFor(req.user.id, null);
    if (!name) return res.json({ name: null, mapped: false, hasRecord: false });

    // Every alias counts towards "do they have a record" — a player who only
    // ever appeared under an old in-game name still has one.
    const identity = ids.identityForName(name);
    const names = identity
      ? [identity.display_name, ...(Array.isArray(identity.ingame_names) ? identity.ingame_names : [])].filter(Boolean)
      : [name];
    const { count } = await dbFor(req).from('player_match_stats')
      .select('*', { count: 'exact', head: true })
      .in('player_name', names)
      .in('guild_name', aliasesOf(req.guild));

    res.json({ name, mapped: true, hasRecord: (count || 0) > 0 });
  } catch (err) {
    console.error('my-profile error:', err.message);
    res.status(500).json({ error: 'Could not resolve your profile.' });
  }
});

// ── MEMBERS AREA: Gear item level ────────────────────────────────────────────
// Any member can submit a screenshot of their own gear; a new submission
// replaces whatever they had on file before. The full comparison table is
// admin-only (see /api/admin/gear-ilvl) — this is just "what's on file for me".
app.get('/api/gear-ilvl/mine', async (req, res) => {
  if (!gearIlvl) return res.status(503).json({ error: 'Database not configured.' });
  const entry = await gearIlvl.forMember(req.guildId, req.user.id);
  res.json({ entry });
});

app.post('/api/gear-ilvl', gearSubmitLimiter, gearUpload.single('image'), async (req, res) => {
  if (!gearIlvl) return res.status(503).json({ error: 'Database not configured.' });
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  if (!req.file.mimetype?.startsWith('image/')) {
    return res.status(415).json({ error: 'Please upload an image file (PNG or JPG screenshot).' });
  }
  try {
    const extracted = await gearIlvl.parseGearScreenshot(req.file.buffer, req.file.mimetype);
    const entry = await gearIlvl.submit(req.guildId, req.user.id, req.user.username, extracted);
    res.json({ entry });
  } catch (err) {
    console.error('Gear ilvl submit error:', err.message);
    res.status(500).json({ error: err.message || 'Could not read that screenshot.' });
  }
});

// ── MEMBERS AREA: Archboss shard tracker ─────────────────────────────────────
// Any logged-in member sees the full tally. Editing a row is restricted to its
// owner (matched by Discord id) or an admin — enforced here, not just in the UI.
app.get('/api/members', async (req, res) => {
  try {
    const members = await listMembers(req.guild);
    const counts = {};
    const roles = {};
    if (supabase) {
      const [{ data: shardData }, { data: roleData }] = await Promise.all([
        dbFor(req).from('shard_counts').select('discord_id, shards'),
        dbFor(req).from('member_roles').select('discord_id, pvp_role'),
      ]);
      (shardData || []).forEach((r) => { counts[r.discord_id] = r.shards || {}; });
      (roleData || []).forEach((r) => { roles[r.discord_id] = r.pvp_role || ''; });
    }
    res.json({ members: members.map((m) => ({ ...m, shards: counts[m.id] || {}, pvp_role: roles[m.id] || '' })) });
  } catch (err) {
    console.error('Members list error:', err.response?.data?.message || err.message);
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

app.put('/api/shards/:discordId', async (req, res) => {
  const target = req.params.discordId;
  if (req.user.id !== target && !userHas(req.user, 'loot.awards')) {
    return res.status(403).json({ error: 'You can only edit your own shards.' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const incoming = req.body?.shards || {};
  const shards = {};
  SHARDS.types.forEach((t) => {
    const v = parseInt(incoming[t.key], 10);
    shards[t.key] = Math.max(0, Math.min(SHARDS.max, Number.isFinite(v) ? v : 0));
  });
  const incomingWeapons = Array.isArray(incoming.weapons) ? incoming.weapons : [];
  shards.weapons = incomingWeapons
    .filter((w) => w && VALID_BOSS_WEAPONS.has(`${w.boss}|${w.weapon}`))
    .map((w) => ({ boss: w.boss, weapon: w.weapon, build: BUILDS.includes(w.build) ? w.build : '' }))
    .slice(0, 50);
  const display_name = (req.body?.display_name || req.user.username || '').slice(0, 120);
  const { error } = await dbFor(req).from('shard_counts')
    .upsert({ discord_id: target, display_name, shards, updated_at: new Date().toISOString() });
  if (error) { console.error('Shard save error:', error.message); return res.status(500).json({ error: 'Failed to save shards.' }); }
  res.json({ shards });
});

// ── MEMBERS AREA: Loot wishlist ──────────────────────────────────────────────
// Serve the loot catalog so the frontend doesn't need a static import.
app.get('/api/loot/catalog', async (req, res) => {
  if (!lootCatalog) return res.status(503).json({ error: 'Database not configured.' });
  try {
    res.json(await lootCatalog.getCatalog(req.guildId));
  } catch (err) {
    console.error('Catalog error:', err.message);
    res.status(500).json({ error: 'Failed to load loot catalog.' });
  }
});

// Members set a priority (PvP / Second Build / PvE) on items they want. Everyone
// sees per-item demand counts; admins additionally see who wants what.
app.get('/api/loot', async (req, res) => {
  if (!supabase || !lootCatalog) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const validKeys = await lootCatalog.getKeys(req.guildId);
    const [{ data, error }, ids] = await Promise.all([
      dbFor(req).from('loot_wishlists').select('discord_id, display_name, picks'),
      identities.load(req.guildId),
    ]);
    if (error) throw error;
    const counts = {};
    const tally = {};
    const mine = {};
    (data || []).forEach((r) => {
      const picks = r.picks || {};
      const memberName = ids.displayNameFor(r.discord_id, r.display_name || 'Member');
      Object.entries(picks).forEach(([k, entry]) => {
        if (!validKeys.has(k)) return;
        // Entries are { priority, added_at }; tolerate the older plain-string shape too.
        const priority = typeof entry === 'string' ? entry : entry?.priority;
        const addedAt = typeof entry === 'object' ? entry?.added_at || null : null;
        if (!priority) return;
        if (r.discord_id === req.user.id) mine[k] = priority;
        counts[k] = (counts[k] || 0) + 1;
        if (userHas(req.user, 'loot.awards')) (tally[k] = tally[k] || []).push({ name: memberName, priority, discord_id: r.discord_id, added_at: addedAt });
      });
    });
    // Builds of each item already awarded to the current member, so the UI can
    // lock just that build's chip and leave the others open to request. Awards
    // with no recorded build (made before builds were tracked) don't lock anything.
    const { data: myAwards } = await dbFor(req).from('loot_awards').select('item_key, priority').eq('discord_id', req.user.id);
    const awardedBuilds = {};
    (myAwards || []).forEach((a) => {
      if (!a.priority) return;
      (awardedBuilds[a.item_key] = awardedBuilds[a.item_key] || []).push(a.priority);
    });
    res.json({ mine, counts, awardedBuilds, tally: userHas(req.user, 'loot.awards') ? tally : undefined });
  } catch (err) {
    console.error('Loot load error:', err.message);
    res.status(500).json({ error: 'Failed to load loot wishlist.' });
  }
});

app.put('/api/loot/:discordId', async (req, res) => {
  const target = req.params.discordId;
  if (req.user.id !== target && !userHas(req.user, 'loot.awards')) {
    return res.status(403).json({ error: 'You can only edit your own wishlist.' });
  }
  if (!supabase || !lootCatalog) return res.status(503).json({ error: 'Database not configured.' });
  const validKeys = await lootCatalog.getKeys(req.guildId);
  const { data: existing } = await dbFor(req).from('loot_wishlists').select('picks').eq('discord_id', target).single();
  const existingPicks = existing?.picks || {};
  const now = new Date().toISOString();
  const incoming = req.body?.picks || {};
  const picks = {};
  Object.entries(incoming).forEach(([k, prio]) => {
    if (!validKeys.has(k) || !lootCatalog.priorities.has(prio)) return;
    const prev = existingPicks[k];
    // Keep the original add time across priority edits; only stamp "now" the first time an item is picked.
    const addedAt = (prev && typeof prev === 'object' && prev.added_at) || now;
    picks[k] = { priority: prio, added_at: addedAt };
  });
  const display_name = (req.body?.display_name || req.user.username || '').slice(0, 120);
  const { error } = await dbFor(req).from('loot_wishlists')
    .upsert({ discord_id: target, display_name, picks, updated_at: new Date().toISOString() });
  if (error) { console.error('Loot save error:', error.message); return res.status(500).json({ error: 'Failed to save wishlist.' }); }
  res.json({ picks: Object.fromEntries(Object.entries(picks).map(([k, v]) => [k, v.priority])) });
});

// ── LOA (Leave of Absence) ───────────────────────────────────────────────────
// Event schedule (read-only for members; admin manages via admin router).
app.get('/api/event-schedule', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { data, error } = await dbFor(req).from('event_schedule').select('*').order('day_of_week').order('name');
  if (error) return res.status(500).json({ error: 'Failed to load schedule.' });
  res.json({ schedule: data || [] });
});

// ── Wargame maps (read-only for members; admin manages via admin router) ────
app.get('/api/maps', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { data, error } = await dbFor(req).from('wargame_maps').select('*').order('name');
  if (error) return res.status(500).json({ error: 'Failed to load maps.' });
  res.json({ maps: data || [] });
});

// ── Elite boss respawn timers (read-only; reported via the /elitetimer Discord command) ──
app.get('/api/elite-timers', async (req, res) => {
  if (!eliteTimers) return res.status(503).json({ error: 'Database not configured.' });
  const timers = await eliteTimers.all(req.guildId);
  res.json({ timers, locations: eliteTimers.locations });
});

// Per-map win/loss record, for the War Record page.
app.get('/api/maps/stats', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { data, error } = await dbFor(req).from('wargame_matches').select('map, result').not('map', 'is', null);
  if (error) return res.status(500).json({ error: 'Failed to load map stats.' });

  const byMap = {};
  (data || []).forEach((m) => {
    const key = m.map;
    if (!key) return;
    const s = (byMap[key] ||= { map: key, played: 0, wins: 0, losses: 0, draws: 0 });
    s.played++;
    if (m.result === 'Win') s.wins++;
    else if (m.result === 'Loss') s.losses++;
    else if (m.result === 'Draw') s.draws++;
  });

  const stats = Object.values(byMap)
    .map((s) => ({ ...s, winPct: s.played > 0 ? Math.round((s.wins / s.played) * 100) : 0 }))
    .sort((a, b) => b.played - a.played);

  res.json({ stats });
});

// My LOAs
app.get('/api/loa', async (req, res) => {
  if (!loa) return res.status(503).json({ error: 'Database not configured.' });
  try {
    res.json({ entries: await loa.mine(req.guild, req.user.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// All LOAs (so members can see who's out, minus reasons)
app.get('/api/loa/all', async (req, res) => {
  if (!loa) return res.status(503).json({ error: 'Database not configured.' });
  try {
    res.json({ entries: await loa.all(req.guild, userHas(req.user, 'loa.admin')) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Submit an LOA (per-event or range)
app.post('/api/loa', async (req, res) => {
  if (!loa) return res.status(503).json({ error: 'Database not configured.' });
  const { type, event_date, event_schedule_id, start_date, end_date, day_of_week, start_time, end_time, reason, discord_id, display_name } = req.body || {};
  // Admins can submit on a member's behalf by passing discord_id/display_name;
  // anyone else's request is always attributed to themselves regardless of
  // what the body says.
  const onBehalf = userHas(req.user, 'loa.admin') && discord_id;
  const targetId = onBehalf ? discord_id : req.user.id;
  const targetName = onBehalf ? (display_name || 'Member') : req.user.username;
  try {
    if (type === 'event') {
      await loa.submitEvent(req.guild, { discordId: targetId, displayName: targetName, eventDate: event_date, eventScheduleId: event_schedule_id, startTime: start_time, endTime: end_time, reason });
    } else if (type === 'range') {
      await loa.submitRange(req.guild, { discordId: targetId, displayName: targetName, startDate: start_date, endDate: end_date, reason });
    } else if (type === 'recurring') {
      await loa.submitRecurring(req.guild, { discordId: targetId, displayName: targetName, dayOfWeek: parseInt(day_of_week, 10), eventScheduleId: event_schedule_id, startTime: start_time, endTime: end_time, reason });
    } else {
      return res.status(400).json({ error: 'Type must be "event", "range", or "recurring".' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Delete own LOA
app.delete('/api/loa/:id', async (req, res) => {
  if (!loa) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { messageId } = await loa.cancel(req.guild, req.params.id, req.user.id, userHas(req.user, 'loa.admin'));
    res.json({ ok: true });
    gateway.deleteLoaMessage(req.guild, messageId);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── ALL-TIME PLAYER STATS (our guild only) ───────────────────────────────────
// Short-TTL cache for the players roster. This endpoint aggregates the full
// match history (an RPC over all rows plus a paginated weapon-class scan of
// player_match_stats) and joins live Discord membership — cheap now, but it
// grows with match history and is hit on every Roster page load. A brief cache
// collapses bursts (several officers opening the roster during raid) into one
// computation. Keyed by the "last N" param since that changes the result set.
// Invalidated implicitly by TTL; a new match appears within PLAYERS_CACHE_SECONDS.
const PLAYERS_CACHE_TTL_MS = (parseInt(process.env.PLAYERS_CACHE_SECONDS, 10) || 30) * 1000;
const playersCache = new Map(); // key -> { at, players }

app.get('/api/players', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const lastN = Math.min(Math.max(parseInt(req.query.last, 10) || 0, 0), 500);

    // The guild MUST be in the key. Every query below is scoped, but this cache
    // sits in front of them: keyed on lastN alone, the first guild to load the
    // roster fills the entry and every other guild is served its player list
    // for the rest of the TTL. Scoped queries behind an unscoped cache are not
    // scoped at all.
    const cacheKey = `${req.guildId}:last:${lastN}`;
    const hit = playersCache.get(cacheKey);
    if (hit && Date.now() - hit.at < PLAYERS_CACHE_TTL_MS) {
      return res.json({ players: hit.players });
    }

    const ids = await identities.load(req.guildId);

    let data;
    let matchIds = null; // null = all-time (no match scoping), set below for the "last N" branch
    if (lastN > 0) {
      const { data: recentMatches } = await dbFor(req)
        .from('wargame_matches').select('id')
        .order('match_date', { ascending: false }).limit(lastN);
      matchIds = (recentMatches || []).map((m) => m.id);
      if (matchIds.length === 0) return res.json({ players: [] });

      const guildNames = aliasesOf(req.guild);
      const { data: rows, error: rErr } = await dbFor(req)
        .from('player_match_stats')
        .select('player_name, kills, assists, damage_dealt, damage_taken, healing')
        .in('match_id', matchIds)
        .in('guild_name', guildNames);
      if (rErr) throw rErr;

      const agg = {};
      (rows || []).forEach((r) => {
        const resolved = ids.resolveName(r.player_name);
        if (!agg[resolved]) agg[resolved] = { player_name: resolved, matches: 0, kills: 0, assists: 0, damage_dealt: 0, damage_taken: 0, healing: 0 };
        agg[resolved].matches++;
        agg[resolved].kills += Number(r.kills) || 0;
        agg[resolved].assists += Number(r.assists) || 0;
        agg[resolved].damage_dealt += Number(r.damage_dealt) || 0;
        agg[resolved].damage_taken += Number(r.damage_taken) || 0;
        agg[resolved].healing += Number(r.healing) || 0;
      });
      data = Object.values(agg);
    } else {
      // Guild scoping is passed in rather than living inside the SQL function,
      // so the same function definition works for any guild's deployment.
      const result = await dbFor(req).rpc('get_player_stats', { p_guild_names: aliasesOf(req.guild) });
      if (result.error) throw result.error;
      data = result.data;
    }

    // Primary class per player, for the Roster page's Melee/Range/Kill
    // Squad/Healers filter — weapon columns aren't part of get_player_stats()'s
    // RPC output, so this is a separate fetch, scoped to the same match set as
    // the stats above. Paginated via .range() since player_match_stats can
    // exceed PostgREST's 1,000-row default cap for a guild with real history.
    const guildNames = aliasesOf(req.guild);
    const weaponRows = await fetchAllRows(dbFor(req), 'player_match_stats', 'player_name, weapon_1, weapon_2', guildNames, matchIds);
    const classCounts = {}; // resolved player_name -> { className: count }
    weaponRows.forEach((r) => {
      const resolved = ids.resolveName(r.player_name);
      const cls = getClassNameBackend(r.weapon_1, r.weapon_2);
      if (cls === 'Unknown') return;
      if (!classCounts[resolved]) classCounts[resolved] = {};
      classCounts[resolved][cls] = (classCounts[resolved][cls] || 0) + 1;
    });
    const primaryClassFor = (name) => {
      const counts = classCounts[name];
      if (!counts) return null;
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    };

    const members = await listMembers(req.guild).catch(() => []);
    const memberIds = new Set(members.map((m) => m.id));

    const players = (data || []).map((p) => {
      const did = ids.discordIdFor(p.player_name);
      return { ...p, is_member: did ? memberIds.has(did) : false, primary_class: primaryClassFor(p.player_name) };
    });

    playersCache.set(cacheKey, { at: Date.now(), players });
    res.json({ players });
  } catch (err) {
    console.error('Player stats error:', err.message);
    res.status(500).json({ error: 'Failed to load player stats.' });
  }
});

// How many logged events this member turned up to, and out of how many they
// could have. "Could have" counts only events from their first recorded
// attendance onward — measuring a new member against events that happened
// before they joined would show a rate that says nothing about them.
// Takes the guild-scoped client: this lives at module level, so there is no
// request in scope to derive one from.
async function playerAttendance(db, discordId) {
  const [{ data: mine }, { data: allEvents }] = await Promise.all([
    db.from('event_attendance').select('event_id').eq('discord_id', discordId),
    db.from('events').select('id, title, event_date').order('event_date', { ascending: false }),
  ]);
  const attendedIds = new Set((mine || []).map((a) => a.event_id));
  const events = allEvents || [];
  if (events.length === 0) return { attended: 0, eligible: 0, rate: null, since: null, recent: [] };

  const attendedEvents = events.filter((e) => attendedIds.has(e.id));
  const since = attendedEvents.length
    ? attendedEvents[attendedEvents.length - 1].event_date
    : null;
  const eligible = since ? events.filter((e) => (e.event_date || '') >= since) : [];

  // The last 10 eligible events, newest first, each flagged attended or missed —
  // a rate alone hides whether someone is trending away.
  const recent = eligible.slice(0, 10).map((e) => ({
    id: e.id, title: e.title, event_date: e.event_date, attended: attendedIds.has(e.id),
  }));

  return {
    attended: attendedEvents.length,
    eligible: eligible.length,
    rate: eligible.length ? attendedEvents.length / eligible.length : null,
    since,
    recent,
  };
}

// Gear and currency a member has been given. Visible on your own profile
// unconditionally; on someone else's it takes the capability that governs that
// ledger, since who-got-what is otherwise officer-only (see the loot tally).
// The two halves are gated separately — currency is the more sensitive one.
// Takes the guild-scoped client, same reason as playerAttendance above.
async function playerLoot(db, discordId, viewer) {
  const isSelf = viewer?.id === discordId;
  const canItems = isSelf || userHas(viewer, 'loot.awards');
  const canCurrency = isSelf || userHas(viewer, 'loot.currency');

  const [awards, currency, catalogItems] = await Promise.all([
    canItems
      ? db.from('loot_awards').select('id, item_key, priority, awarded_at')
        .eq('discord_id', discordId).order('awarded_at', { ascending: false }).then((r) => r.data || [])
      : Promise.resolve(null),
    canCurrency
      ? db.from('currency_awards').select('id, currency, amount, reason, awarded_at')
        .eq('discord_id', discordId).order('awarded_at', { ascending: false }).then((r) => r.data || [])
      : Promise.resolve(null),
    // Names resolved here rather than making the profile page fetch the whole
    // catalog just to label a handful of rows.
    canItems ? db.from('loot_items').select('key, name, grade, image_url').then((r) => r.data || []) : Promise.resolve([]),
  ]);

  const byKey = Object.fromEntries((catalogItems || []).map((i) => [i.key, i]));
  return {
    canSeeItems: canItems,
    canSeeCurrency: canCurrency,
    items: awards && awards.map((a) => ({
      ...a,
      name: byKey[a.item_key]?.name || a.item_key,
      grade: byKey[a.item_key]?.grade || null,
      image_url: byKey[a.item_key]?.image_url || null,
    })),
    currency: currency,
  };
}

// ── PLAYER PROFILE ──────────────────────────────────────────────────────────
app.get('/api/player/:name', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const requestedName = decodeURIComponent(req.params.name).trim();

    // Resolve all in-game names this player might appear as via identities.
    const ids = await identities.load(req.guildId);
    const identity = ids.identityForName(requestedName);
    let names = [requestedName];
    let displayName = requestedName;
    let discordId = null;
    if (identity) {
      displayName = identity.display_name || requestedName;
      names = [identity.display_name, ...(Array.isArray(identity.ingame_names) ? identity.ingame_names : [])].filter(Boolean);
      discordId = identity.discord_id || null;
    }
    const gearEntry = discordId && gearIlvl ? await gearIlvl.forMember(req.guildId, discordId) : null;

    // Pull every match row for those names (our guild only).
    const guildNames = aliasesOf(req.guild);
    const { data: rows, error: rErr } = await dbFor(req)
      .from('player_match_stats')
      // Explicit constraint name, not just "!inner" — player_match_stats has
      // picked up a second (oddly-named, likely stale) foreign key to
      // wargame_matches on match_id, so PostgREST can no longer infer which
      // relationship to embed and errors with "more than one relationship
      // was found" on a bare wargame_matches!inner(...).
      .select('*, wargame_matches!player_match_stats_match_id_fkey(id, title, match_date)')
      .in('player_name', names)
      .in('guild_name', guildNames);
    if (rErr) throw rErr;
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Player not found.' });

    // Aggregate totals.
    let kills = 0, assists = 0, damage_dealt = 0, damage_taken = 0, healing = 0;
    const classCount = {};
    const matches = [];

    rows.forEach((r) => {
      kills += Number(r.kills) || 0;
      assists += Number(r.assists) || 0;
      damage_dealt += Number(r.damage_dealt) || 0;
      damage_taken += Number(r.damage_taken) || 0;
      healing += Number(r.healing) || 0;

      const cls = getClassNameBackend(r.weapon_1, r.weapon_2);
      classCount[cls] = (classCount[cls] || 0) + 1;

      matches.push({
        match_id: r.wargame_matches.id,
        title: r.wargame_matches.title,
        match_date: r.wargame_matches.match_date,
        rank: r.rank,
        weapon_1: r.weapon_1,
        weapon_2: r.weapon_2,
        kills: Number(r.kills) || 0,
        assists: Number(r.assists) || 0,
        damage_dealt: Number(r.damage_dealt) || 0,
        damage_taken: Number(r.damage_taken) || 0,
        healing: Number(r.healing) || 0,
      });
    });

    matches.sort((a, b) => new Date(b.match_date || 0) - new Date(a.match_date || 0));

    const total = matches.length;
    const classBreakdown = Object.entries(classCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // ── Attendance and loot ─────────────────────────────────────────────────
    // Both hang off the Discord id, so an unmapped player has neither — a name
    // on a scoreboard with nobody linked to it can't be tied to a member.
    const [attendance, loot] = discordId
      ? await Promise.all([playerAttendance(dbFor(req), discordId), playerLoot(dbFor(req), discordId, req.user)])
      : [null, null];

    res.json({
      name: displayName,
      aliases: names.length > 1 ? names.filter((n) => n.toLowerCase() !== displayName.toLowerCase()) : [],
      attendance,
      loot,
      matches: total,
      kills, assists, damage_dealt, damage_taken, healing,
      avg_kills: total ? kills / total : 0,
      avg_assists: total ? assists / total : 0,
      avg_damage: total ? damage_dealt / total : 0,
      avg_healing: total ? healing / total : 0,
      classBreakdown,
      matchHistory: matches,
      gear: gearEntry ? {
        weapon: gearEntry.weapon, armor: gearEntry.armor,
        accessory: gearEntry.accessory, average: gearEntry.average,
      } : null,
    });
  } catch (err) {
    console.error('Player profile error:', err.message);
    res.status(500).json({ error: 'Failed to load player profile.' });
  }
});

// ── STATS SUMMARY ────────────────────────────────────────────────────────────
app.get('/api/stats/summary', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    // Total Matches
    const { count: totalMatches } = await dbFor(req)
      .from('wargame_matches')
      .select('*', { count: 'exact', head: true });

    // Aggregation via RPC — bypasses the 1,000-row PostgREST limit entirely.
    // Guild scoping is passed in so the SQL function is guild-agnostic.
    const { data: aggData, error: aggError } = await dbFor(req)
      .rpc('get_stats_summary', { p_guild_names: aliasesOf(req.guild) });

    if (aggError) throw aggError;

    const totalKills   = Number(aggData[0]?.total_kills)   || 0;
    const totalDamage  = Number(aggData[0]?.total_damage)  || 0;
    const totalHealing = Number(aggData[0]?.total_healing) || 0;

    // Roster composition — active member count plus a PvP-role breakdown, both
    // used by the Dashboard's "Standing" tiles.
    let activeMembers = 0, tanks = 0, dps = 0, healers = 0;
    try {
      const [members, { data: roleData }] = await Promise.all([
        listMembers(req.guild),
        dbFor(req).from('member_roles').select('pvp_role'),
      ]);
      activeMembers = members.length;
      (roleData || []).forEach((r) => {
        if (r.pvp_role === 'Tank') tanks++;
        else if (r.pvp_role === 'DPS') dps++;
        else if (r.pvp_role === 'Healer') healers++;
      });
    } catch (err) {
      console.warn('Roster composition unavailable for stats summary:', err.message);
    }

    res.json({
      totalMatches:  totalMatches || 0,
      totalKills:    totalKills.toLocaleString(),
      totalDamage:   (totalDamage  / 1_000_000).toFixed(1) + "M",
      totalHealing:  (totalHealing / 1_000_000).toFixed(1) + "M",
      activeMembers,
      tanks,
      dps,
      healers,
    });

  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: "Failed to load stats summary" });
  }
});

// ── REAL RECENT MATCHES WITH STATS ──────────────────────────────────────────
app.get('/api/matches/recent', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });

  try {
    // Clamp the limit so a caller can't request, say, ?limit=100000
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 6, 1), 500);

    const { data: matches, error } = await dbFor(req)
      .from('wargame_matches')
      .select('*')
      .order('match_date', { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!matches || matches.length === 0) return res.json([]);

    // Single query for every player row across all matches (no N+1)
    const matchIds = matches.map(m => m.id);
    // Scoped as well as filtered by match id: the ids come from this guild's
    // own matches above, but a stray id would otherwise pull another tenant's
    // player rows straight through.
    const { data: allPlayers, error: pError } = await dbFor(req)
      .from('player_match_stats')
      .select('match_id, guild_name, team_color, kills, damage_dealt, healing')
      .in('match_id', matchIds);

    if (pError) throw pError;

    // Group player rows by match_id in memory
    const playersByMatch = {};
    (allPlayers || []).forEach(p => {
      (playersByMatch[p.match_id] ||= []).push(p);
    });

    const enriched = matches.map(match => {
      const players = playersByMatch[match.id] || [];

      // Determine which team color is ours by finding the team with the most
      // FTP-aliased players (handles subs from other guilds correctly).
      const teamGuildCount = { Red: {}, Yellow: {} };
      players.forEach(p => {
        const color = (p.team_color || '').toLowerCase();
        const teamKey = color === 'red' ? 'Red' : color === 'yellow' ? 'Yellow' : null;
        if (!teamKey) return;
        const g = canonicalGuildFor(req.guild, p.guild_name);
        teamGuildCount[teamKey][g] = (teamGuildCount[teamKey][g] || 0) + 1;
      });
      const myRedCount = teamGuildCount.Red[req.guild.tag] || 0;
      const myYellowCount = teamGuildCount.Yellow[req.guild.tag] || 0;
      const ourColor = myRedCount >= myYellowCount ? 'Red' : 'Yellow';

      // Sum kills by team color
      const teamKills = { Red: 0, Yellow: 0 };
      let totalKills = 0, totalDamage = 0, totalHealing = 0;
      players.forEach(p => {
        const k = Number(p.kills) || 0;
        const color = (p.team_color || '').toLowerCase();
        if (color === 'red') teamKills.Red += k;
        else if (color === 'yellow') teamKills.Yellow += k;
        totalKills += k;
        totalDamage += Number(p.damage_dealt) || 0;
        totalHealing += Number(p.healing) || 0;
      });

      const myKills = teamKills[ourColor];
      const enemyKills = teamKills[ourColor === 'Red' ? 'Yellow' : 'Red'];
      const killDifference = Math.abs(myKills - enemyKills);
      const winningGuild = myKills >= enemyKills ? req.guild.tag : 'Enemy';

      return {
        ...match,
        kills: totalKills,
        damage: totalDamage,
        healing: totalHealing,
        killDifference,
        winningGuild
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('Recent matches error:', err);
    res.status(500).json({ error: "Failed to load recent matches" });
  }
});
// ── MATCH DETAIL WITH RED vs YELLOW TEAMS ───────────────────────────────────
app.get('/api/match/:id', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const { id } = req.params;

    // Scoped: the id alone is a uuid anyone can hold, so without the guild
    // filter this route hands any logged-in member any guild's war record.
    const { data: match, error: matchError } = await dbFor(req)
      .from('wargame_matches')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (matchError) throw matchError;
    if (!match) return res.status(404).json({ error: 'Match not found.' });

    // Get players
    const { data: players, error: playersError } = await dbFor(req)
      .from('player_match_stats')
      .select('*')
      .eq('match_id', id)
      .order('rank', { ascending: true });

    if (playersError) throw playersError;

    // Class Breakdown
    const classCount = {};
    players.forEach(p => {
      const className = getClassNameBackend(p.weapon_1, p.weapon_2);
      classCount[className] = (classCount[className] || 0) + 1;
    });

    // Team Stats by team_color (Red vs Yellow)
    const teamStats = {
      Red: { kills: 0, damage_dealt: 0, damage_taken: 0, healing: 0 },
      Yellow: { kills: 0, damage_dealt: 0, damage_taken: 0, healing: 0 }
    };

    players.forEach(p => {
      const color = (p.team_color || '').toLowerCase();
      const teamKey = color === 'red' ? 'Red' : color === 'yellow' ? 'Yellow' : 'Unknown';

      if (teamStats[teamKey]) {
        teamStats[teamKey].kills += Number(p.kills || 0);
        teamStats[teamKey].damage_dealt += Number(p.damage_dealt || 0);
        teamStats[teamKey].damage_taken += Number(p.damage_taken || 0);
        teamStats[teamKey].healing += Number(p.healing || 0);
      }
    });

    // Label each color with the guild fielding the most players on it.
    // Aliases are collapsed so our house counts as one; ties break on kills.
    const guildTally = { Red: {}, Yellow: {} };
    players.forEach(p => {
      const color = (p.team_color || '').toLowerCase();
      const teamKey = color === 'red' ? 'Red' : color === 'yellow' ? 'Yellow' : null;
      if (!teamKey) return;
      const g = canonicalGuildFor(req.guild, p.guild_name);
      if (!guildTally[teamKey][g]) guildTally[teamKey][g] = { count: 0, kills: 0 };
      guildTally[teamKey][g].count += 1;
      guildTally[teamKey][g].kills += Number(p.kills || 0);
    });

    const dominantGuild = (tally) => {
      const entries = Object.entries(tally);
      if (entries.length === 0) return null;
      entries.sort((a, b) => b[1].count - a[1].count || b[1].kills - a[1].kills);
      return entries[0][0];
    };

    teamStats.Red.guildName = dominantGuild(guildTally.Red);
    teamStats.Yellow.guildName = dominantGuild(guildTally.Yellow);

    res.json({
      match: match || {},
      players: players || [],
      classBreakdown: Object.entries(classCount)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      teamStats: teamStats
    });
  } catch (err) {
    console.error('Match detail error:', err);
    res.status(500).json({ error: 'Failed to load match details' });
  }
});

// Fetches every matching row from a table, paging past PostgREST's 1,000-row
// default cap via .range() instead of trusting a single .select() to return
// everything. `matchIds` is optional — pass null to skip that filter entirely
// (an all-time query) rather than scoping to a specific set of matches.
// Takes the guild-scoped client (tenantDb), not the bare one: every page of
// this pagination has to carry the guild filter, or a large result set leaks
// other tenants' rows from page two onward.
async function fetchAllRows(db, table, columns, guildNames, matchIds) {
  const PAGE_SIZE = 1000;
  const all = [];
  let from = 0;
  for (;;) {
    let q = db.from(table).select(columns).in('guild_name', guildNames);
    if (matchIds) q = q.in('match_id', matchIds);
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

// Backend Class Helper
const weaponToClass = require('../shared/weaponClasses.json');

function getClassNameBackend(weapon1, weapon2) {
  if (!weapon1) return "Unknown";
  const w1 = (weapon1 || "").trim();
  const w2 = (weapon2 || "").trim();

  let key = (w1 + w2).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];

  key = (w2 + w1).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];

  return `${w1} ${w2}`.trim() || "Unknown";
}

// ── SERVE REACT FRONTEND ─────────────────────────────────────────────────────
const frontendPath = path.join(__dirname, '../frontend/dist');
const LANDING_PATH = path.join(__dirname, 'landing.html');
const PRIVACY_PATH = path.join(__dirname, 'privacy.html');
const TERMS_PATH = path.join(__dirname, 'terms.html');

// Public marketing landing page. Shown at the root ONLY to visitors without a
// session — logged-in members hitting "/" fall through to the app. "/landing"
// always shows it regardless of session (for sharing/previewing), and "/app"
// always reaches the app (the landing page's "Member login" link) since it
// isn't intercepted here. Session detection reuses auth.js's own check, so the
// landing/app decision can never drift from the real login state.
app.get('/landing', (req, res) => res.sendFile(LANDING_PATH));
// Public legal pages — always available, no session needed (the landing page
// footer and the login screen link here).
app.get('/privacy', (req, res) => res.sendFile(PRIVACY_PATH));
app.get('/terms', (req, res) => res.sendFile(TERMS_PATH));
app.get('/', (req, res, next) => {
  if (hasValidSession(req)) return next();       // member → app (static index.html)
  return res.sendFile(LANDING_PATH);             // visitor → landing
});

app.use(express.static(frontendPath));

// Unknown API routes return JSON 404 (not the SPA's index.html)
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Everything else falls through to the React app
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ── ERROR HANDLER ────────────────────────────────────────────────────────────
// Without this, a multer error (e.g. a file over the 15 MB limit) falls through
// to Express's default handler and comes back as an HTML stack page — while the
// frontend expects JSON errors everywhere. Must be registered after all routes.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That file is too large — the limit is 15 MB.' });
    }
    return res.status(400).json({ error: `Upload failed: ${err.message}` });
  }
  console.error('Unhandled error:', err.stack || err.message);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});