// backend/wargameFills.js — the wargame fill pool (merc.guild-hall.gg).
//
// Players list themselves as available to fill for other guilds' wargames;
// guild leaders post a request and invite players from the pool; a slot is
// filled only when the player accepts. See migrations/saas_009 for the schema
// and why every table here is global rather than guild-scoped.
//
// WHO MAY DO WHAT — every rule is enforced here, because the tables have no
// tenant to scope them by:
//
//   · anyone signed in keeps their own fill profile and answers their own
//     invites. That includes people in no Guild Hall guild at all: on the merc
//     host, login issues a session with an empty guild list (see auth.js).
//   · a LEADER posts requests and browses the pool. A leader is either an
//     officer of a Guild Hall guild holding `fills` (admin roles hold it
//     automatically), or someone with a leader claim that staff have not
//     rejected. A pending claim may post; players see "Unverified leader".
//   · a request is managed by whoever posted it, or — for a Guild Hall guild —
//     by any of that guild's officers holding `fills`.
//   · Guild Hall staff decide leader claims.
//
// THE POOL NEVER SHOWS A PLAYER TO THE WRONG SIDE. A leader browsing for a
// wargame against guild X does not see players whose home guild is X or X's
// ally, players who said they won't fill against X, or members of the leader's
// own guild. Those players are not returned at all — only a count per reason —
// so the pool can't be used to scout who plays for the other side.
'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { tenantDb } = require('./tenantDb');
const sites = require('./sites');

const ROLES = ['Tank', 'DPS', 'Healer'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_SLOTS_PER_ROLE = 30;
const MAX_WINDOWS = 21;
const MAX_AVOID = 25;
// A request's page stays readable for a while after the wargame starts, so a
// leader can see who turned up; after that it drops out of every list.
const KEEP_AFTER_START_MS = 12 * 60 * 60 * 1000;
const MAX_LEAD_MS = 60 * 24 * 60 * 60 * 1000;

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// ── Pure helpers (exported for tests) ───────────────────────────────────────

function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Weekday (0 = Sunday) and minute-of-day of an instant, as seen in `tz`.
function localParts(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { d: WEEKDAYS.indexOf(parts.weekday), m: Number(parts.hour) * 60 + Number(parts.minute) };
}

// Is the whole wargame inside one of the player's windows? Windows are written
// in the player's own timezone, so the request's start is converted into that
// zone first — a leader in Brazil and a player in California read the same
// instant differently, and only the player's reading matches their windows.
// A wargame running past midnight counts as covered by a window that runs to
// the end of the day; windows never span midnight themselves.
function isAvailable(profile, startsAt, durationMin) {
  const tz = validTimezone(profile.timezone) ? profile.timezone : 'UTC';
  const start = localParts(new Date(startsAt), tz);
  const end = Math.min(start.m + (durationMin || 0), 24 * 60 - 1);
  return (profile.windows || []).some((w) => w.d === start.d
    && toMinutes(w.from) <= start.m && toMinutes(w.to) >= end);
}

// Why this player must not be shown for this request, or null. `partnerOf` maps
// a threat-board guild id to its ally's id.
function conflictFor(profile, request, partnerOf) {
  const opp = request.opponent_id;
  const home = profile.home_guild_id;
  if (request.guild_id && (profile.gh_guild_ids || []).includes(request.guild_id)) return 'own';
  if (request.claim_guild_id && home && home === request.claim_guild_id) return 'own';
  if (opp && home && home === opp) return 'opponent';
  if (opp && home && partnerOf[opp] === home) return 'ally';
  if (opp && (profile.avoid_guild_ids || []).includes(opp)) return 'avoid';
  return null;
}

function overlaps(a, b) {
  const s1 = new Date(a.starts_at).getTime();
  const s2 = new Date(b.starts_at).getTime();
  const e1 = s1 + a.duration_min * 60000;
  const e2 = s2 + b.duration_min * 60000;
  return s1 < e2 && s2 < e1;
}

function cleanSlots(slots) {
  const out = {};
  let total = 0;
  for (const role of ROLES) {
    const n = Number.parseInt(slots && slots[role], 10) || 0;
    if (n < 0 || n > MAX_SLOTS_PER_ROLE) throw new Error(`${role} slots must be between 0 and ${MAX_SLOTS_PER_ROLE}.`);
    out[role] = n;
    total += n;
  }
  if (!total) throw new Error('A request needs at least one slot.');
  return out;
}

// Validate a profile body into a row. `knownGuild` answers whether an id is on
// the threat board. Throws with a sentence the page can show as-is.
function cleanProfile(body, knownGuild) {
  const b = body || {};
  if (!ROLES.includes(b.role)) throw new Error('Pick a role: Tank, DPS or Healer.');

  const classes = [...new Set((Array.isArray(b.classes) ? b.classes : [])
    .map((c) => String(c || '').trim()).filter(Boolean))];
  if (classes.length > 3) throw new Error('List at most three classes.');
  if (classes.some((c) => c.length > 40)) throw new Error('That class name is too long.');

  let gear = null;
  if (b.gear !== null && b.gear !== undefined && b.gear !== '') {
    gear = Number.parseInt(b.gear, 10);
    if (!Number.isFinite(gear) || gear < 0 || gear > 100000) throw new Error('Gear must be a number from 0 to 100000.');
  }

  const timezone = String(b.timezone || '');
  if (!validTimezone(timezone)) throw new Error('Pick a valid timezone.');

  const windows = Array.isArray(b.windows) ? b.windows : [];
  if (windows.length > MAX_WINDOWS) throw new Error(`At most ${MAX_WINDOWS} time windows.`);
  const cleanWindows = windows.map((w) => {
    const d = Number.parseInt(w && w.d, 10);
    if (!(d >= 0 && d <= 6)) throw new Error('A time window has no valid day.');
    if (!HHMM.test(w.from || '') || !HHMM.test(w.to || '')) throw new Error('Times must be HH:MM.');
    if (toMinutes(w.from) >= toMinutes(w.to)) throw new Error(`${WEEKDAYS[d]} ${w.from}–${w.to} ends before it starts.`);
    return { d, from: w.from, to: w.to };
  });

  const home = b.home_guild_id || null;
  if (home && (!UUID.test(home) || !knownGuild(home))) throw new Error('That home guild is not on the threat board.');

  const avoid = [...new Set((Array.isArray(b.avoid_guild_ids) ? b.avoid_guild_ids : []).filter(Boolean))];
  if (avoid.length > MAX_AVOID) throw new Error(`At most ${MAX_AVOID} guilds on your "won't fill against" list.`);
  if (avoid.some((id) => !UUID.test(id) || !knownGuild(id))) throw new Error('One of those guilds is not on the threat board.');

  const notes = b.notes ? String(b.notes).trim().slice(0, 300) : null;

  return {
    active: b.active !== false,
    role: b.role,
    classes,
    gear,
    timezone,
    windows: cleanWindows,
    home_guild_id: home,
    avoid_guild_ids: avoid,
    notes,
  };
}

// Whether a profile can be found by leaders: the player's own Listed switch is
// on, and staff haven't paused it (migrations/saas_010). Only staff can lift a
// staff pause, whatever the player does with their own switch.
function inPool(profile) {
  return !!profile && profile.active === true && profile.staff_paused !== true;
}

// Answers per status for each player, from a list of invite rows.
function inviteStats(rows) {
  const out = new Map();
  for (const i of rows || []) {
    const s = out.get(i.discord_id) || { invited: 0, accepted: 0, declined: 0, withdrawn: 0, missed: 0 };
    if (i.status in s) s[i.status] += 1;
    out.set(i.discord_id, s);
  }
  return out;
}

// The Guild Hall guilds this session may post fill requests for.
function leaderGuilds(user) {
  return (Array.isArray(user && user.guilds) ? user.guilds : [])
    .filter((m) => m.fullAccess || (Array.isArray(m.permissions) && m.permissions.includes('fills')));
}

const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// ── Module ──────────────────────────────────────────────────────────────────

module.exports = function createWargameFills(supabase, { requireAuth, threatBoard, notify = async () => false }) {
  const profiles = () => supabase.from('fill_profiles');
  const claims = () => supabase.from('fill_leader_claims');
  const requests = () => supabase.from('fill_requests');
  const invites = () => supabase.from('fill_invites');

  const router = express.Router();
  router.use(requireAuth);

  const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 150,
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many changes in a short time — wait a few minutes and try again.' },
  });
  router.use((req, res, next) => (req.method === 'GET' ? next() : writeLimiter(req, res, next)));

  // The threat board, reduced to what this feature needs: names and ratings by
  // id, and the alliance map. Read per request — it changes when staff edit it,
  // and one read is cheap next to the rest of any route here.
  async function boardIndex() {
    const [board, allies] = await Promise.all([threatBoard.board(), threatBoard.allies()]);
    const byId = new Map(board.guilds.map((g) => [g.id, g]));
    return {
      stale: !!board.stale,
      byId,
      partnerOf: allies || {},
      known: (id) => byId.has(id),
      brief: (id) => {
        const g = id && byId.get(id);
        return g ? { id: g.id, name: g.name, status: g.status, cluster: g.cluster } : null;
      },
    };
  }

  async function claimOf(discordId) {
    const { data, error } = await claims().select('*').eq('discord_id', discordId).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  // What this session may do as a leader.
  async function leaderContext(user) {
    const guilds = leaderGuilds(user);
    const claim = await claimOf(user.id);
    return {
      guilds,
      claim,
      canLead: guilds.length > 0 || !!(claim && claim.status !== 'rejected'),
    };
  }

  function canManage(user, leader, request) {
    if (request.leader_id === user.id) return true;
    return !!request.guild_id && leader.guilds.some((g) => g.guild_id === request.guild_id);
  }

  // Verified = posted for a Guild Hall guild (the poster held `fills` there,
  // which was checked at posting), or posted under a claim staff approved.
  async function verifiedLeaders(list) {
    const outside = [...new Set(list.filter((r) => !r.guild_id).map((r) => r.leader_id))];
    const approved = new Set();
    if (outside.length) {
      const { data } = await claims().select('discord_id, status').in('discord_id', outside);
      (data || []).forEach((c) => { if (c.status === 'approved') approved.add(c.discord_id); });
    }
    return (r) => (r.guild_id ? true : approved.has(r.leader_id));
  }

  // Accepted count per role for each request.
  async function filledCounts(requestIds) {
    const out = {};
    if (!requestIds.length) return out;
    const { data } = await invites().select('request_id, role, status').in('request_id', requestIds).eq('status', 'accepted');
    (data || []).forEach((i) => {
      out[i.request_id] = out[i.request_id] || { Tank: 0, DPS: 0, Healer: 0 };
      out[i.request_id][i.role] += 1;
    });
    return out;
  }

  function publicRequest(r, idx, isVerified, filled) {
    return {
      id: r.id,
      guild_label: r.guild_label,
      from_guild_hall: !!r.guild_id,
      guild_id: r.guild_id,
      leader_id: r.leader_id,
      leader_name: r.leader_name,
      verified: isVerified(r),
      opponent: idx.brief(r.opponent_id),
      starts_at: r.starts_at,
      duration_min: r.duration_min,
      slots: r.slots,
      filled: filled[r.id] || { Tank: 0, DPS: 0, Healer: 0 },
      notes: r.notes,
      status: r.status,
    };
  }

  async function loadRequest(id) {
    if (!UUID.test(id || '')) return null;
    const { data, error } = await requests().select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  const fail = (res, e, fallback) => res.status(400).json({ error: e.message || fallback });
  const opponentName = (idx, r) => idx.brief(r.opponent_id)?.name || 'an unknown guild';

  // Every row of a query, a page at a time. PostgREST caps a single response
  // (1000 rows on Supabase by default) and says nothing when it does — a pool
  // read with .limit(2000) would silently stop at the thousandth player. The
  // query passed in must be ordered, or pages can overlap and skip rows.
  async function readAll(make, pageSize = 1000, cap = 50000) {
    const out = [];
    for (let from = 0; from < cap; from += pageSize) {
      const { data, error } = await make().range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return out;
  }

  // A profile as its owner sees it: everything except which staff member
  // paused it. The reason is theirs to read; the name is not.
  const ownView = (p) => {
    if (!p) return null;
    const { staff_paused_by: _by, ...rest } = p;
    return rest;
  };

  // ── Me ───────────────────────────────────────────────────────────────────
  // Everything the fills pages need to decide what to show: the profile (or a
  // starting point drawn from Guild Hall data), leader standing, staff flag.
  router.get('/me', async (req, res) => {
    try {
      const [{ data: profile, error }, leader, idx] = await Promise.all([
        profiles().select('*').eq('discord_id', req.user.id).maybeSingle(),
        leaderContext(req.user),
        boardIndex(),
      ]);
      if (error) throw new Error(error.message);
      res.json({
        user: { id: req.user.id, username: req.user.username, avatar: req.user.avatar },
        profile: ownView(profile),
        suggestion: profile ? null : await suggestFromGuildHall(req.user),
        guildHall: (req.user.guilds || []).map((g) => ({ guild_id: g.guild_id, house: g.house, tag: g.tag })),
        leader: {
          canLead: leader.canLead,
          guilds: leader.guilds.map((g) => ({ guild_id: g.guild_id, house: g.house, tag: g.tag })),
          claim: leader.claim ? { ...leader.claim, guild: idx.brief(leader.claim.threat_guild_id) } : null,
        },
        staff: !!req.user.staff,
        mercUrl: sites.mercUrl('/'),
      });
    } catch (e) {
      console.error('fills /me:', e.message);
      res.status(500).json({ error: 'Could not load your fill profile.' });
    }
  });

  // A first profile for a Guild Hall member, from what their guild already
  // knows: PvP role and classes from Classes, average gear level from Gear
  // Level. Only a suggestion — the member still saves it themselves.
  async function suggestFromGuildHall(user) {
    for (const m of user.guilds || []) {
      const db = tenantDb(supabase, m.guild_id);
      const [{ data: roles }, { data: gear }] = await Promise.all([
        db.from('member_roles').select('pvp_role, pvp_classes').eq('discord_id', user.id).maybeSingle(),
        db.from('gear_levels').select('average').eq('discord_id', user.id).maybeSingle(),
      ]);
      if (!roles && !gear) continue;
      return {
        from: m.house,
        role: ROLES.includes(roles?.pvp_role) ? roles.pvp_role : null,
        classes: Array.isArray(roles?.pvp_classes) ? roles.pvp_classes.filter(Boolean).slice(0, 3) : [],
        gear: gear?.average || null,
      };
    }
    return null;
  }

  router.put('/me', async (req, res) => {
    try {
      const idx = await boardIndex();
      const row = cleanProfile(req.body, idx.known);
      const { data, error } = await profiles().upsert({
        ...row,
        discord_id: req.user.id,
        username: req.user.username || 'Player',
        avatar: req.user.avatar || null,
        // From the signed session, never the body: this is what keeps a guild's
        // own members out of its pool, so it can't be something a client sets.
        gh_guild_ids: (req.user.guilds || []).map((g) => g.guild_id),
        updated_at: new Date().toISOString(),
      }).select().single();
      if (error) throw new Error(error.message);
      res.json({ profile: ownView(data) });
    } catch (e) {
      fail(res, e, 'Could not save your profile.');
    }
  });

  // ── Invites (the player's side) ──────────────────────────────────────────
  router.get('/invites', async (req, res) => {
    try {
      const { data: mine, error } = await invites().select('*').eq('discord_id', req.user.id)
        .order('invited_at', { ascending: false }).limit(200);
      if (error) throw new Error(error.message);
      const ids = [...new Set((mine || []).map((i) => i.request_id))];
      if (!ids.length) return res.json({ invites: [] });

      const since = new Date(Date.now() - KEEP_AFTER_START_MS).toISOString();
      const { data: reqs } = await requests().select('*').in('id', ids).gte('starts_at', since);
      const byId = new Map((reqs || []).map((r) => [r.id, r]));
      const [idx, isVerified, filled] = await Promise.all([
        boardIndex(), verifiedLeaders(reqs || []), filledCounts([...byId.keys()]),
      ]);

      // Clashes: other wargames this player has already said yes to.
      const accepted = (mine || []).filter((i) => i.status === 'accepted' && byId.has(i.request_id))
        .map((i) => byId.get(i.request_id));

      const list = (mine || []).filter((i) => byId.has(i.request_id)).map((i) => {
        const r = byId.get(i.request_id);
        const clashes = i.status === 'invited'
          ? accepted.filter((o) => o.id !== r.id && o.status === 'open' && overlaps(o, r))
            .map((o) => ({ guild_label: o.guild_label, opponent: opponentName(idx, o), starts_at: o.starts_at }))
          : [];
        return {
          id: i.id,
          role: i.role,
          status: r.status === 'cancelled' && i.status !== 'declined' ? 'cancelled' : i.status,
          invited_at: i.invited_at,
          request: publicRequest(r, idx, isVerified, filled),
          clashes,
        };
      });
      res.json({ invites: list });
    } catch (e) {
      console.error('fills /invites:', e.message);
      res.status(500).json({ error: 'Could not load your invites.' });
    }
  });

  router.post('/invites/:id/accept', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Invite not found.' });
    try {
      const { data, error } = await supabase.rpc('fill_accept_invite', {
        p_invite_id: req.params.id, p_discord_id: req.user.id,
      });
      if (error) throw new Error(error.message);
      const result = Array.isArray(data) ? data[0]?.result : data?.result;
      const messages = {
        filled: 'That slot filled before you answered.',
        closed: 'That wargame has been cancelled or has already started.',
        not_pending: 'You already answered that invite.',
        not_found: 'Invite not found.',
      };
      if (result !== 'ok') return res.status(result === 'not_found' ? 404 : 409).json({ error: messages[result] || 'Could not accept.', result });

      tellLeader(req.params.id, req.user, 'accepted');
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, 'Could not accept the invite.');
    }
  });

  router.post('/invites/:id/decline', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Invite not found.' });
    try {
      const { data, error } = await invites()
        .update({ status: 'declined', responded_at: new Date().toISOString() })
        .eq('id', req.params.id).eq('discord_id', req.user.id).in('status', ['invited', 'accepted'])
        .select();
      if (error) throw new Error(error.message);
      if (!data?.length) return res.status(409).json({ error: 'That invite is no longer open.' });
      tellLeader(req.params.id, req.user, 'declined');
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, 'Could not decline the invite.');
    }
  });

  // Best-effort DM to whoever posted the request. Never awaited by the route:
  // the answer is saved either way, and a closed DM is not an error.
  async function tellLeader(inviteId, player, verb) {
    try {
      const { data: inv } = await invites().select('request_id, role').eq('id', inviteId).maybeSingle();
      const r = inv && await loadRequest(inv.request_id);
      if (!r) return;
      const idx = await boardIndex();
      const mark = verb === 'accepted' ? '✅' : '❌';
      await notify(r.leader_id, `${mark} **${player.username || 'A player'}** ${verb} your **${inv.role}** fill slot `
        + `vs **${opponentName(idx, r)}** (<t:${unix(r.starts_at)}:f>).`);
    } catch (e) {
      console.error('fills leader DM:', e.message);
    }
  }

  // ── Requests (the leader's side) ─────────────────────────────────────────
  router.get('/requests', async (req, res) => {
    try {
      const leader = await leaderContext(req.user);
      if (!leader.canLead) return res.json({ requests: [], canLead: false });
      const since = new Date(Date.now() - KEEP_AFTER_START_MS).toISOString();
      // Two reads merged rather than one .or(): the ids would otherwise be
      // interpolated into a filter string.
      const guildIds = leader.guilds.map((g) => g.guild_id);
      const [own, shared] = await Promise.all([
        requests().select('*').eq('leader_id', req.user.id).gte('starts_at', since),
        guildIds.length
          ? requests().select('*').in('guild_id', guildIds).gte('starts_at', since)
          : Promise.resolve({ data: [] }),
      ]);
      const byId = new Map([...(own.data || []), ...(shared.data || [])].map((r) => [r.id, r]));
      const list = [...byId.values()].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
      const [idx, isVerified, filled] = await Promise.all([
        boardIndex(), verifiedLeaders(list), filledCounts(list.map((r) => r.id)),
      ]);
      res.json({ canLead: true, requests: list.map((r) => publicRequest(r, idx, isVerified, filled)) });
    } catch (e) {
      console.error('fills /requests:', e.message);
      res.status(500).json({ error: 'Could not load your fill requests.' });
    }
  });

  router.post('/requests', async (req, res) => {
    try {
      const b = req.body || {};
      const leader = await leaderContext(req.user);
      const idx = await boardIndex();
      if (idx.stale) return res.status(503).json({ error: 'The threat board is unavailable right now, so opponents can\'t be checked. Try again shortly.' });

      const row = {
        leader_id: req.user.id,
        leader_name: req.user.username || 'Leader',
      };
      if (b.guild_id) {
        const m = leader.guilds.find((g) => g.guild_id === b.guild_id);
        if (!m) return res.status(403).json({ error: 'You can\'t post fill requests for that guild.' });
        row.guild_id = m.guild_id;
        row.guild_label = m.house;
      } else {
        const c = leader.claim;
        if (!c || c.status === 'rejected') {
          return res.status(403).json({ error: 'Tell us which guild you lead before posting a fill request.' });
        }
        row.claim_guild_id = c.threat_guild_id;
        row.guild_label = idx.brief(c.threat_guild_id)?.name || 'Unknown guild';
      }

      if (!UUID.test(b.opponent_id || '') || !idx.known(b.opponent_id)) throw new Error('Pick an opponent from the threat board.');
      if (b.opponent_id === row.claim_guild_id) throw new Error('A guild can\'t wargame itself.');
      row.opponent_id = b.opponent_id;

      const starts = new Date(b.starts_at);
      if (Number.isNaN(starts.getTime())) throw new Error('Pick a start date and time.');
      if (starts.getTime() <= Date.now()) throw new Error('That start time has already passed.');
      if (starts.getTime() - Date.now() > MAX_LEAD_MS) throw new Error('Fill requests can be posted up to 60 days ahead.');
      row.starts_at = starts.toISOString();

      const duration = Number.parseInt(b.duration_min, 10) || 60;
      if (duration < 15 || duration > 360) throw new Error('Length must be between 15 minutes and 6 hours.');
      row.duration_min = duration;
      row.slots = cleanSlots(b.slots);
      row.notes = b.notes ? String(b.notes).trim().slice(0, 500) : null;

      const { data, error } = await requests().insert(row).select().single();
      if (error) throw new Error(error.message);
      res.status(201).json({ request: data });
    } catch (e) {
      fail(res, e, 'Could not create the request.');
    }
  });

  // One request, its invites, and the pool — already filtered for conflicts.
  router.get('/requests/:id', async (req, res) => {
    try {
      const r = await loadRequest(req.params.id);
      if (!r) return res.status(404).json({ error: 'Request not found.' });
      const leader = await leaderContext(req.user);
      if (!canManage(req.user, leader, r)) return res.status(403).json({ error: 'That request belongs to another guild.' });

      const [idx, isVerified, { data: invs }, pool] = await Promise.all([
        boardIndex(),
        verifiedLeaders([r]),
        invites().select('*').eq('request_id', r.id),
        readAll(() => profiles().select('*').eq('active', true).eq('staff_paused', false).order('discord_id')),
      ]);
      const filled = await filledCounts([r.id]);
      const inviteOf = new Map((invs || []).map((i) => [i.discord_id, i]));

      // Invitees' names, including anyone who has since paused their profile.
      const ids = [...inviteOf.keys()];
      const { data: invitees } = ids.length
        ? await profiles().select('discord_id, username, avatar').in('discord_id', ids)
        : { data: [] };
      const nameOf = new Map((invitees || []).map((p) => [p.discord_id, p]));

      const hidden = { own: 0, opponent: 0, ally: 0, avoid: 0 };
      const shown = [];
      for (const p of pool || []) {
        if (p.discord_id === req.user.id) continue;
        const why = conflictFor(p, r, idx.partnerOf);
        if (why) { hidden[why] += 1; continue; }
        shown.push({
          discord_id: p.discord_id,
          username: p.username,
          avatar: p.avatar,
          role: p.role,
          classes: p.classes,
          gear: p.gear,
          timezone: p.timezone,
          windows: p.windows,
          notes: p.notes,
          home_guild: idx.brief(p.home_guild_id),
          guild_hall: (p.gh_guild_ids || []).length > 0,
          available: isAvailable(p, r.starts_at, r.duration_min),
          invite: inviteOf.get(p.discord_id)?.status || null,
        });
      }
      shown.sort((a, b) => (b.available - a.available) || ((b.gear || 0) - (a.gear || 0)));

      res.json({
        request: publicRequest(r, idx, isVerified, filled),
        canEdit: r.status === 'open' && new Date(r.starts_at).getTime() > Date.now(),
        invites: (invs || []).map((i) => ({
          discord_id: i.discord_id,
          username: nameOf.get(i.discord_id)?.username || 'Player',
          avatar: nameOf.get(i.discord_id)?.avatar || null,
          role: i.role,
          status: i.status,
        })),
        pool: shown,
        hidden,
      });
    } catch (e) {
      console.error('fills /requests/:id:', e.message);
      res.status(500).json({ error: 'Could not load that request.' });
    }
  });

  // Loads the request and checks it can still be changed by this leader.
  async function editable(req, res) {
    const r = await loadRequest(req.params.id);
    if (!r) { res.status(404).json({ error: 'Request not found.' }); return null; }
    const leader = await leaderContext(req.user);
    if (!canManage(req.user, leader, r)) { res.status(403).json({ error: 'That request belongs to another guild.' }); return null; }
    if (r.status !== 'open') { res.status(409).json({ error: 'That request has been cancelled.' }); return null; }
    if (new Date(r.starts_at).getTime() <= Date.now()) { res.status(409).json({ error: 'That wargame has already started.' }); return null; }
    return r;
  }

  router.delete('/requests/:id', async (req, res) => {
    try {
      const r = await editable(req, res);
      if (!r) return;
      const { error } = await requests().update({ status: 'cancelled' }).eq('id', r.id);
      if (error) throw new Error(error.message);
      res.json({ ok: true });

      const { data: live } = await invites().select('discord_id').eq('request_id', r.id).in('status', ['invited', 'accepted']);
      const idx = await boardIndex();
      for (const i of live || []) {
        notify(i.discord_id, `🚫 **${r.guild_label}** cancelled their wargame vs **${opponentName(idx, r)}** `
          + `(<t:${unix(r.starts_at)}:f>). Your fill slot is released.`);
      }
    } catch (e) {
      if (!res.headersSent) fail(res, e, 'Could not cancel the request.');
    }
  });

  router.post('/requests/:id/invites', async (req, res) => {
    try {
      const r = await editable(req, res);
      if (!r) return;
      const { discord_id: target, role } = req.body || {};
      if (!ROLES.includes(role)) throw new Error('Pick a role for this invite.');
      if (!(r.slots?.[role] > 0)) throw new Error(`This request has no ${role} slots.`);

      const { data: p } = await profiles().select('*').eq('discord_id', String(target || '')).maybeSingle();
      if (!inPool(p)) return res.status(404).json({ error: 'That player is not in the fill pool.' });
      if (p.discord_id === req.user.id) throw new Error('You can\'t invite yourself.');
      const idx = await boardIndex();
      if (conflictFor(p, r, idx.partnerOf)) return res.status(404).json({ error: 'That player is not in the fill pool.' });

      const { data: existing } = await invites().select('*').eq('request_id', r.id).eq('discord_id', p.discord_id).maybeSingle();
      if (existing && ['invited', 'accepted'].includes(existing.status)) {
        return res.status(409).json({ error: `${p.username} is already ${existing.status}.` });
      }
      const fresh = { role, status: 'invited', invited_at: new Date().toISOString(), responded_at: null };
      const { error } = existing
        ? await invites().update(fresh).eq('id', existing.id)
        : await invites().insert({ ...fresh, request_id: r.id, discord_id: p.discord_id });
      if (error) throw new Error(error.message);
      res.status(201).json({ ok: true });

      const isVerified = await verifiedLeaders([r]);
      const link = sites.mercUrl('/invites');
      notify(p.discord_id, [
        `⚔️ **${r.guild_label}** wants you as a **${role}** fill vs **${opponentName(idx, r)}** — `
          + `<t:${unix(r.starts_at)}:F> (<t:${unix(r.starts_at)}:R>).`,
        isVerified(r) ? null : '_Unverified leader: Guild Hall staff have not confirmed they lead this guild yet._',
        link ? `Accept or decline: ${link}` : 'Accept or decline on Guild Hall under Fill invites.',
      ].filter(Boolean).join('\n'));
    } catch (e) {
      if (!res.headersSent) fail(res, e, 'Could not send the invite.');
    }
  });

  router.delete('/requests/:id/invites/:discordId', async (req, res) => {
    try {
      const r = await editable(req, res);
      if (!r) return;
      const { data, error } = await invites().update({ status: 'withdrawn', responded_at: new Date().toISOString() })
        .eq('request_id', r.id).eq('discord_id', req.params.discordId).in('status', ['invited', 'accepted'])
        .select();
      if (error) throw new Error(error.message);
      if (!data?.length) return res.status(409).json({ error: 'There is no open invite to withdraw.' });
      res.json({ ok: true });

      const idx = await boardIndex();
      notify(req.params.discordId, `↩️ **${r.guild_label}** withdrew your fill invite vs **${opponentName(idx, r)}** `
        + `(<t:${unix(r.starts_at)}:f>).`);
    } catch (e) {
      if (!res.headersSent) fail(res, e, 'Could not withdraw the invite.');
    }
  });

  // ── Leader claims ────────────────────────────────────────────────────────
  // For leaders whose guild does not use Guild Hall. See the header.
  router.put('/claim', async (req, res) => {
    try {
      const { threat_guild_id: guildId, proof } = req.body || {};
      const idx = await boardIndex();
      if (!UUID.test(guildId || '') || !idx.known(guildId)) throw new Error('Pick your guild from the threat board.');
      const current = await claimOf(req.user.id);
      if (current && current.status === 'approved' && current.threat_guild_id === guildId) {
        return res.json({ claim: current });
      }
      const { data, error } = await claims().upsert({
        discord_id: req.user.id,
        username: req.user.username || 'Leader',
        threat_guild_id: guildId,
        proof: proof ? String(proof).trim().slice(0, 300) : null,
        // Any change to a claim — a new guild, or a second try after a
        // rejection — goes back to staff.
        status: 'pending',
        decided_by: null,
        decided_at: null,
        updated_at: new Date().toISOString(),
      }).select().single();
      if (error) throw new Error(error.message);
      res.json({ claim: data });
    } catch (e) {
      fail(res, e, 'Could not save your claim.');
    }
  });

  router.delete('/claim', async (req, res) => {
    const { error } = await claims().delete().eq('discord_id', req.user.id);
    if (error) return res.status(500).json({ error: 'Could not remove your claim.' });
    res.json({ ok: true });
  });

  // ── Staff: deciding claims ───────────────────────────────────────────────
  const staffOnly = (req, res, next) => (req.user?.staff
    ? next()
    : res.status(403).json({ error: 'Only Guild Hall staff can do that.' }));

  router.get('/claims', staffOnly, async (req, res) => {
    try {
      const [{ data, error }, idx] = await Promise.all([
        claims().select('*').order('created_at', { ascending: false }).limit(500),
        boardIndex(),
      ]);
      if (error) throw new Error(error.message);
      res.json({ claims: (data || []).map((c) => ({ ...c, guild: idx.brief(c.threat_guild_id) })) });
    } catch (e) {
      console.error('fills /claims:', e.message);
      res.status(500).json({ error: 'Could not load leader claims.' });
    }
  });

  router.post('/claims/:discordId/decision', staffOnly, async (req, res) => {
    try {
      const status = req.body?.status;
      if (!['approved', 'rejected', 'pending'].includes(status)) throw new Error('Unknown decision.');
      const { data, error } = await claims().update({
        status,
        decided_by: status === 'pending' ? null : `${req.user.username || 'staff'} (${req.user.id})`,
        decided_at: status === 'pending' ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('discord_id', req.params.discordId).select().maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return res.status(404).json({ error: 'Claim not found.' });
      res.json({ claim: data });

      if (status !== 'pending') {
        const idx = await boardIndex();
        const guild = idx.brief(data.threat_guild_id)?.name || 'your guild';
        notify(data.discord_id, status === 'approved'
          ? `✅ Guild Hall staff verified you as a leader of **${guild}**. Your fill invites now show as verified.`
          : `Guild Hall staff could not verify you as a leader of **${guild}**. Reply in the Guild Hall Discord if you think that's wrong.`);
      }
    } catch (e) {
      if (!res.headersSent) fail(res, e, 'Could not record the decision.');
    }
  });

  // ── Staff: the whole pool ────────────────────────────────────────────────
  // Every profile, listed or not, with nothing hidden. Leaders only ever see a
  // conflict-filtered slice for one request; staff run the platform and need
  // the full picture to spot trolls, impersonators and repeat no-shows.
  router.get('/staff/pool', staffOnly, async (req, res) => {
    try {
      const [list, invs, idx] = await Promise.all([
        readAll(() => profiles().select('*').order('discord_id')),
        readAll(() => invites().select('id, discord_id, status').order('id')),
        boardIndex(),
      ]);
      const stats = inviteStats(invs);
      const none = { invited: 0, accepted: 0, declined: 0, withdrawn: 0, missed: 0 };
      res.json({
        profiles: list
          .map((p) => ({
            discord_id: p.discord_id,
            username: p.username,
            avatar: p.avatar,
            active: p.active,
            staff_paused: !!p.staff_paused,
            staff_paused_reason: p.staff_paused_reason,
            staff_paused_by: p.staff_paused_by,
            staff_paused_at: p.staff_paused_at,
            in_pool: inPool(p),
            role: p.role,
            classes: p.classes,
            gear: p.gear,
            timezone: p.timezone,
            windows: p.windows,
            notes: p.notes,
            home_guild: idx.brief(p.home_guild_id),
            avoid_guilds: (p.avoid_guild_ids || []).map((id) => idx.brief(id)).filter(Boolean),
            guild_hall: (p.gh_guild_ids || []).length > 0,
            created_at: p.created_at,
            updated_at: p.updated_at,
            stats: stats.get(p.discord_id) || none,
          }))
          .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)),
      });
    } catch (e) {
      console.error('fills /staff/pool:', e.message);
      res.status(500).json({ error: 'Could not load the player pool.' });
    }
  });

  router.post('/staff/pool/:discordId/pause', staffOnly, async (req, res) => {
    try {
      const reason = String(req.body?.reason || '').trim().slice(0, 300);
      if (!reason) throw new Error('Give a reason — the player sees it.');
      const { data, error } = await profiles().update({
        staff_paused: true,
        staff_paused_reason: reason,
        staff_paused_by: `${req.user.username || 'staff'} (${req.user.id})`,
        staff_paused_at: new Date().toISOString(),
      }).eq('discord_id', req.params.discordId).select().maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return res.status(404).json({ error: 'Profile not found.' });
      res.json({ ok: true });
      notify(data.discord_id, `⏸️ Guild Hall staff paused your fill listing: ${reason}\n`
        + 'Leaders can no longer find you in the pool. Invites you already have still work. '
        + 'Ask in the Guild Hall Discord if you think this is a mistake.');
    } catch (e) {
      if (!res.headersSent) fail(res, e, 'Could not pause that listing.');
    }
  });

  router.delete('/staff/pool/:discordId/pause', staffOnly, async (req, res) => {
    try {
      const { data, error } = await profiles().update({
        staff_paused: false, staff_paused_reason: null, staff_paused_by: null, staff_paused_at: null,
      }).eq('discord_id', req.params.discordId).eq('staff_paused', true).select().maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return res.status(409).json({ error: 'That listing is not paused by staff.' });
      res.json({ ok: true });
      notify(data.discord_id, data.active
        ? '▶️ Guild Hall staff lifted the pause on your fill listing. Leaders can find you again.'
        : '▶️ Guild Hall staff lifted the pause on your fill listing. Turn "Listed" back on when you want leaders to find you.');
    } catch (e) {
      if (!res.headersSent) fail(res, e, 'Could not lift the pause.');
    }
  });

  return { router };
};

module.exports.__test = {
  validTimezone, localParts, isAvailable, conflictFor, overlaps, cleanSlots, cleanProfile, leaderGuilds,
  inPool, inviteStats,
};
