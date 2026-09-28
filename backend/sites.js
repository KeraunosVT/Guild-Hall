// backend/sites.js — which of Guild Hall's front doors a request came through.
//
// One process serves two hosts:
//   guild-hall.gg        the guild app (landing page, sidebar, everything)
//   merc.guild-hall.gg   the wargame fill pool, for players and leaders who
//                        may belong to no Guild Hall guild at all
//
// The merc host is configured, never inferred: MERC_ORIGIN is the full origin
// (e.g. https://merc.guild-hall.gg, or http://merc.localhost:5173 in dev), and a
// request is "merc" only when its Host header matches that origin's host
// exactly. Anything else is the main site. That matters because the answer
// picks an OAuth redirect: building one from whatever Host a client sent would
// let a forged header steer a login somewhere else.
//
// Unset MERC_ORIGIN and every request is the main site — the feature's pages
// still exist inside the guild app, there is just no separate door.

function normalizeOrigin(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    console.error(`MERC_ORIGIN "${value}" is not a valid origin — the merc host is disabled.`);
    return null;
  }
}

const MERC_ORIGIN = normalizeOrigin(process.env.MERC_ORIGIN);
const MERC_HOST = MERC_ORIGIN ? new URL(MERC_ORIGIN).host.toLowerCase() : null;

function isMerc(req) {
  if (!MERC_HOST) return false;
  return String(req.get('host') || '').toLowerCase() === MERC_HOST;
}

// Where to send someone to answer a fill invite — used in Discord DMs, which
// have no request to read a host from.
function mercUrl(pathname = '/') {
  return MERC_ORIGIN ? `${MERC_ORIGIN}${pathname}` : null;
}

module.exports = { MERC_ORIGIN, MERC_HOST, isMerc, mercUrl };
