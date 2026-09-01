// backend/threatBoard.js — this house's reading of the Americas threat board.
//
// The board's own contents (clusters, guilds, threat ratings) are a static
// import from the community spreadsheet — see shared/threatBoard.json and
// scripts/importThreatBoard.js. Nothing here writes that.
//
// What this module owns is the layer on top: which guilds are allied to which.
// That is a per-guild reading, so every query goes through tenantDb and is
// scoped like any other tenant data.
//
// The one-alliance-per-guild rule is enforced by the schema (see
// migrations/saas_006_threat_board.sql), not by checks here. This module's job
// is to refuse names that aren't on the board and to keep the stored shape
// honest — an alliance is symmetric, so a row is only ever reported when both
// halves agree.
const BOARD = require('../shared/threatBoard.json');
const { tenantDb } = require('./tenantDb');

// Names are matched case-insensitively so a mark survives the sheet changing
// "GOMDOL" to "Gomdol", but the canonical spelling is always what we store.
const CANON = new Map(BOARD.guilds.map((g) => [g.name.toLowerCase(), g.name]));
const canonical = (name) => CANON.get(String(name || '').trim().toLowerCase()) || null;

module.exports = function createThreatBoard(supabase) {
  const db = (guildId) => tenantDb(supabase, guildId).from('threat_board_marks');

  return {
    // The static board, served alongside the marks so the page makes one call.
    board: BOARD,
    canonical,

    // Every alliance this house has mapped. Rows naming a guild that has since
    // left the board are dropped rather than returned: the page has no way to
    // draw them, and a half-visible bond reads as a bug.
    //
    // Reported only where both directions agree. The schema makes a one-sided
    // bond impossible to create, so this is a guard against rows hand-edited in
    // the database, not against normal use.
    async marks(guildId) {
      const { data, error } = await db(guildId).select('name, partner');
      if (error) { console.error('threatBoard.marks error:', error.message); return { allies: {} }; }

      const rows = (data || []).filter((r) => canonical(r.name) && canonical(r.partner));
      const partnerOf = new Map(rows.map((r) => [r.name, r.partner]));
      const allies = {};
      for (const r of rows) {
        if (partnerOf.get(r.partner) === r.name) allies[canonical(r.name)] = canonical(r.partner);
      }
      return { allies };
    },

    // Bond two guilds. Returns the names whose alliances this broke, so the
    // caller can say what it cost. Both names must be on the board.
    async setAlly(guildId, aRaw, bRaw) {
      const a = canonical(aRaw), b = canonical(bRaw);
      if (!a || !b) throw new Error('Both guilds must be on the board.');
      if (a === b) throw new Error('A guild cannot ally itself.');
      // RPC, not an upsert pair: dissolving up to two existing alliances and
      // writing the new one has to be one transaction. tenantDb.rpc adds
      // p_guild_id so the scope can't be forgotten.
      const { data, error } = await tenantDb(supabase, guildId)
        .rpc('set_threat_ally', { p_a: a, p_b: b });
      if (error) throw new Error(error.message);
      return { a, b, freed: data || [] };
    },

    // Break whatever alliance this guild holds, from either side. A row exists
    // only to record a bond, so both sides are deleted rather than blanked.
    async clearAlly(guildId, nameRaw) {
      const name = canonical(nameRaw);
      if (!name) throw new Error('That guild is not on the board.');
      const { data, error } = await db(guildId).select('partner').eq('name', name).maybeSingle();
      if (error) throw new Error(error.message);
      const partner = data?.partner || null;
      if (!partner) return { name, partner: null };

      // Both sides in one statement — .in() covers the pair without a second
      // round trip, and leaves every other guild's row untouched.
      const { error: delErr } = await db(guildId).delete().in('name', [name, partner]);
      if (delErr) throw new Error(delErr.message);
      return { name, partner: canonical(partner) || partner };
    },

    async clearAll(guildId) {
      const { error } = await db(guildId).delete().neq('name', '');
      if (error) throw new Error(error.message);
    },
  };
};
