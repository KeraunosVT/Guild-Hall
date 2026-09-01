// backend/threatBoard.js — the Americas alliance map.
//
// The board's own contents (clusters, guilds, threat ratings) are a static
// import from the community spreadsheet — see shared/threatBoard.json and
// scripts/importThreatBoard.js. Nothing here writes that.
//
// What this module owns is the layer on top: which guilds are allied to which.
//
// NOT GUILD-SCOPED, unlike almost everything else in this backend. The page is
// public and belongs to no house, so there is one alliance map and everyone
// reads the same one. threat_alliances is therefore listed in GLOBAL_TABLES
// (backend/tenantDb.js) and queried with the bare client. Write access is what
// is restricted, and that gate lives at the route in server.js.
//
// The one-alliance-per-guild rule is enforced by the schema (see
// migrations/saas_006_threat_board.sql), not by checks here. This module's job
// is to refuse names that aren't on the board and to keep the stored shape
// honest — an alliance is symmetric, so a bond is only reported when both
// halves agree.
const BOARD = require('../shared/threatBoard.json');

// Names are matched case-insensitively so a bond survives the sheet changing
// "GOMDOL" to "Gomdol", but the canonical spelling is always what we store.
const CANON = new Map(BOARD.guilds.map((g) => [g.name.toLowerCase(), g.name]));
const canonical = (name) => CANON.get(String(name || '').trim().toLowerCase()) || null;

module.exports = function createThreatBoard(supabase) {
  const table = () => supabase.from('threat_alliances');

  return {
    // The static board, served alongside the map so the page makes one call.
    board: BOARD,
    canonical,

    // Every alliance on record. Rows naming a guild that has since left the
    // board are dropped rather than returned: the page has no way to draw them,
    // and a half-visible bond reads as a bug.
    //
    // Reported only where both directions agree. The schema makes a one-sided
    // bond impossible to create, so this is a guard against rows hand-edited in
    // the database, not against normal use.
    // Never throws. The ratings are static and the page is public, so a database
    // that is down or unreachable should cost the visitor the alliance overlay,
    // not the whole board.
    async allies() {
      let data, error;
      try {
        ({ data, error } = await table().select('name, partner'));
      } catch (e) {
        console.error('threatBoard.allies unreachable:', e.message);
        return {};
      }
      if (error) { console.error('threatBoard.allies error:', error.message); return {}; }

      const rows = (data || []).filter((r) => canonical(r.name) && canonical(r.partner));
      const partnerOf = new Map(rows.map((r) => [r.name, r.partner]));
      const out = {};
      for (const r of rows) {
        if (partnerOf.get(r.partner) === r.name) out[canonical(r.name)] = canonical(r.partner);
      }
      return out;
    },

    // Bond two guilds. Returns the names whose alliances this broke, so the
    // caller can say what it cost. Both names must be on the board.
    async setAlly(aRaw, bRaw, actor) {
      const a = canonical(aRaw), b = canonical(bRaw);
      if (!a || !b) throw new Error('Both guilds must be on the board.');
      if (a === b) throw new Error('A guild cannot ally itself.');
      // RPC, not an upsert pair: dissolving up to two existing alliances and
      // writing the new one has to be one transaction.
      const { data, error } = await supabase.rpc('set_threat_ally', {
        p_a: a, p_b: b, p_actor: actor || null,
      });
      if (error) throw new Error(error.message);
      return { a, b, freed: data || [] };
    },

    // Break whatever alliance this guild holds, from either side. A row exists
    // only to record a bond, so both sides are deleted rather than blanked.
    async clearAlly(nameRaw) {
      const name = canonical(nameRaw);
      if (!name) throw new Error('That guild is not on the board.');
      const { data, error } = await table().select('partner').eq('name', name).maybeSingle();
      if (error) throw new Error(error.message);
      const partner = data?.partner || null;
      if (!partner) return { name, partner: null };

      // Both sides in one statement — .in() covers the pair without a second
      // round trip, and leaves every other bond untouched.
      const { error: delErr } = await table().delete().in('name', [name, partner]);
      if (delErr) throw new Error(delErr.message);
      return { name, partner: canonical(partner) || partner };
    },
  };
};
