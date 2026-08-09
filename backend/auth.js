// backend/auth.js — Discord OAuth2 login, role-gated per guild.
// No bot required: membership and roles are read via the user's own
// `guilds.members.read` scope at GET /users/@me/guilds/{guild}/member.
//
// MULTI-TENANT SESSIONS (plan task 10)
// A session no longer carries one flat set of capabilities. The same person can
// be a loot officer in one house and a plain member in another, so the token
// carries a list:
//
//   { id, username, avatar, verified_at, guilds: [ Membership, … ] }
//   Membership = { guild_id, discord_guild_id, house, tag,
//                  permissions, fullAccess }
//
// Discord role ids are NOT carried: they are consumed at login to resolve
// `permissions` and nothing reads them afterwards, while they were the biggest
// thing in the token. See issueSession() for why the size matters.
//
// Capabilities are then read for the ACTIVE guild only — applyGuildAccess()
// below narrows req.user to one membership once guildContext has resolved which
// guild the request is for. That narrowing is what lets userHas(req.user, …) and
// all its call sites stay exactly as they were: they still ask "does this
// session hold this capability", and the answer is now scoped to one guild.
//
// Merging the lists instead would be a privilege escalation: hold `match` in a
// guild you run and you would inherit it in every guild you have ever joined.
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { fetchMember, botConfigured } = require('./discord');
const perms = require('./permissions');
const guildRegistry = require('./guildRegistry');
// Just the header name — requiring the module's factory would be a cycle.
const { GUILD_HEADER } = require('./guildContext');

// permissions.js already holds a service-key client and exports it; reusing it
// keeps this module free of Supabase config it would otherwise have to duplicate.
const db = perms.supabase;

const router = express.Router();

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  JWT_SECRET,
  APP_URL = '/',
} = process.env;

// Model B (single-guild self-host) pins one tenant; anything else is Model A,
// the shared multi-guild deployment. The difference shows up in exactly two
// places: the OAuth scope we ask for, and how login discovers which guilds to
// evaluate. Everything downstream is the same code path.
const SINGLE_GUILD_ID = process.env.SINGLE_GUILD_ID || null;

// Per-guild role config. The guilds row is the only source: an env fallback
// here handed one tenant's officer roles authority inside another tenant's
// guild, which is the single worst thing this system could get wrong.
//
// An empty allowed_role_ids still means "any member of the server gets in" —
// that is a real configuration choice. An empty admin_role_ids means nobody is
// an officer, which fails closed.
const rolesFrom = (guild, column) => (Array.isArray(guild && guild[column])
  ? guild[column].map(String).filter(Boolean) : []);

const COOKIE_NAME = 'gh_session';
const STATE_COOKIE = 'gh_oauth_state';
const SESSION_DAYS = 7;

// How stale a session may get before we re-check the member against Discord.
// Kicked members / demoted admins lose access within this window instead of
// riding out the full 7-day token. Requires the bot token; without a bot the
// old behavior (no re-checks) is kept, with a warning at boot.
const REVERIFY_MS = (parseInt(process.env.SESSION_REVERIFY_MINUTES, 10) || 60) * 60 * 1000;

// Auth is "configured" only when every required secret is present. If not, the
// app fails closed — data routes return 401 and nothing leaks.
//
// DISCORD_GUILD_ID is deliberately NOT in this list any more. A shared
// deployment has no single guild — it learns them from the registry — so
// requiring it here would have left Model A with login disabled outright and a
// boot warning blaming missing config that mode never has. Which guilds a user
// may enter is decided per login, and resolving none of them just means they
// aren't a member: still fails closed, but for the right reason.
const authConfigured = Boolean(
  DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT_URI && JWT_SECRET
);
if (!authConfigured) {
  console.warn('⚠️  Discord login is not fully configured — all data routes will be locked.');
}
if (authConfigured && !botConfigured) {
  console.warn('⚠️  No bot token — sessions cannot be re-verified against Discord; kicked members keep access until their session expires.');
}

const isProd = process.env.NODE_ENV === 'production';
const baseCookie = { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/' };

// ── Begin login: redirect to Discord with a CSRF state ──────────────────────
router.get('/login', (req, res) => {
  if (!authConfigured) return res.status(503).send('Discord login is not configured.');

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, { ...baseCookie, maxAge: 10 * 60 * 1000 });

  // The `guilds` scope (list the servers you're in) is requested ONLY on the
  // shared deployment, where login has to discover which of the user's servers
  // we host. A single-guild self-host already knows its one guild, so it asks
  // for nothing extra and its consent screen is unchanged.
  const scope = SINGLE_GUILD_ID
    ? 'identify guilds.members.read'
    : 'identify guilds guilds.members.read';

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope,
    state,
    prompt: 'consent',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

// ── OAuth callback: verify, check role, issue session ───────────────────────
// Full path: /api/auth/discord/callback — must match DISCORD_REDIRECT_URI and
// the redirect registered in the Discord developer portal.
router.get('/discord/callback', async (req, res) => {
  if (!authConfigured) return res.status(503).send('Discord login is not configured.');

  const { code, state } = req.query;
  const savedState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, baseCookie);

  if (!code || !state || state !== savedState) {
    // Distinct from a failed exchange: the browser never sent back the state
    // cookie we set at /login, or it didn't match. That is a cookie problem
    // (blocked third-party cookies, a proxy dropping Set-Cookie, mismatched
    // domains between APP_URL and the host actually serving the page), not a
    // Discord problem — and diagnosing it as one wastes hours.
    console.error('Auth callback: OAuth state mismatch.',
      `code=${code ? 'present' : 'MISSING'}`,
      `state=${state ? 'present' : 'MISSING'}`,
      `cookie=${savedState ? 'present' : 'MISSING'}`,
      savedState && state && savedState !== state ? '(both present but different)' : '');
    return res.redirect(`${APP_URL}?auth=state`);
  }

  try {
    // 1. Exchange the code for an access token.
    //
    // validateStatus lets us read Discord's error body instead of axios
    // throwing "Request failed with status code 401" and discarding the one
    // piece of information that says what is actually wrong.
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: DISCORD_REDIRECT_URI,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: (s) => s < 500,
      }
    );

    if (tokenRes.status !== 200 || !tokenRes.data?.access_token) {
      // Discord names the cause precisely here, and each one has a different fix:
      //   invalid_client        -> DISCORD_CLIENT_SECRET is wrong, or belongs to
      //                            a different application than DISCORD_CLIENT_ID
      //   invalid_grant         -> the code was reused/expired, OR
      //                            DISCORD_REDIRECT_URI does not byte-match the
      //                            one registered in the Developer Portal
      //   invalid_request       -> a required parameter is missing
      console.error(
        `Auth callback: token exchange failed (HTTP ${tokenRes.status}).`,
        `discord=${JSON.stringify(tokenRes.data)}`,
        `client_id=${DISCORD_CLIENT_ID}`,
        `redirect_uri=${DISCORD_REDIRECT_URI}`,
      );
      return res.redirect(`${APP_URL}?auth=config`);
    }
    const accessToken = tokenRes.data.access_token;

    // 2. Which guilds we host is this user actually in?
    const hosted = await discoverHostedGuilds(accessToken);
    if (!hosted.length) {
      return res.redirect(`${APP_URL}?auth=not_member`);
    }

    // 3. Read their member object in each, and evaluate roles per guild.
    const { memberships, user } = await buildMemberships(accessToken, hosted);

    // In none of them do their roles clear the bar. Distinct from not_member:
    // they are in the server, they just aren't allowed into the app.
    if (!memberships.length) {
      return res.redirect(`${APP_URL}?auth=forbidden`);
    }

    // 4. Issue a signed session cookie carrying every membership.
    issueSession(res, buildSession(user, memberships));

    res.redirect(APP_URL);
  } catch (err) {
    // Anything unexpected. Include the HTTP status and body when it came from
    // an API call — err.message alone is "Request failed with status code 401",
    // which names neither the endpoint nor the reason.
    const status = err.response?.status;
    const body = err.response?.data;
    console.error('Auth callback error:', err.message,
      status ? `status=${status}` : '',
      body ? `body=${JSON.stringify(body).slice(0, 300)}` : '');
    res.redirect(`${APP_URL}?auth=error`);
  }
});

// ── Who am I? ───────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!authConfigured || !token) return res.status(401).json({ authenticated: false });
  try {
    const user = jwt.verify(token, JWT_SECRET);

    // Which guild's capabilities to report. This route sits outside the
    // guild-resolved chain (everything under /auth bypasses it), so it works
    // out the active guild itself: the pinned one, the header the frontend
    // sends, or the only membership there is. With several guilds and no
    // header, no capabilities are reported until one is chosen — the union
    // would hand a user one guild's powers while they are looking at another.
    const list = Array.isArray(user.guilds) ? user.guilds : [];
    const active = SINGLE_GUILD_ID
      || req.headers[GUILD_HEADER]
      || (list.length === 1 ? list[0].guild_id : null);
    if (active) applyGuildAccess(user, active);
    else if (list.length) { user.permissions = []; user.isAdmin = false; user.fullAccess = false; }

    res.json({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        isAdmin: !!user.isAdmin,
        // Sessions issued before capabilities existed have no permissions array;
        // treat an old admin token as full access until it re-verifies, rather
        // than stripping a working session's access mid-flight.
        permissions: user.permissions || (user.isAdmin ? perms.ALL_PERMISSIONS.map((p) => p.key) : []),
        fullAccess: user.fullAccess ?? !!user.isAdmin,
        activeGuildId: active || null,
        // Enough for a guild switcher, and nothing more — roles and per-guild
        // capabilities stay inside the token.
        guilds: list.map((g) => ({ guild_id: g.guild_id, house: g.house, tag: g.tag })),
      },
    });
  } catch {
    res.status(401).json({ authenticated: false });
  }
});

// ── Logout ──────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, baseCookie);
  res.json({ ok: true });
});

// ── Session helpers ─────────────────────────────────────────────────────────
// Turn a Discord guild-member object into a session payload, or null if their
// roles no longer grant access (empty allow-list = any member passes).
//
// Capabilities are resolved here because this is the one place Discord roles
// become session claims, and it runs on both login and the hourly re-verify —
// so a changed grant reaches an existing session without any extra machinery.
//
// A role in the guild's own admin_role_ids is absolute: it holds every
// capability, including ones added in later releases, and can't be narrowed
// from the permissions page.
// That's the deliberate escape hatch — a mistaken grant can't lock everyone out
// of the site, because whoever holds the env-configured admin role still gets in.
async function evaluateMember(member, guild) {
  const roles = (member?.roles || []).map(String);
  const allowedRoles = rolesFrom(guild, 'allowed_role_ids');
  const allowed = allowedRoles.length === 0 || roles.some((r) => allowedRoles.includes(r));
  if (!allowed) return null;
  const u = member.user || {};

  const adminRoles = rolesFrom(guild, 'admin_role_ids');
  const fullAccess = adminRoles.length > 0 && roles.some((r) => adminRoles.includes(r));
  const granted = fullAccess
    ? perms.ALL_PERMISSIONS.map((p) => p.key)
    // Scoped to this guild: grants are per-tenant rows, and a role id from
    // another Discord server must never match here.
    : await perms.resolveFor({ guildId: guild.id, roleIds: roles, userId: u.id });

  // Deliberately NOT storing `roles`. The Discord role snowflakes were the
  // largest thing in this token — ~410 bytes per guild — and nothing read them:
  // capabilities are resolved right here at login, so by the time a request runs
  // the roles have already done their job. Carrying them took the cookie to 96%
  // of the browser's 4 KB cap at four guilds, and a cookie over that cap is
  // dropped SILENTLY: the member just bounces back to the login page forever
  // with no error anywhere. Dropping them roughly doubles the headroom.
  return {
    guild_id: guild.id,
    discord_guild_id: String(guild.discord_guild_id),
    house: guild.house,
    tag: guild.tag,
    permissions: granted,
    fullAccess,
  };
}

// The Guild Hall tenants this user belongs to.
//
// Single-guild: we already know the one, so no server listing and no extra
// scope — just confirm the tenant row is present and active.
// Shared deployment: ask Discord for the user's servers and keep the hosted
// ones. The registry does the intersection in one query.
async function discoverHostedGuilds(accessToken) {
  if (SINGLE_GUILD_ID) {
    const row = await guildRegistry.resolveById(db, SINGLE_GUILD_ID);
    if (!row) {
      // Misconfiguration, not a rejected user: SINGLE_GUILD_ID names a guild
      // that isn't in the registry or is suspended. Say so loudly — silently
      // treating it as "not a member" would send every operator hunting for a
      // Discord permissions problem that doesn't exist.
      console.error(`SINGLE_GUILD_ID ${SINGLE_GUILD_ID} is not an active guilds row — nobody can log in.`);
      return [];
    }
    return [row];
  }

  const res = await axios.get('https://discord.com/api/users/@me/guilds', {
    headers: { Authorization: `Bearer ${accessToken}` },
    validateStatus: (s) => s < 500,
  });
  if (res.status !== 200) {
    // A 401/403 here almost always means the token lacks the `guilds` scope —
    // i.e. the user authorised before that scope was requested and Discord
    // reused the old grant. Re-consent fixes it; the scope string is logged so
    // it can be compared against what the portal shows.
    console.error(
      `Auth callback: /users/@me/guilds failed (HTTP ${res.status}).`,
      `discord=${JSON.stringify(res.data)}`,
      'requested scope=identify guilds guilds.members.read',
    );
    throw new Error(`guild list fetch failed: ${res.status}`);
  }

  return guildRegistry.resolveManyByDiscordIds(db, (res.data || []).map((g) => g.id));
}

// Fetch the member object in each hosted guild and evaluate it there. Guilds
// whose roles don't clear the bar are dropped, so the session only ever lists
// guilds the user may actually use.
async function buildMemberships(accessToken, hosted) {
  const results = await Promise.all(hosted.map(async (guild) => {
    const res = await axios.get(
      `https://discord.com/api/users/@me/guilds/${guild.discord_guild_id}/member`,
      { headers: { Authorization: `Bearer ${accessToken}` }, validateStatus: (s) => s < 500 },
    );
    // 404 = left the server between the list call and this one. On the shared
    // deployment one guild failing must not fail the whole login, so anything
    // non-200 drops just that guild.
    if (res.status !== 200) {
      if (res.status !== 404) console.warn(`member fetch for guild ${guild.discord_guild_id} got HTTP ${res.status}`);
      return null;
    }
    return { membership: await evaluateMember(res.data, guild), user: res.data.user || {} };
  }));

  const ok = results.filter(Boolean);
  return {
    memberships: ok.map((r) => r.membership).filter(Boolean),
    // Identity is the same across every guild — take it from whichever
    // responded, so a user rejected by every guild's roles still has a name for
    // the log line rather than nothing.
    user: ok.length ? ok[0].user : {},
  };
}

// Assemble the signed token. Capabilities live per-membership, never at the top
// level, so nothing downstream can read a capability without having chosen a
// guild first.
function buildSession(u, memberships) {
  return {
    id: u.id,
    username: u.global_name || u.username || 'Member',
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
    guilds: memberships,
    verified_at: Date.now(),
  };
}

// Narrow a session to one guild's access. Called once the active guild is known
// — from guildContext on API requests, and from /auth/me for the initial page
// load. Mutates the per-request decoded token, never the cookie.
//
// This is the single point where a capability check becomes guild-aware, which
// is why userHas() and its eleven call sites needed no changes at all.
function applyGuildAccess(user, guildId) {
  if (!user) return null;

  // A session issued before task 10 has no guilds array. Leave its top-level
  // permissions alone: it stays valid until its next re-verify re-issues it in
  // the new shape, so deploying this doesn't sign everyone out mid-session.
  if (!Array.isArray(user.guilds)) return user;

  const m = user.guilds.find((g) => g.guild_id === guildId) || null;
  user.permissions = m ? m.permissions : [];
  user.fullAccess = m ? m.fullAccess : false;
  // "Has any admin-area access at all" — what the sidebar's Admin section and
  // the admin-area gate key off. NOT a capability check: anything finer must
  // test permissions, or a loot officer passes as an admin.
  user.isAdmin = !!(m && m.permissions.length > 0);
  return m;
}

// Browsers cap a single cookie at ~4096 bytes INCLUDING its name and every
// attribute, and a cookie over that is discarded without a word — no error, no
// console warning, just a member who can never stay signed in. The people who
// hit it first are officers in the most guilds, which is the worst possible
// group to lose silently. Measure the whole header and complain early.
const COOKIE_LIMIT = 4096;
const COOKIE_WARN_AT = 3400;

function issueSession(res, sessionUser) {
  const sessionToken = jwt.sign(sessionUser, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });

  // Approximates what Express will actually send: name, value, and attributes.
  const headerBytes = COOKIE_NAME.length + 1 + sessionToken.length + 120;
  if (headerBytes >= COOKIE_LIMIT) {
    console.error(
      `SESSION COOKIE TOO LARGE: ${headerBytes} bytes for user ${sessionUser.id} `
      + `across ${(sessionUser.guilds || []).length} guild(s). The browser will DISCARD this `
      + 'cookie and the member will not be able to sign in. Memberships must move server-side.',
    );
  } else if (headerBytes >= COOKIE_WARN_AT) {
    console.warn(
      `Session cookie is ${headerBytes} of ${COOKIE_LIMIT} bytes for user ${sessionUser.id} `
      + `across ${(sessionUser.guilds || []).length} guild(s) — approaching the browser limit.`,
    );
  }

  res.cookie(COOKIE_NAME, sessionToken, { ...baseCookie, maxAge: SESSION_DAYS * 86400 * 1000 });
}

// ── Gate for protected routes ───────────────────────────────────────────────
// Sessions older than REVERIFY_MS are re-checked against Discord via the bot:
// kicked members and revoked roles are cut off within the hour instead of
// keeping access for the token's full lifetime. Discord being unreachable is
// NOT treated as revocation (fail open, retry next request) — only a definitive
// 404 (not a member) or a failed role check revokes the session.
const reverifyInFlight = new Map(); // user id -> Promise (dedupes request bursts)

async function requireAuth(req, res, next) {
  // Already authenticated on this request — don't do it again.
  //
  // requireAdminArea and requirePermission both call requireAuth internally, and
  // every one of them is mounted under the /api wall that has already run it. A
  // second pass re-decoded the token and reassigned req.user, which threw away
  // the per-guild narrowing applyGuildAccess had just done and left an officer
  // with no capabilities at all. Re-verifying twice in one request was never
  // useful; now it also can't undo work.
  if (req.user) return next();

  const token = req.cookies?.[COOKIE_NAME];
  if (!authConfigured || !token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }

  // Tokens issued before this feature have no verified_at and re-verify immediately.
  const stale = botConfigured && Date.now() - (user.verified_at || 0) > REVERIFY_MS;
  if (stale) {
    try {
      let pending = reverifyInFlight.get(user.id);
      if (!pending) {
        pending = reverify(user).finally(() => reverifyInFlight.delete(user.id));
        reverifyInFlight.set(user.id, pending);
      }
      const refreshed = await pending;

      if (refreshed === REVOKED) {
        res.clearCookie(COOKIE_NAME, baseCookie);
        return res.status(401).json({ error: 'You are no longer a member of the guild.' });
      }
      if (refreshed) {
        issueSession(res, refreshed); // fresh verified_at (and current roles/name)
        user = refreshed;
      }
      // null = Discord was unreachable or erroring; keep the session and retry
      // on a later request rather than treating our own outage as a revocation.
    } catch (err) {
      console.warn('Session re-verify failed — keeping existing session:', err.message);
    }
  }

  req.user = user;
  next();
}

// Re-check every guild in the session against Discord. Returns a fresh session,
// REVOKED when the user has lost access everywhere, or null to leave the
// session alone (Discord unreachable — our outage, not their revocation).
//
// Losing access to ONE guild of several is not a revocation: that guild simply
// drops out of the list and the others keep working.
const REVOKED = Symbol('revoked');

async function reverify(user) {
  // A session from before task 10 has no guilds list; re-verify it against the
  // pinned guild so it comes back in the new shape instead of being stuck.
  // Pre-task-10 sessions carry no guilds list. In pinned mode they can still be
  // re-verified against the pinned tenant, whose Discord id comes from its row —
  // never from env, which on a shared host is a different guild entirely.
  let list = Array.isArray(user.guilds) && user.guilds.length ? user.guilds : [];
  if (!list.length && SINGLE_GUILD_ID) {
    const pinned = await guildRegistry.resolveById(db, SINGLE_GUILD_ID);
    if (pinned) list = [{ guild_id: pinned.id, discord_guild_id: pinned.discord_guild_id }];
  }
  if (!list.length) return null;

  let anyReachable = false;
  const results = await Promise.all(list.map(async (m) => {
    const guild = await guildRegistry.resolveById(db, m.guild_id);
    if (!guild) return null; // deregistered or suspended mid-session — drop it
    const { status, member } = await fetchMember(user.id, guild.discord_guild_id);
    if (status === 200) { anyReachable = true; return evaluateMember(member, guild); }
    if (status === 404) { anyReachable = true; return null; } // definitively gone
    console.warn(`Session re-verify for ${user.id} in ${guild.discord_guild_id} got HTTP ${status}.`);
    return null;
  }));

  const memberships = (await Promise.all(results)).filter(Boolean);
  if (memberships.length) return buildSession(user, memberships);
  // Nothing left. Only call that a revocation if Discord actually answered —
  // otherwise a rate limit would sign out every user at once.
  return anyReachable ? REVOKED : null;
}

// Re-exported from permissions.js so routes can check a capability without
// importing both modules; one implementation, including the legacy-session rule.
const { userHas } = perms;

// Gate for the admin area. Resolves the capability the requested path needs and
// checks it, rather than admitting anyone with the old blanket admin flag.
//
// A path no rule matches fails closed with 403: a new admin route is unreachable
// until it's added to ROUTE_PERMISSIONS, which is the safe direction to be wrong
// in — the alternative is a route that silently defaults to public.
function requireAdminArea(req, res, next) {
  requireAuth(req, res, () => {
    const held = Array.isArray(req.user?.permissions)
      ? req.user.permissions
      : (req.user?.isAdmin ? perms.ALL_PERMISSIONS.map((p) => p.key) : []);
    if (held.length === 0) return res.status(403).json({ error: 'Admin access required' });

    const needed = perms.permissionForPath(req.path);
    if (needed === perms.ANY) return next(); // shared reads: any capability will do
    if (needed && held.includes(needed)) return next();

    if (!needed) {
      console.warn(`No permission rule for admin path ${req.path} — denying.`);
      return res.status(403).json({ error: 'This action has no permission rule configured.' });
    }
    return res.status(403).json({ error: `You don't have the "${needed}" permission.` });
  });
}

// Require one specific capability, for routes outside the /api/admin mount —
// the LOA routes live under plain requireAuth but still have officer-only parts.
function requirePermission(permission) {
  return (req, res, next) => requireAuth(req, res, () => {
    if (userHas(req.user, permission)) return next();
    return res.status(403).json({ error: `You don't have the "${permission}" permission.` });
  });
}

// Kept for compatibility: "any admin-area access at all". Prefer requireAdminArea
// on the admin mount and requirePermission elsewhere.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.isAdmin) return next();
    return res.status(403).json({ error: 'Admin access required' });
  });
}

// Lightweight session check for non-API routes (e.g. deciding whether the root
// path shows the marketing landing page or the app). Returns true only for a
// present, validly-signed session cookie — same secret and cookie name as the
// real auth path, so the two can't disagree.
function hasValidSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!authConfigured || !token) return false;
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  router, requireAuth, requireAdmin, requireAdminArea, requirePermission, userHas,
  hasValidSession, applyGuildAccess,
};
