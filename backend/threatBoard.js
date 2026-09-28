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
//     drops out of every filter rather than failing visibly;
//   · at most one guild per cluster holds the crown (`king`). A unique index
//     enforces it (migrations/saas_011), and moving the crown goes through the
//     set_threat_king RPC so the old holder is uncrowned in the same
//     transaction. A guild that transfers servers leaves its crown behind.
const SEED = require('../shared/threatBoard.json');

const STATUSES = [
  'Threat', 'Competitive', 'Potential', 'Rebuild/TBD', 'Not Competitive', 'Disbanded/Merged',
];
const CDS = ['30 Days', '15 Days', 'No CD'];

module.exports = function createThreatBoard(supabase) {
  const guilds = () => supabase.from('threat_guilds');
  const alliances = () => supabase.from('threat_alliances');
  const clusters = () => supabase.from('threat_clusters');

  // Validate the editable fields that were supplied. Returns only the ones
  // present, cleaned; throws a sentence the page can show as-is.
  async function cleanFields(patch) {
    const out = {};
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) throw new Error(`Unknown status "${patch.status}".`);
      out.status = patch.status;
    }
    if (patch.cd !== undefined) {
      const cd = patch.cd === '' || patch.cd === null ? null : patch.cd;
      if (cd !== null && !CDS.includes(cd)) throw new Error(`Unknown transfer cooldown "${patch.cd}".`);
      out.cd = cd;
    }
    if (patch.cluster !== undefined) {
      const { data: c } = await clusters().select('label').eq('label', patch.cluster).maybeSingle();
      if (!c) throw new Error(`Unknown cluster "${patch.cluster}".`);
      out.cluster = patch.cluster;
    }
    if (patch.name !== undefined) {
      const next = String(patch.name).trim();
      if (!next) throw new Error('A guild needs a name.');
      if (next.length > 120) throw new Error('That name is too long.');
      out.name = next;
    }
    return out;
  }

  // (cluster, name) is unique, so both adding and editing check it first —
  // the constraint would reject a clash anyway, but as a raw 23505.
  async function assertNoClash(cluster, name, selfId) {
    const { data: clash } = await guilds()
      .select('id').eq('cluster', cluster).eq('name', name).maybeSingle();
    if (clash && clash.id !== selfId) throw new Error(`${cluster} already has a guild called "${name}".`);
  }

  const api = {
    STATUSES,
    CDS,

    // The whole board in one read. Never throws: the page is public, so a
    // database that is down or unreachable should cost a visitor the live data,
    // not the page — it falls back to the seed the build shipped with.
    async board() {
      try {
        const [g, c, a] = await Promise.all([
          guilds().select('id, name, cluster, status, cd, king, updated_at').order('name'),
          clusters().select('label, servers, position').order('position'),
          // Only the newest bond is needed, for "last updated".
          alliances().select('updated_at').order('updated_at', { ascending: false }).limit(1),
        ]);
        if (g.error || c.error) throw new Error(g.error?.message || c.error?.message);
        // An empty table means saas_007 has not been run yet. Serving the seed
        // is better than serving an empty board, and the page still works.
        if (!g.data?.length) return { ...api.seedBoard(), stale: true };

        // When the board last changed: the newest edit to any guild or any
        // alliance. Breaking an alliance deletes its rows, so that one change
        // leaves no timestamp behind — the date reflects everything else.
        const stamps = [...g.data.map((r) => r.updated_at), ...(a.data || []).map((r) => r.updated_at)]
          .filter(Boolean).map((t) => new Date(t).getTime());
        const lastUpdated = stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;

        return {
          source: SEED.source,
          importedAt: SEED.importedAt,
          lastUpdated,
          clusters: c.data.map(({ label, servers }) => ({ label, servers })),
          guilds: g.data.map(({ updated_at: _u, ...rest }) => rest),
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
        // The seed is as current as its import.
        lastUpdated: SEED.importedAt ? new Date(SEED.importedAt).toISOString() : null,
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
      const clean = await cleanFields(patch);
      const row = {};
      for (const [k, v] of Object.entries(clean)) if (v !== (current[k] ?? null)) row[k] = v;

      // A guild that transfers servers doesn't take the crown with it: the
      // cluster it left still has whoever actually holds it, and the one it
      // joins already has a king of its own (the unique index would refuse two).
      const moving = !!row.cluster;
      if (moving && current.king) row.king = false;

      if (patch.king !== undefined && typeof patch.king !== 'boolean') throw new Error('Crown must be true or false.');
      const wasKing = current.king && !moving;
      const crown = patch.king === true && !wasKing;
      const uncrown = patch.king === false && wasKing;

      if (!Object.keys(row).length && !crown && !uncrown) throw new Error('Nothing to change.');

      // Uniqueness is (cluster, name), so a MOVE can collide just as a rename
      // can — transferring onto a server that already has a guild of this name
      // is the same clash. Checked against whichever of the two is changing.
      if (row.name || row.cluster) await assertNoClash(row.cluster ?? current.cluster, row.name ?? current.name, id);

      let data = current;
      if (Object.keys(row).length || uncrown) {
        if (uncrown) row.king = false;
        row.updated_at = new Date().toISOString();
        row.updated_by = actor || null;
        const res = await guilds().update(row).eq('id', id).select().maybeSingle();
        if (res.error) throw new Error(res.error.message);
        data = res.data;
      }

      // Crowned last, after any move, so it lands in the cluster the guild
      // now sits on — and through the RPC, so the old holder is uncrowned in
      // the same transaction.
      let previousKing = null;
      if (crown) {
        const { data: prevId, error } = await supabase.rpc('set_threat_king', { p_guild: id, p_actor: actor || null });
        if (error) throw new Error(error.message);
        if (prevId) previousKing = (await api.byId(prevId))?.name || null;
        data = await api.byId(id);
      }

      return { ...data, previousKing, crownDropped: moving && current.king };
    },

    // A guild the board doesn't have yet — a new guild, or one the import
    // missed. Starts uncrowned and unallied; both are set afterwards the same
    // way as for any other guild.
    async addGuild(fields, actor) {
      const clean = await cleanFields({
        name: fields.name ?? '',
        cluster: fields.cluster ?? '',
        status: fields.status ?? 'Potential',
        cd: fields.cd ?? null,
      });
      await assertNoClash(clean.cluster, clean.name, null);
      const { data, error } = await guilds().insert({
        ...clean,
        king: false,
        updated_at: new Date().toISOString(),
        updated_by: actor || null,
      }).select().single();
      if (error) throw new Error(error.message);
      return data;
    },
  };

  return api;
};
