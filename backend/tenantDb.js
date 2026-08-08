// ============================================================================
// tenantDb — a guild-scoped wrapper around the Supabase client.
// ============================================================================
// The multi-tenant guarantee, made the DEFAULT instead of a thing you remember.
//
// Instead of:
//   supabase.from('loot_items').select('*').eq('guild_id', req.guildId)
//   supabase.from('loot_items').insert({ ...row, guild_id: req.guildId })
// you write:
//   const db = tenantDb(supabase, req.guildId);
//   db.from('loot_items').select('*')      // guild_id filter injected
//   db.from('loot_items').insert(row)      // guild_id stamped on the row
//
// Reads (select) and writes that target existing rows (update, delete) get an
// automatic .eq('guild_id', guildId). Inserts and upserts get guild_id stamped
// onto every row. You cannot forget the filter, because you never write it.
//
// GLOBAL tables (game-fact caches, not guild data) are listed in GLOBAL_TABLES
// and bypass all scoping — a deliberate, visible allow-list rather than a silent
// gap. Everything not on that list is treated as tenant data and scoped.
//
// LIMITS (by design — these need explicit handling, see the escape hatch):
//   - RPC calls: not routed through here. Pass p_guild_id explicitly.
//   - Complex filters (.or(), joins across tables, aggregate queries): use
//     db.raw() to get the unscoped client and scope by hand WITH REVIEW.
// ============================================================================

// Tables that are intentionally NOT guild-scoped: shared caches of game facts
// that contain nothing private to any guild. Adding a table here is a conscious
// decision to make it global — do it deliberately.
const GLOBAL_TABLES = new Set([
  'questlog_items',    // canonical item defs scraped from questlog.gg
  'market_potentials', // region-keyed market snapshots
  'guilds',            // the tenant registry itself (scoped by id, not guild_id)
  'storage',           // never reached via .from() here, listed for clarity
]);

function tenantDb(supabase, guildId) {
  if (!supabase) throw new Error('tenantDb: supabase client is required');
  if (!guildId) throw new Error('tenantDb: guildId is required — refusing to run unscoped');

  return {
    // Escape hatch for the handful of queries the wrapper can't safely cover
    // (RPCs, joins, .or() logic). Returns the bare client. Anything using this
    // MUST scope by guild_id by hand and should be reviewed — grep for .raw().
    raw: () => supabase,
    guildId,

    from(table) {
      const isGlobal = GLOBAL_TABLES.has(table);
      const q = supabase.from(table);
      if (isGlobal) return q; // global tables: no scoping, use the client as-is

      return {
        // SELECT — inject the guild filter. Returns the real PostgREST builder
        // after .eq, so .order/.limit/.range/.maybeSingle/.single all chain
        // normally downstream.
        select(...args) {
          return q.select(...args).eq('guild_id', guildId);
        },

        // INSERT — stamp guild_id on every row (accepts one object or an array).
        insert(rows, opts) {
          const stamped = Array.isArray(rows)
            ? rows.map((r) => ({ ...r, guild_id: guildId }))
            : { ...rows, guild_id: guildId };
          return q.insert(stamped, opts);
        },

        // UPSERT — stamp guild_id, same as insert. Note: the onConflict target
        // must include guild_id for composite-key tables (e.g. member_roles's
        // PK is (guild_id, discord_id)) — pass that in opts.onConflict.
        upsert(rows, opts) {
          const stamped = Array.isArray(rows)
            ? rows.map((r) => ({ ...r, guild_id: guildId }))
            : { ...rows, guild_id: guildId };
          return q.upsert(stamped, opts);
        },

        // UPDATE — scope the update to this guild's rows. Chain further .eq()s
        // (e.g. .eq('discord_id', x)) after this as normal.
        update(values, opts) {
          return q.update(values, opts).eq('guild_id', guildId);
        },

        // DELETE — scope the delete to this guild's rows. Chain further .eq()s
        // after this to narrow which of the guild's rows are removed.
        delete(opts) {
          return q.delete(opts).eq('guild_id', guildId);
        },
      };
    },

    // Guild-scoped RPC helper: adds p_guild_id to the params so call sites can't
    // forget it. Functions that also take p_guild_names still pass that too.
    //
    // p_guild_id is applied AFTER the caller's params, not before: spreading it
    // first would let a call site pass its own p_guild_id and silently override
    // the scope, which is the one thing this wrapper exists to make impossible.
    rpc(fn, params = {}) {
      return supabase.rpc(fn, { ...params, p_guild_id: guildId });
    },
  };
}

module.exports = { tenantDb, GLOBAL_TABLES };