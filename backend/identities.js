// backend/identities.js — one place for player_identities lookups.
// The identities table is the glue between in-game names, canonical display
// names, and Discord ids. Half a dozen routes used to each query it and
// hand-build their own lookup maps; this module loads it once (with a short
// cache), normalizes names one way, and exposes the three lookups everything
// actually needs.
//
// load() NEVER throws: identity mapping is cosmetic in most routes (nicer
// display names), so on a failed refresh it serves the last good snapshot, and
// on a failed first load it serves an empty one — names simply fall back to
// whatever the caller already had, instead of 500ing the page.

const CACHE_TTL_MS = (parseInt(process.env.IDENTITY_CACHE_SECONDS, 10) || 30) * 1000;

const norm = (s) => (s || '').trim().toLowerCase();

function buildSnapshot(rows) {
  const byName = new Map();    // normalized name (display or alias) -> identity row
  const byDiscord = new Map(); // discord_id -> identity row
  rows.forEach((it) => {
    const names = [it.display_name, ...(Array.isArray(it.ingame_names) ? it.ingame_names : [])];
    names.filter(Boolean).forEach((n) => byName.set(norm(n), it));
    if (it.discord_id) byDiscord.set(it.discord_id, it);
  });
  return {
    rows,

    // Full identity row for any known name (display or alias), else null.
    identityForName: (name) => byName.get(norm(name)) || null,

    // Canonical display name for any known name; unknown names pass through.
    resolveName: (name) => byName.get(norm(name))?.display_name || name,

    // Discord id for any known name, else null.
    discordIdFor: (name) => byName.get(norm(name))?.discord_id || null,

    // Display name for a Discord id, else the caller's fallback.
    displayNameFor: (discordId, fallback = null) =>
      byDiscord.get(discordId)?.display_name || fallback,
  };
}

const EMPTY = buildSnapshot([]);

module.exports = function createIdentities(supabase) {
  let cache = null;      // last good snapshot
  let cacheAt = 0;
  let inFlight = null;   // Promise while a fetch is running

  async function fetchSnapshot() {
    const { data, error } = await supabase
      .from('player_identities')
      .select('id, display_name, ingame_names, discord_id');
    if (error) throw new Error(error.message);
    return buildSnapshot(data || []);
  }

  return {
    norm,

    async load() {
      if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
      if (inFlight) return inFlight;
      inFlight = fetchSnapshot()
        .then((snap) => {
          cache = snap;
          cacheAt = Date.now();
          return snap;
        })
        .catch((err) => {
          console.error('identities load failed:', err.message);
          return cache || EMPTY; // stale beats broken; empty beats 500
        })
        .finally(() => { inFlight = null; });
      return inFlight;
    },

    // Call after any write to player_identities so the next load() refetches.
    // Only the TTL is expired — the old snapshot is kept as the stale fallback
    // in case that refetch fails.
    invalidate() {
      cacheAt = 0;
    },
  };
};
