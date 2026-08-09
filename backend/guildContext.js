'use strict';

// ── GUILD RESOLUTION (HTTP) ──────────────────────────────────────────────────
// Decides which guild a request is scoped to and hangs the tenant on the
// request, so everything below the login wall has both the id to scope queries
// by and the per-guild config that used to live in shared/guild.json.
//
//   req.guildId  the uuid — what tenantDb() takes
//   req.guild    the full guilds row — timezone, day_start, tag, aliases,
//                role/channel ids (plan task 9)
//
// Handlers should prefer req.guild for anything configuration-shaped. The two
// always describe the same tenant; req.guildId is kept because most call sites
// only need the id and reading `.guild.id` everywhere adds nothing.
//
// MOUNT ORDER MATTERS: this runs AFTER requireAuth, never in place of it. It
// reads req.user to prove membership, so without a populated req.user the check
// can't match — and swapping it in for requireAuth removes the login wall:
//
//   app.use('/api', (req, res, next) => {
//     if (req.path === '/health' || req.path.startsWith('/auth')) return next();
//     return requireAuth(req, res, () => resolveGuildOrSingle(req, res, next));
//   });
//
// This is the web twin of the bot's resolveTenant in discordGateway.js; both
// go through guildRegistry so there is one definition of "which tenant".

const guildRegistry = require('./guildRegistry');

// The frontend names the active guild per request. A header travels through
// axios defaults without rewriting every call site; a /g/:guildId route param
// is honoured too, for links that carry their own context.
const GUILD_HEADER = 'x-guild-id';

// applyGuildAccess is injected rather than required: auth.js already imports
// GUILD_HEADER from this module, so importing auth here would close a require
// cycle and whichever module loaded second would destructure `undefined` off a
// half-built exports object — a session that silently never gets narrowed.
// Passing it in keeps the dependency one-way and this module testable alone.
module.exports = function createGuildContext(supabase, applyGuildAccess = () => null) {
  // Attach a resolved tenant, or fail closed. Returns true on success so the
  // callers below can stop cleanly.
  async function attach(req, res, guildId) {
    const row = await guildRegistry.resolveById(supabase, guildId);
    if (!row) {
      res.status(403).json({ error: 'That guild is not available.' });
      return false;
    }
    req.guildId = row.id;
    req.guild = row;
    return true;
  }

  // Model A (shared deployment, many guilds).
  //
  // The header is a *claim*, not proof. Anyone can set it, so it only ever
  // picks from the guilds the signed session already says the user belongs to.
  // Trusting the header alone would let any logged-in member of any guild read
  // every other guild's data by editing one request.
  async function resolveGuild(req, res, next) {
    const requested = req.headers[GUILD_HEADER] || req.params.guildId;
    if (!requested) return res.status(400).json({ error: 'No guild selected.' });

    const memberships = req.user && req.user.guilds;
    if (!Array.isArray(memberships)) {
      // The session predates multi-guild support (or requireAuth didn't run).
      // Fail closed: with no membership list there is nothing to check against.
      return res.status(403).json({ error: 'Session carries no guild membership. Sign in again.' });
    }

    const membership = memberships.find((g) => g.guild_id === requested);
    if (!membership) return res.status(403).json({ error: 'Not a member of that guild.' });

    if (!(await attach(req, res, requested))) return;
    // Narrow the session to THIS guild's capabilities. Until this runs, the
    // session holds a list of memberships and no flat permissions array, so
    // every userHas() downstream is answering for the guild in front of it.
    applyGuildAccess(req.user, requested);
    return next();
  }

  // Model B (single-guild self-host): pin the one guild from env and skip
  // resolution. Same code path downstream — handlers still read req.guild and
  // req.guildId — so the two modes can't drift into separate implementations.
  //
  // This branch never touches req.user.guilds, which is what lets single-tenant
  // mode work against the current session shape unchanged.
  async function resolveGuildOrSingle(req, res, next) {
    if (process.env.SINGLE_GUILD_ID) {
      if (!(await attach(req, res, process.env.SINGLE_GUILD_ID))) return;
      // Narrow to the pinned guild. A session from before task 10 has no guilds
      // list and is left exactly as it was, which is what stops a deploy from
      // stripping every live session's access mid-request.
      applyGuildAccess(req.user, process.env.SINGLE_GUILD_ID);
      return next();
    }
    return resolveGuild(req, res, next);
  }

  return { resolveGuild, resolveGuildOrSingle, GUILD_HEADER };
};

module.exports.GUILD_HEADER = GUILD_HEADER;
