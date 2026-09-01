// backend/staff.js — who runs Guild Hall itself.
//
// Every other permission in this codebase is a GUILD capability: it is granted
// inside one house, resolved against that house's Discord roles, and means
// nothing in any other. This is the one exception, and it is deliberately a
// separate mechanism rather than another entry in ALL_PERMISSIONS — because it
// answers a different question. Not "what may this officer do in their house",
// but "does this person operate the platform".
//
// It exists for surfaces that belong to no tenant: right now the public
// Americas threat board, whose alliance map is one shared record that every
// visitor reads and no single guild owns. A guild officer, however senior in
// their own house, has no standing to rewrite what every other house sees.
//
// CONFIGURED BY ENVIRONMENT, not by the database, and that is on purpose: a
// tenant-facing admin page must never be able to promote someone to operating
// the platform. Changing this takes deploy access.
//
//   GUILD_HALL_STAFF_GUILD_ID  Discord server id of the Guild Hall HQ server
//   GUILD_HALL_STAFF_ROLE_ID   role within it that marks an operator
//   GUILD_HALL_STAFF_IDS       comma-separated Discord user ids, always staff
//
// The role pair is the intended route — add someone to the role, they are an
// operator; remove them, they are not. GUILD_HALL_STAFF_IDS is the bootstrap
// and the lifeboat: it needs no bot presence in the HQ server and keeps working
// when Discord is unreachable, which is exactly when you would otherwise be
// locked out of your own platform.
//
// With none of the three set, nobody is staff and the board is read-only for
// everyone. That is the correct failure: a misconfigured deployment must not
// hand the shared map to whoever happens to be signed in.
const { fetchMember, botConfigured } = require('./discord');

const STAFF_GUILD_ID = process.env.GUILD_HALL_STAFF_GUILD_ID || '';
const STAFF_ROLE_ID = process.env.GUILD_HALL_STAFF_ROLE_ID || '';
const STAFF_IDS = new Set(
  (process.env.GUILD_HALL_STAFF_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

const roleConfigured = !!(STAFF_GUILD_ID && STAFF_ROLE_ID && botConfigured);
const configured = roleConfigured || STAFF_IDS.size > 0;

if (!configured) {
  console.warn('⚠️  No Guild Hall staff configured — the threat board is read-only for everyone. '
    + 'Set GUILD_HALL_STAFF_ROLE_ID + GUILD_HALL_STAFF_GUILD_ID, or GUILD_HALL_STAFF_IDS.');
} else if (STAFF_GUILD_ID && STAFF_ROLE_ID && !botConfigured) {
  console.warn('⚠️  Guild Hall staff role is set but the Discord bot is not configured — '
    + 'falling back to GUILD_HALL_STAFF_IDS only.');
}

// Resolved at login and at each session re-verify, never per request: this can
// cost a Discord call, and the answer changes about as often as someone joins
// the operations team. The session carries the result (see buildSession), so a
// revoked operator keeps access until their next re-verify — the same latency
// every other capability in this codebase already has.
async function isStaff(userId) {
  if (!userId) return false;
  if (STAFF_IDS.has(String(userId))) return true;
  if (!roleConfigured) return false;

  try {
    const { status, member } = await fetchMember(userId, STAFF_GUILD_ID);
    if (status !== 200 || !member) return false; // 404 = not in the HQ server
    return (member.roles || []).map(String).includes(String(STAFF_ROLE_ID));
  } catch (err) {
    // Discord being unreachable is our outage, not a demotion. Denying is still
    // the right answer for this request — the alternative is granting platform
    // access on an error — but it must not be silent.
    console.warn(`Staff check for ${userId} failed:`, err.message);
    return false;
  }
}

module.exports = { isStaff, configured, roleConfigured, STAFF_GUILD_ID, STAFF_ROLE_ID };
