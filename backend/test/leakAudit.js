// ============================================================================
// Static leak audit (plan Phase 4 — "manual leak audit", made automatic)
// ============================================================================
// Three checks the integration test cannot make, because they are about code
// that exists rather than code that ran:
//
//   1. Every .from('table') either goes through a guild-scoped client, or the
//      table is on the GLOBAL allow-list, or the site is on the reviewed
//      exceptions list below. A new unscoped query fails this.
//   2. Every module-level cache is keyed by guild. A Map keyed by anything else
//      serves one tenant's value to another.
//   3. Every guild-scoped upsert names guild_id in its onConflict target.
//      Without it the upsert matches no constraint at all.
//
// This exists because the obvious grep — `supabase\.from\(` on one line —
// silently misses `supabase\n  .from(`, which is how five leaking war-record
// queries survived a conversion that reported itself complete.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const { GLOBAL_TABLES } = require('../tenantDb');

// Sites that are unscoped on purpose. Each needs a reason, and the reason has
// to be about the data — "it was hard to convert" is not one.
const ALLOWED_UNSCOPED = [
  { file: 'guildRegistry.js', table: 'guilds', why: 'the tenant registry itself; scoped by id, not guild_id' },
  { file: 'questlogImport.js', table: 'questlog_items', why: 'global game reference data, shared by every guild' },
  { file: 'admin.js', table: 'questlog_items', why: 'global game reference data, shared by every guild' },
  { file: 'admin.js', table: 'market_potentials', why: 'auction-house prices, identical for every guild' },
  { file: 'tenantDb.js', table: 'loot_items', why: 'usage examples in this module\'s own header comment' },
];

let fail = 0;
const problems = [];
const report = (msg) => { fail++; problems.push(msg); };

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// ── 1. Unscoped queries ─────────────────────────────────────────────────────
// Deliberately multi-line aware: the receiver and .from() may be on separate
// lines, which is exactly the form the single-line grep missed.
const FROM = /(\w+)\s*(?:\)|\s)?\s*\.\s*from\(\s*['"]([a-z_]+)['"]/gs;
let scanned = 0, scoped = 0;

for (const f of files) {
  const src = read(f);
  for (const m of src.matchAll(FROM)) {
    const [, recv, table] = m;
    if (recv === 'q') continue;                    // tenantDb's own internals
    scanned++;
    // Anything reached through the wrapper is scoped by construction.
    if (recv !== 'supabase') { scoped++; continue; }
    if (GLOBAL_TABLES.has(table)) { scoped++; continue; }
    const allowed = ALLOWED_UNSCOPED.some((a) => a.file === f && a.table === table);
    if (allowed) { scoped++; continue; }
    report(`UNSCOPED QUERY  ${f}:${lineOf(src, m.index)}  supabase.from('${table}') — not global, not allow-listed`);
  }
}
console.log(`1. queries: ${scanned} scanned, ${scoped} scoped or allow-listed`);

// ── 2. Caches keyed by guild ────────────────────────────────────────────────
// A module-level Map is fine; a module-level scalar cache is the dangerous
// shape, because there is exactly one of it for every tenant.
// A Map is necessary but NOT sufficient: a Map keyed on something that doesn't
// include the guild is exactly as leaky as a scalar, and harder to see. This
// caught /api/players, whose queries were all correctly scoped but which sat
// behind a cache keyed `last:${lastN}` — the first guild to load the roster
// filled the entry and every other guild was served its player list.
const CACHE_DECL = /^(?:let|const)\s+(\w*(?:[Cc]ache|CACHE|InFlight|perGuild)\w*)\s*=\s*(.+?);/gm;

// Module-level state that is not per-tenant data.
const NOT_TENANT_STATE = {
  'discord.js': ['CACHE_TTL_MS'],
  'guildRegistry.js': ['CACHE_TTL_MS'],
  'permissions.js': ['CACHE_TTL_MS'],
  'server.js': ['PLAYERS_CACHE_TTL_MS'],
  'identities.js': ['CACHE_TTL_MS'],
  // Keyed by Discord user id, and holds an in-flight promise for that user's
  // own re-verification — not guild data.
  'auth.js': ['reverifyInFlight'],
};

let caches = 0;
for (const f of files) {
  const src = read(f);
  for (const m of src.matchAll(CACHE_DECL)) {
    const [, name, init] = m;
    if ((NOT_TENANT_STATE[f] || []).includes(name)) continue;
    caches++;

    if (!/new Map\(\)|makeCache\(/.test(init)) {
      report(`UNKEYED CACHE   ${f}:${lineOf(src, m.index)}  ${name} = ${init} — one value for every tenant; key it by guild`);
      continue;
    }
    if (/makeCache\(/.test(init)) continue; // helper takes the guild id as its key

    // It's a Map. Every key expression written into it must mention a guild.
    const writes = [...src.matchAll(new RegExp(`${name}\\.set\\(\\s*([^,]+),`, 'g'))];
    const keyVars = new Set(writes.map((w) => w[1].trim()));
    for (const kv of keyVars) {
      // Either the key expression itself names a guild, or it's a variable
      // whose assignment does.
      const direct = /guild/i.test(kv);
      const assigned = new RegExp(`(?:const|let)\\s+${kv.replace(/[^\w]/g, '')}\\s*=\\s*([^;]+);`).exec(src);
      const viaVar = assigned ? /guild/i.test(assigned[1]) : false;
      if (!direct && !viaVar) {
        report(`UNGUILDED KEY   ${f}:${lineOf(src, m.index)}  ${name} keyed by \`${kv}\` — no guild in the key, so one tenant's value is served to another`);
      }
    }
  }
}
console.log(`2. caches: ${caches} module-level caches, all keyed by guild`);

// ── 3. onConflict targets include guild_id ──────────────────────────────────
// Composite keys were widened with guild_id in Phase 1, so an upsert that names
// the old target matches no unique constraint and fails outright.
const UPSERT = /\.upsert\(([\s\S]{0,400}?)\)\s*[;\n]/g;
let upserts = 0;
for (const f of files) {
  const src = read(f);
  for (const m of src.matchAll(UPSERT)) {
    const body = m[1];
    const oc = body.match(/onConflict:\s*['"]([^'"]+)['"]/);
    if (!oc) continue;
    upserts++;
    const target = oc[1];
    const table = (body.match(/from\(\s*['"]([a-z_]+)['"]/) || [])[1];
    if (table && GLOBAL_TABLES.has(table)) continue;
    if (!target.split(',').map((s) => s.trim()).includes('guild_id')) {
      report(`ONCONFLICT      ${f}:${lineOf(src, m.index)}  onConflict:'${target}' omits guild_id`);
    }
  }
}
console.log(`3. upserts: ${upserts} with an onConflict target, all include guild_id`);

// ── 4. dbFor(req) only where req exists ─────────────────────────────────────
// The bulk conversion rewrote `supabase.from(` to `dbFor(req).from(` by regex,
// which happily rewrote module-level helpers that never had a `req`. Those
// don't leak — they throw "req is not defined" and 500 the route — but they are
// invisible until someone loads that exact page, and the player profile shipped
// broken for exactly that reason. A scoped client must be passed in.
const FN = /^(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
let helpers = 0;
for (const f of files) {
  const src = read(f);
  for (const m of src.matchAll(FN)) {
    const [, name, params] = m;
    if (/\breq\b/.test(params)) continue;
    const end = src.indexOf('\n}', m.index + m[0].length);
    const body = src.slice(m.index + m[0].length, end === -1 ? undefined : end);
    // A nested (req, res) handler inside re-introduces req legitimately.
    if (/\(\s*req\s*,\s*res\b/.test(body)) continue;
    if (/\breq\b/.test(body)) {
      helpers++;
      report(`REQ OUT OF SCOPE ${f}:${lineOf(src, m.index)}  function ${name}(${params}) uses req — pass the scoped client in instead`);
    }
  }
}
console.log(`4. helpers: no module-level function references an out-of-scope req`);

// ── 5. No guild-specific config read from env ───────────────────────────────
// Per-guild config must come from the guilds row. Reading it from env means one
// deployment's values apply to every tenant on it — one guild's officer roles
// granting powers inside another's, or one guild's LOA posts landing in
// another's channel. Neither errors; both are silent cross-tenant bleed.
//
// DISCORD_BOT_TOKEN and the OAuth client secrets stay in env: they belong to the
// deployment, not to any guild.
const GUILD_SCOPED_ENV = [
  'DISCORD_GUILD_ID', 'DISCORD_ADMIN_ROLE_IDS', 'DISCORD_ALLOWED_ROLE_IDS',
  'DISCORD_MEMBER_ROLE_IDS', 'DISCORD_ROSTER_CHANNEL_ID', 'DISCORD_LOA_CHANNEL_ID',
  'DISCORD_ANNOUNCE_CHANNEL_ID',
];
let envReads = 0;
for (const f of files) {
  const src = read(f);
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return; // comments may still name them
    for (const name of GUILD_SCOPED_ENV) {
      if (line.includes(name)) {
        envReads++;
        report(`GUILD CONFIG IN ENV ${f}:${i + 1}  reads ${name} — per-guild config belongs on the guilds row`);
      }
    }
  });
}
console.log(`5. env: no guild-specific config read from environment variables`);

// ── Result ──────────────────────────────────────────────────────────────────
if (fail) {
  console.log(`\n${fail} problem(s):`);
  problems.forEach((p) => console.log('  ' + p));
  console.log('\nIf a finding is intentional, add it to ALLOWED_UNSCOPED with a reason.');
  process.exit(1);
}
console.log('\nleak audit clean');
