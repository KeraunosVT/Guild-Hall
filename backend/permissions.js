// backend/permissions.js — named admin capabilities, and which routes need them.
//
// Access used to be one isAdmin boolean covering the whole /api/admin mount, so
// an officer who ran loot council could also delete war records. Capabilities
// are named after the feature groups auditLog.js already uses, since that table
// had effectively categorised every admin route.
//
// Holds its own Supabase client rather than being a createX(supabase) factory
// like loa/attendance: auth.js is a plain module that reads env directly, and
// threading a client through it would mean changing its export shape and every
// import for no behavioural gain.
const { createClient } = require('@supabase/supabase-js');
const { tenantDb } = require('./tenantDb');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// The full set. Anything not listed here is rejected when granting, so a typo
// in the admin UI can't create a capability that silently matches nothing.
const ALL_PERMISSIONS = [
  { key: 'match', label: 'War Records', hint: 'Upload, edit and delete matches' },
  { key: 'parties', label: 'Parties', hint: 'Roster builder and member roles' },
  { key: 'attendance', label: 'Attendance', hint: 'Voice snapshots and event logs' },
  { key: 'gear', label: 'Gear Levels', hint: 'Guild-wide gear level table' },
  { key: 'names', label: 'Merge Names', hint: 'Reconcile in-game names to players' },
  { key: 'schedule', label: 'Event Schedule', hint: 'Recurring event schedule' },
  { key: 'audit', label: 'Audit Log', hint: 'View the admin audit log' },
  { key: 'permissions', label: 'Permissions', hint: 'Grant capabilities to roles and members' },
  { key: 'loa.admin', label: 'LOA Officer', hint: "See LOA reasons, cancel others', file on behalf" },
  { key: 'loot.awards', label: 'Loot — Awards', hint: 'Award and revoke items, tag builds' },
  { key: 'loot.catalog', label: 'Loot — Catalog', hint: 'Manage loot items and categories' },
  { key: 'loot.currency', label: 'Loot — Lucent & Shards', hint: 'Grant and edit currency' },
  { key: 'loot.requests', label: 'Loot — Requests', hint: 'Log and decide Lucent requests' },
];
const PERMISSION_KEYS = new Set(ALL_PERMISSIONS.map((p) => p.key));

// Route prefix -> capability, same matching rule as auditLog's FEATURE_PREFIXES:
// an exact match or a '/'-bounded prefix, so '/loot' can't swallow '/loot-x'.
// Order doesn't matter except that longer prefixes must win, which the sort
// below guarantees — '/loot/items' has to beat a bare '/loot'.
const ROUTE_PERMISSIONS = [
  { prefix: '/match', permission: 'match' },
  { prefix: '/maps', permission: 'match' },
  { prefix: '/rosters', permission: 'parties' },
  { prefix: '/member-roles', permission: 'parties' },
  { prefix: '/loa/unavailable', permission: 'parties' },
  { prefix: '/voice-channels', permission: 'attendance' },
  { prefix: '/events', permission: 'attendance' },
  { prefix: '/attendance', permission: 'attendance' },
  // Not covered by '/attendance': the boundary rule requires an exact match or a
  // '/'-separated prefix, so a hyphen doesn't count. That strictness is what
  // stops '/events' swallowing '/event-schedule', and it needs its own rule here.
  { prefix: '/attendance-stats', permission: 'attendance' },
  { prefix: '/gear-ilvl', permission: 'gear' },
  { prefix: '/identities', permission: 'names' },
  { prefix: '/unmapped-names', permission: 'names' },
  { prefix: '/event-schedule', permission: 'schedule' },
  { prefix: '/audit-log', permission: 'audit' },
  { prefix: '/permissions', permission: 'permissions' },
  // Awarding is the exception under /loot; everything else there — categories,
  // items, and the whole questlog import/link family — manages the catalog, so
  // the bare prefix falls to loot.catalog and only /loot/awards is an award.
  { prefix: '/loot/awards', permission: 'loot.awards' },
  { prefix: '/loot', permission: 'loot.catalog' },
  { prefix: '/currency-awards', permission: 'loot.currency' },
  { prefix: '/lucent-requests', permission: 'loot.requests' },
].sort((a, b) => b.prefix.length - a.prefix.length);

// Read-only endpoints every admin page leans on — the member picker appears on
// Parties, LOA, Lucent & Shards and Lucent Requests. Gating these on one
// capability would stop a loot officer loading the list they need, so they take
// any capability at all instead.
// '/market-potentials' is third-party auction-house data, not guild data — it
// prices requests but reveals nothing about the guild, so any officer can read
// it whichever loot capability they hold.
const ANY_PERMISSION_PATHS = ['/whoami', '/members', '/market-potentials'];

const matches = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

// The capability a path needs: a permission key, ANY for the shared reads, or
// null when nothing matches — null fails closed at the call site rather than
// falling through as public.
const ANY = Symbol('any-permission');

function permissionForPath(path) {
  if (ANY_PERMISSION_PATHS.some((p) => matches(path, p))) return ANY;
  const hit = ROUTE_PERMISSIONS.find((r) => matches(path, r.prefix));
  return hit ? hit.permission : null;
}

// Grants change rarely and are read on every login and hourly re-verify, so a
// short cache keeps that off the database without making revocation feel stale
// — the session itself already caches permissions for far longer.
//
// Keyed by guild. A single shared cache here would have been the worst kind of
// leak: not merely showing one guild another's data, but handing one guild's
// members the capabilities another guild granted, since resolveFor() matches
// grants by Discord role id and those ids are unique per Discord server but the
// grant rows were not separated at all.
const CACHE_TTL_MS = 60 * 1000;
const perGuild = new Map(); // guildId -> { rows, at }

async function loadGrants(guildId) {
  // No guild means no grants. Returning [] rather than throwing keeps the
  // caller's failure mode "this member has no capabilities" — which fails
  // closed — instead of a 500 on a path as load-bearing as login.
  if (!supabase || !guildId) return [];

  const hit = perGuild.get(guildId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;

  const { data, error } = await tenantDb(supabase, guildId).from('permission_grants')
    .select('subject_type, subject_id, subject_label, permission');
  if (error) {
    // Serve a stale cache rather than silently dropping everyone's access; a
    // fresh boot with a broken database grants nothing, which fails closed.
    console.error('permission_grants load failed:', error.message);
    return hit ? hit.rows : [];
  }
  const rows = data || [];
  perGuild.set(guildId, { rows, at: Date.now() });
  return rows;
}

// Drop one guild's cached grants. Called after a grant changes, so only the
// guild that changed pays the reload — clearing every tenant's cache because
// one officer edited one role would be a self-inflicted thundering herd.
// No argument clears everything, which is only for tests and shutdown.
function invalidate(guildId) {
  if (guildId) perGuild.delete(guildId);
  else perGuild.clear();
}

// Does this session hold a capability? Sessions issued before capabilities
// existed carry no permissions array; an old admin token counts as full access
// until its next re-verify, so deploying this doesn't sign everyone out or strip
// a working session mid-request.
function userHas(user, permission) {
  if (!user) return false;
  if (Array.isArray(user.permissions)) return user.permissions.includes(permission);
  return !!user.isAdmin;
}

// Everything granted to any of this member's Discord roles, plus anything
// granted to them personally — WITHIN ONE GUILD. Capabilities are per-guild:
// the same person can run loot council in one house and be a plain member in
// another, so this is always answered for a specific guildId and never merged.
async function resolveFor({ guildId = null, roleIds = [], userId = null }) {
  const grants = await loadGrants(guildId);
  const roles = new Set(roleIds.map(String));
  const out = new Set();
  grants.forEach((g) => {
    if (!PERMISSION_KEYS.has(g.permission)) return; // stale key from an older release
    const applies = g.subject_type === 'role'
      ? roles.has(String(g.subject_id))
      : String(g.subject_id) === String(userId);
    if (applies) out.add(g.permission);
  });
  return [...out];
}

module.exports = {
  ALL_PERMISSIONS,
  PERMISSION_KEYS,
  ANY,
  permissionForPath,
  resolveFor,
  loadGrants,
  invalidate,
  userHas,
  supabase,
};
