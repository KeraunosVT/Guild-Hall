// backend/threatBoard.js — the Americas threat board.
//
// NOT GUILD-SCOPED, unlike almost everything else in this backend. The page is
// public and belongs to no house, so there is one board and everyone reads the
// same one. Both tables are listed in GLOBAL_TABLES (backend/tenantDb.js) and
// queried with the bare client. Write access is what is restricted, and that
// gate lives at the route in server.js: Guild Hall staff only.
//
// shared/threatBoard.json is the SEED, not the source of truth — see
// migrations/saas_007. The file still gets refreshed from the community
// spreadsheet by scripts/importThreatBoard.js, but once seeded the table is
// what the app reads and edits.
//
// Invariants worth knowing before changing anything here:
//   · a guild is keyed by a surrogate id, NOT by name — two guilds on
//     different servers may share one ("Original Sin" plays on ENCHANTED and
//     DISTORTION), and (cluster, name) is the pair that must be unique.
//     Alliances reference those ids, so neither a rename nor a server transfer
//     touches the alliance map at all;
//   · status and cd are closed sets, enforced by CHECK constraints as well as
//     by the guards below, because a bad value renders as an unstyled chip and
//     drops out of every filter rather than failing visibly.
const SEED = require('../shared/threatBoard.json');

const STATUSES = [
  'Threat', 'Competitive', 'Potential', 'Rebuild/TBD', 'Not Competitive', 'Disbanded/Merged',
];
const CDS = ['30 Days', '15 Days', 'No CD'];

module.exports = function createThreatBoard(supabase) {
  const guilds = () => supabase.from('threat_guilds');
  const alliances = () => supabase.from('threat_alliances');
  const clusters = () => supabase.from('threat_clusters');

  const api = {
    STATUSES,
    CDS,

    // The whole board in one read. Never throws: the page is public, so a
    // database that is down or unreachable should cost a visitor the live data,
    // not the page — it falls back to the seed the build shipped with.
    async board() {
      try {
        const [g, c] = await Promise.all([
          guilds().select('id, name, cluster, status, cd, king').order('name'),
          clusters().select('label, servers, position').order('position'),
        ]);
        if (g.error || c.error) throw new Error(g.error?.message || c.error?.message);
        // An empty table means saas_007 has not been run yet. Serving the seed
        // is better than serving an empty board, and the page still works.
        if (!g.data?.length) return { ...api.seedBoard(), stale: true };
        return {
          source: SEED.source,
          importedAt: SEED.importedAt,
          clusters: c.data.map(({ label, servers }) => ({ label, servers })),
          guilds: g.data,
        };
      } catch (e) {
        console.error('threatBoard.board falling back to seed:', e.message);
        return { ...api.seedBoard(), stale: true };
      }
    },

    // The read-only fallback, used when the table is empty or unreachable.
    //
    // Synthetic ids matter more than they look: the page keys everything by id,
    // and the seed file has none. Serving it raw would give every guild
    // id === undefined, which collapses them all into one entry and hands React
    // 130 identical keys. (cluster, name) is unique by definition, so it makes a
    // stable id — and nothing can be edited in this state anyway, since `stale`
    // turns the controls off.
    seedBoard() {
      return {
        source: SEED.source,
        importedAt: SEED.importedAt,
        clusters: SEED.clusters.map(({ label, servers }) => ({ label, servers })),
        guilds: SEED.guilds.map((g) => ({ ...g, id: `seed:${g.cluster}:${g.name}` })),
      };
    },

    // Every alliance on record, reported only where both directions agree. The
    // schema makes a one-sided bond impossible to create, so this guards against
    // rows hand-edited in the database, not against normal use.
    async allies() {
      let data, error;
      try {
        ({ data, error } = await alliances().select('guild_id, partner_id'));
      } catch (e) {
        console.error('threatBoard.allies unreachable:', e.message);
        return {};
      }
      if (error) { console.error('threatBoard.allies error:', error.message); return {}; }
      const partnerOf = new Map((data || []).map((r) => [r.guild_id, r.partner_id]));
      const out = {};
      for (const r of data || []) if (partnerOf.get(r.partner_id) === r.guild_id) out[r.guild_id] = r.partner_id;
      return out;
    },

    async byId(id) {
      const { data, error } = await guilds().select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data || null;
    },

    // Bond two guilds, by id. The foreign keys would reject an unknown guild
    // anyway; checking first turns a raw 23503 into a sentence.
    async setAlly(aId, bId, actor) {
      if (!aId || !bId) throw new Error('Two guilds are required.');
      if (aId === bId) throw new Error('A guild cannot ally itself.');
      const [a, b] = await Promise.all([api.byId(aId), api.byId(bId)]);
      if (!a) throw new Error('That guild is not on the board.');
      if (!b) throw new Error('That ally is not on the board.');
      // RPC, not an upsert pair: dissolving up to two existing alliances and
      // writing the new one has to be one transaction.
      const { data, error } = await supabase.rpc('set_threat_ally', {
        p_a: aId, p_b: bId, p_actor: actor || null,
      });
      if (error) throw new Error(error.message);
      return { a: a.name, b: b.name, freed: data || [] };
    },

    // Break whatever alliance this guild holds, from either side. A row exists
    // only to record a bond, so both sides are deleted rather than blanked.
    async clearAlly(id) {
      const { data, error } = await alliances().select('partner_id').eq('guild_id', id).maybeSingle();
      if (error) throw new Error(error.message);
      const partnerId = data?.partner_id || null;
      if (!partnerId) return { id, partner: null };
      const { error: delErr } = await alliances().delete().in('guild_id', [id, partnerId]);
      if (delErr) throw new Error(delErr.message);
      const partner = await api.byId(partnerId);
      return { id, partner: partner?.name || null };
    },

    // Edit one guild, by id. Every field is optional; only what is passed
    // changes. Nothing here touches the alliance map: bonds reference ids, so a
    // rename and a server transfer both leave them alone by construction.
    async updateGuild(id, patch, actor) {
      const current = await api.byId(id);
      if (!current) throw new Error('That guild is not on the board.');
      const row = {};

      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) throw new Error(`Unknown status "${patch.status}".`);
        if (patch.status !== current.status) row.status = patch.status;
      }
      if (patch.cd !== undefined) {
        const cd = patch.cd === '' || patch.cd === null ? null : patch.cd;
        if (cd !== null && !CDS.includes(cd)) throw new Error(`Unknown transfer cooldown "${patch.cd}".`);
        if (cd !== current.cd) row.cd = cd;
      }
      if (patch.cluster !== undefined && patch.cluster !== current.cluster) {
        const { data: c } = await clusters().select('label').eq('label', patch.cluster).maybeSingle();
        if (!c) throw new Error(`Unknown cluster "${patch.cluster}".`);
        row.cluster = patch.cluster;
      }
      if (patch.name !== undefined) {
        const next = String(patch.name).trim();
        if (!next) throw new Error('A guild needs a name.');
        if (next.length > 120) throw new Error('That name is too long.');
        if (next !== current.name) row.name = next;
      }

      if (!Object.keys(row).length) throw new Error('Nothing to change.');

      // Uniqueness is (cluster, name), so a MOVE can collide just as a rename
      // can — transferring onto a server that already has a guild of this name
      // is the same clash. Checked against whichever of the two is changing.
      const nextName = row.name ?? current.name;
      const nextCluster = row.cluster ?? current.cluster;
      if (row.name || row.cluster) {
        const { data: clash } = await guilds()
          .select('id').eq('cluster', nextCluster).eq('name', nextName).maybeSingle();
        if (clash && clash.id !== id) {
          throw new Error(`${nextCluster} already has a guild called "${nextName}".`);
        }
      }

      row.updated_at = new Date().toISOString();
      row.updated_by = actor || null;

      const { data, error } = await guilds().update(row).eq('id', id).select().maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
  };

  return api;
};
