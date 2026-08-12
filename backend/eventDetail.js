// backend/eventDetail.js — everything one logged night is, assembled once.
//
// ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
// Two surfaces ask for a night: the member page and the officer page. They show
// different amounts of it, but they must never disagree about the facts — who
// attended, who was excused, who said they were coming and wasn't there. That
// answer is reconciled from four separate sources (the attendance snapshot, the
// LOA calendar, the signup for that occurrence, and any late requests), and a
// second implementation of that reconciliation would be wrong within a month.
//
// So: one assembler, called by both routes, with `officer` deciding what is
// REDACTED rather than what is COMPUTED. Anything else and a member's view of a
// night becomes a subtly different night.
//
// ── WHAT THE OFFICER FLAG HIDES ─────────────────────────────────────────────
// Not the statuses — the LOA board is already guild-visible and so is the
// signup list, so who was excused is not a secret. What it hides is the free
// text: the REASON someone filed leave, the reason they gave for a late
// request, and who decided it. Those are written to officers, and a member
// reading "family thing" off someone else's absence is a different thing from
// reading that they were absent.
const WEAPON_CLASSES = require('../shared/weaponClasses.json');
const { tenantDb } = require('./tenantDb');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 'GreatswordDagger' -> 'Ravager'. The pair a member plays is the useful
// identity — "Healer" alone doesn't tell an officer whether they can cover a
// bar.
//
// weaponClasses.json keys each pair in ONE order ('DaggerWand'), and nothing
// stops the other order being stored: the party builder writes whichever way
// round the member picked them. So every key is also indexed by its two
// weapons sorted, and a lookup is normalised the same way. Without this,
// 'WandDagger' silently falls through and the column shows a raw camel-case
// string that looks like a bug because it is one.
const WEAPONS = ['Greatsword', 'Crossbow', 'Longbow', 'Gauntlet', 'Dagger', 'Spear', 'Staff', 'Wand', 'SnS', 'Orb'];

// Longest first so 'S' prefixes can't shadow each other (Staff/Spear/SnS).
const BY_LENGTH = [...WEAPONS].sort((a, b) => b.length - a.length);
const splitPair = (key) => {
  const first = BY_LENGTH.find((w) => key.startsWith(w));
  if (!first) return null;
  const rest = key.slice(first.length);
  return WEAPONS.includes(rest) ? [first, rest] : null;
};
const signature = (key) => {
  const pair = splitPair(key);
  return pair ? pair.slice().sort().join('|') : null;
};

const CLASS_BY_SIGNATURE = new Map();
Object.entries(WEAPON_CLASSES).forEach(([key, name]) => {
  const sig = signature(key);
  if (sig && !CLASS_BY_SIGNATURE.has(sig)) CLASS_BY_SIGNATURE.set(sig, name);
});

const classNameOf = (classes) => {
  const first = Array.isArray(classes) ? classes.find(Boolean) : null;
  if (!first) return null;
  const key = String(first);
  // Falls back to the raw pair rather than to nothing: an unrecognised
  // combination is still more use to an officer than a blank cell.
  return WEAPON_CLASSES[key] || CLASS_BY_SIGNATURE.get(signature(key)) || key;
};

// The statuses a row can carry, in the order an officer reads them. `attended`
// first because it is the record; the rest are exceptions, ranked by how much
// they ask of whoever is looking.
const STATUS_RANK = { attended: 0, pending: 1, noshow_signed: 2, loa: 3, denied: 4 };

module.exports = function createEventDetail(supabase, deps) {
  const { identities, loa, signups, lateAttendance, listMembers } = deps || {};
  const dbFor = (guild) => tenantDb(supabase, guild.id);

  // discord_id -> { role, class_name }, for the Role column.
  async function rolesFor(guild) {
    const { data, error } = await dbFor(guild)
      .from('member_roles').select('discord_id, pvp_role, pve_role, pvp_classes, pve_classes');
    if (error) { console.error('eventDetail.rolesFor error:', error.message); return new Map(); }
    const map = new Map();
    (data || []).forEach((r) => {
      map.set(String(r.discord_id), {
        // PvP first: these are war nights. PvE is the fallback for a member who
        // has only ever filled one in.
        role: r.pvp_role || r.pve_role || null,
        class_name: classNameOf(r.pvp_classes) || classNameOf(r.pve_classes),
      });
    });
    return map;
  }

  return {
    // `officer` widens what is returned, never what is computed.
    // `viewerId` is whose "can I still ask about this" answer travels back.
    async detail(guild, eventId, { viewerId = null, officer = false } = {}) {
      const db = dbFor(guild);

      const { data: event, error: eErr } = await db
        .from('events').select('*').eq('id', eventId).maybeSingle();
      if (eErr) { console.error('eventDetail: event load failed:', eErr.message); throw httpError(500, 'Failed to load that event.'); }
      if (!event) throw httpError(404, 'Event not found.');

      const { data: attendees, error: aErr } = await db
        .from('event_attendance').select('*').eq('event_id', eventId).order('display_name');
      if (aErr) { console.error('eventDetail: attendance load failed:', aErr.message); throw httpError(500, 'Failed to load attendees.'); }

      // Everything else is best-effort and independently so. A night whose
      // Discord roster can't be fetched should still show who attended; the
      // absent half simply isn't knowable without the member list.
      const [roster, ids, memberRoles, schedule] = await Promise.all([
        listMembers ? listMembers(guild).catch((err) => { console.error('eventDetail: member list failed:', err.message); return null; }) : null,
        identities ? identities.load(guild.id).catch(() => null) : null,
        rolesFor(guild),
        event.event_schedule_id
          ? db.from('event_schedule').select('name, event_time').eq('id', event.event_schedule_id).maybeSingle().then((r) => r.data).catch(() => null)
          : null,
      ]);

      const [unavailable, signupView, lateRequests] = await Promise.all([
        event.event_date && loa
          ? loa.unavailableOn(guild, { date: event.event_date, eventScheduleId: event.event_schedule_id || null })
            .catch((err) => { console.error('eventDetail: LOA lookup failed:', err.message); return []; })
          : Promise.resolve([]),
        event.event_date && signups
          ? signups.forOccasion(guild, { date: event.event_date, eventScheduleId: event.event_schedule_id || null })
            .catch((err) => { console.error('eventDetail: signup lookup failed:', err.message); return null; })
          : Promise.resolve(null),
        lateAttendance
          ? lateAttendance.list(guild, { status: 'all', eventId })
            .catch((err) => { console.error('eventDetail: late request lookup failed:', err.message); return []; })
          : Promise.resolve([]),
      ]);

      const nameOf = (id, fallback) => (ids ? ids.displayNameFor(id, fallback) : fallback) || fallback || 'Unknown';
      const avatarOf = new Map((roster || []).map((m) => [String(m.id), m.avatar || null]));
      const present = new Map((attendees || []).map((a) => [String(a.discord_id), a]));
      const excusedBy = new Map((unavailable || []).map((u) => [String(u.discord_id), u]));
      const signedUp = new Map(((signupView && signupView.going) || []).map((e) => [String(e.discord_id), e]));
      // Newest first from lateAttendance.list, so the first hit per member is
      // their most recent word on this night.
      const requestBy = new Map();
      (lateRequests || []).forEach((r) => { if (!requestBy.has(String(r.discord_id))) requestBy.set(String(r.discord_id), r); });

      // The population the table covers: the Discord roster when we have it,
      // widened by anyone who has a record for this night regardless. Someone
      // who attended and has since left the server still attended, and dropping
      // them would quietly rewrite the night.
      const everyone = new Map();
      (roster || []).forEach((m) => everyone.set(String(m.id), nameOf(m.id, m.name)));
      (attendees || []).forEach((a) => { if (!everyone.has(String(a.discord_id))) everyone.set(String(a.discord_id), nameOf(a.discord_id, a.display_name)); });
      signedUp.forEach((e, id) => { if (!everyone.has(id)) everyone.set(id, nameOf(id, e.display_name)); });
      requestBy.forEach((r, id) => { if (!everyone.has(id)) everyone.set(id, nameOf(id, r.display_name)); });

      const rows = [];
      const noReply = [];

      for (const [discordId, displayName] of everyone) {
        const att = present.get(discordId) || null;
        const req = requestBy.get(discordId) || null;
        const loaEntry = excusedBy.get(discordId) || null;
        const entry = signedUp.get(discordId) || null;
        const roleInfo = memberRoles.get(discordId) || { role: null, class_name: null };

        const base = {
          discord_id: discordId,
          display_name: displayName,
          avatar: avatarOf.get(discordId) || null,
          role: roleInfo.role,
          class_name: roleInfo.class_name,
          signed_up_at: entry ? entry.joined_at : null,
        };

        let status = null;
        let lastUpdated = null;
        let note = null;

        if (att) {
          status = 'attended';
          lastUpdated = att.joined_at;
          // The reason a late-added row exists is worth carrying: it is the
          // only explanation for a timestamp an hour after everyone else's.
          if (req && req.status === 'approved') note = req.reason || null;
        } else if (req && req.status === 'pending') {
          status = 'pending';
          lastUpdated = req.requested_at;
          note = req.reason || null;
        } else if (entry) {
          // Said they were coming and wasn't in the channel. Ranked above the
          // LOA bucket because it is a stronger signal — someone who never
          // answered may not have seen the post, where someone who clicked
          // "I'm in" made a commitment. Their LOA, if they filed one
          // afterwards, travels with the row as mitigation.
          status = 'noshow_signed';
          lastUpdated = (req && req.decided_at) || entry.joined_at;
          note = (req && req.reason) || (loaEntry && loaEntry.reason) || null;
        } else if (loaEntry) {
          status = 'loa';
          // loa.unavailableOn() rolls several entries into one and returns only
          // the fields that decide availability — there is no timestamp on it
          // to report, and inventing the event date here would read as "they
          // filed on the night", which is usually the opposite of the truth.
          lastUpdated = null;
          note = loaEntry.reason || null;
        } else if (req && req.status === 'denied') {
          // Asked, was turned down, and had no other standing. Kept in the main
          // table rather than dropped into No Reply: they did reply.
          status = 'denied';
          lastUpdated = req.decided_at;
          note = req.reason || null;
        }

        if (!status) {
          // Never signed up, never turned up, never filed. The second table.
          noReply.push({ ...base, status: 'no_reply' });
          continue;
        }

        rows.push({
          ...base,
          status,
          last_updated: lastUpdated,
          // Redaction, not omission of a computed fact — see the header.
          note: officer ? note : null,
          decided_by: officer && req ? req.decided_by || null : null,
          request_id: req && req.status === 'pending' ? req.id : null,
          late: !!att && att.source === 'late',
          walk_in: !!att && !entry,
        });
      }

      const byName = (a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''));
      rows.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || byName(a, b));
      noReply.sort(byName);

      // The party this night ran with, read off the event and never re-fetched
      // from `rosters` — the whole point of the frozen copy is that editing the
      // saved roster afterwards leaves this untouched.
      let party = null;
      if (event.party_layout) {
        const groups = Array.isArray(event.party_layout.parties) ? event.party_layout.parties : [];
        party = {
          roster_id: event.roster_id || null,
          name: event.party_layout.name || null,
          parties: groups
            .filter((p) => (p.members || []).length > 0)
            .map((p) => ({
              name: p.name || 'Party',
              members: (p.members || []).map((m) => ({ ...m, attended: present.has(String(m.id)) })),
            })),
        };
      }

      // What the viewer can do about their own standing, resolved here so the
      // page and the write route can never disagree about whether the window is
      // open. Mirrors lateAttendance.listForMember's rule exactly.
      let viewer = null;
      if (viewerId) {
        const mine = present.get(String(viewerId)) || null;
        const myReq = requestBy.get(String(viewerId)) || null;
        const closesAt = new Date(new Date(event.created_at).getTime() + (lateAttendance ? lateAttendance.WINDOW_HOURS : 24) * 3_600_000);
        const open = closesAt.getTime() > Date.now();
        viewer = {
          attended: !!mine,
          request: myReq ? { id: myReq.id, status: myReq.status, requested_at: myReq.requested_at } : null,
          window_closes_at: closesAt.toISOString(),
          can_request: open && !mine && !(myReq && myReq.status === 'pending'),
        };
      }

      return {
        event: {
          ...event,
          schedule_name: schedule ? schedule.name : null,
          event_time: schedule ? schedule.event_time : null,
        },
        rows,
        no_reply: noReply,
        party,
        viewer,
        signup: signupView ? {
          id: signupView.id,
          title: signupView.title,
          capacity: signupView.capacity,
          counts: signupView.counts,
          composition: signupView.composition,
        } : null,
        counts: {
          attended: rows.filter((r) => r.status === 'attended').length,
          pending: rows.filter((r) => r.status === 'pending').length,
          noshow_signed: rows.filter((r) => r.status === 'noshow_signed').length,
          loa: rows.filter((r) => r.status === 'loa').length,
          no_reply: noReply.length,
          roster: everyone.size,
        },
      };
    },
  };
};
