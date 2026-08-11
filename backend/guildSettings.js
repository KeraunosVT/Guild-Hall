// backend/guildSettings.js — the editable half of a tenant's own guilds row.
//
// Until now nothing in the application wrote this row at all: it was created by
// scripts/onboardGuild.js and then frozen, so renaming a house or moving a
// channel meant opening the SQL editor. This module is the one place it can be
// changed from the app, which makes it also the one place the three ways that
// change can go badly have to be handled.
//
// ── WHAT IS DELIBERATELY NOT EDITABLE ───────────────────────────────────────
//   id, discord_guild_id — the tenant's identity. Repointing a guild at another
//     Discord server is not a setting, it is a takeover.
//   status, subscription_status — operator state. A tenant that can set its own
//     status can un-suspend itself, which makes suspension decorative.
// Only the fields listed in EDITABLE below are ever written, so a column added
// to `guilds` later cannot become writable by accident.
const { tenantDb } = require('./tenantDb');
const guildRegistry = require('./guildRegistry');
const { fetchMember, invalidateGuild, botConfigured } = require('./discord');

const SNOWFLAKE = /^\d{17,20}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// The complete write allow-list. Nothing outside this set reaches the update.
const EDITABLE = [
  'house', 'tag', 'aliases', 'motto', 'creed',
  'timezone', 'day_start',
  'admin_role_ids', 'allowed_role_ids', 'member_role_ids',
  'roster_channel_id', 'loa_channel_id', 'announce_channel_id', 'signup_channel_id',
  'signup_mention_role_id',
];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const nullable = (v, max) => str(v, max) || null;

function roleList(v, label) {
  const list = (Array.isArray(v) ? v : [])
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  const bad = list.filter((id) => !SNOWFLAKE.test(id));
  if (bad.length) throw httpError(400, `${label}: not Discord role ids — ${bad.join(', ')}`);
  return [...new Set(list)];
}

// Blank is legal and means "this feature posts nowhere". That used to be
// dangerous, because a blank channel fell back to the deployment's env var and
// silently posted into another tenant's channel; that fallback is gone (see the
// header of discordGateway.js), so blank now means exactly what it says.
function channelId(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!SNOWFLAKE.test(s)) throw httpError(400, `${label}: not a Discord channel id — ${s}`);
  return s;
}

// One optional role, for settings that name a single role rather than a list.
// Blank means "ping nobody", which is a real choice and the default.
function roleId(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!SNOWFLAKE.test(s)) throw httpError(400, `${label}: not a Discord role id — ${s}`);
  return s;
}

module.exports = function createGuildSettings(supabase) {
  // What the form loads. Explicit projection of EDITABLE rather than the whole
  // row, so billing state and the tenant's internal id never reach the browser
  // just because someone added a column.
  function current(guild) {
    const out = {};
    EDITABLE.forEach((k) => {
      const v = guild[k];
      out[k] = Array.isArray(v) ? v : (v ?? (k.endsWith('_ids') ? [] : null));
    });
    return out;
  }

  // ── GUARD 1: don't let anyone lock the house out of its own hall ──────────
  //
  // admin_role_ids and allowed_role_ids are the gate on the page editing them,
  // and the damage is DELAYED: capabilities live in the signed session cookie
  // and only refresh on the hourly re-verify, so whoever breaks this keeps
  // working for up to an hour and discovers it when nobody can sign in — by
  // which point they can't get back in to undo it either.
  //
  // There is no override flag. A confirmation dialog is the wrong shape for a
  // mistake whose consequence arrives an hour later and cannot be reversed from
  // inside the app; the way back would be the SQL editor, which is exactly what
  // this page exists to avoid needing.
  //
  // The actor's roles come from Discord, not the session: the session
  // deliberately stopped storing role snowflakes (they were the largest thing
  // in the cookie, see auth.js), and Discord is the authority anyway.
  async function assertNotSelfLockout(guild, actorId, next) {
    if (!next.admin_role_ids.length) {
      throw httpError(400, 'At least one officer role is required — clearing them all would leave nobody able to reach this page.');
    }
    if (!botConfigured) {
      throw httpError(503, 'Role changes need the Discord bot to verify your own roles first, and it is not configured.');
    }

    let member = null;
    try {
      ({ member } = await fetchMember(actorId, guild.discord_guild_id));
    } catch (err) {
      console.error('guildSettings role check failed:', err.message);
    }
    if (!member) {
      // Fail CLOSED. Not being able to prove the actor keeps access is not the
      // same as proving they do, and this is the one write where guessing wrong
      // is unrecoverable from inside the app.
      throw httpError(502, "Couldn't check your own roles with Discord just now — nothing was saved. Try again in a moment.");
    }

    const held = new Set((member.roles || []).map(String));
    if (!next.admin_role_ids.some((r) => held.has(r))) {
      throw httpError(400, 'You must keep at least one officer role that you hold yourself — otherwise this save would lock you out of this page.');
    }
    // Login checks the allow-list BEFORE any capability, so an officer role
    // that isn't also allowed still can't sign in. An EMPTY allow-list means
    // "any member", which locks nobody out.
    if (next.allowed_role_ids.length && !next.allowed_role_ids.some((r) => held.has(r))) {
      throw httpError(400, 'The member allow-list must include a role you hold, or you would not be able to sign in again.');
    }
  }

  // ── GUARD 2: aliases are append-only in practice ──────────────────────────
  //
  // Match rows record whatever the guild was CALLED the day the scoreboard was
  // uploaded, and canonicalGuildFor() collapses any listed alias onto the
  // current tag. Drop an alias that history still uses and those rows stop
  // being ours — they are silently re-read as an enemy guild's, taking their
  // kills and damage out of the war record with no error anywhere.
  //
  // So removal is refused only when it would actually orphan something. An
  // alias nobody ever played under is a typo and can go.
  async function assertAliasesSafe(guild, removed) {
    if (!removed.length) return;
    const { data, error } = await tenantDb(supabase, guild.id)
      .from('player_match_stats').select('guild_name').in('guild_name', removed);
    if (error) {
      console.error('guildSettings alias check failed:', error.message);
      throw httpError(500, 'Could not check the war record against those names, so nothing was saved.');
    }
    const inUse = [...new Set((data || []).map((r) => r.guild_name))];
    if (inUse.length) {
      throw httpError(400,
        `${inUse.join(', ')} still appears in the war record — removing it would orphan those matches out of the guild. `
        + 'Past names have to stay listed forever; add new ones instead.');
    }
  }

  return {
    EDITABLE,
    current,

    async save(guild, body, actor) {
      const b = body || {};

      const house = str(b.house, 120);
      if (!house) throw httpError(400, 'House name is required.');
      const tag = str(b.tag, 32);
      if (!tag) throw httpError(400, 'Guild tag is required.');

      const timezone = str(b.timezone, 60) || 'America/New_York';
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch {
        throw httpError(400, `"${timezone}" is not an IANA timezone.`);
      }
      const dayStart = str(b.day_start, 5);
      if (!TIME_RE.test(dayStart)) throw httpError(400, 'Guild-night rollover must be a time like 01:00.');

      // The tag is force-added rather than merely required. Renaming a guild
      // and forgetting to list the NEW name is the same orphaning bug as
      // dropping an old one, just pointed at the future: every scoreboard
      // uploaded from that day on would read as an enemy guild's.
      const aliases = [...new Set([
        ...(Array.isArray(b.aliases) ? b.aliases : []).map((a) => str(a, 32)).filter(Boolean),
        tag,
      ])];

      const next = {
        house,
        tag,
        aliases,
        motto: nullable(b.motto, 200),
        creed: nullable(b.creed, 500),
        timezone,
        day_start: dayStart,
        admin_role_ids: roleList(b.admin_role_ids, 'Officer roles'),
        allowed_role_ids: roleList(b.allowed_role_ids, 'Member allow-list'),
        member_role_ids: roleList(b.member_role_ids, 'Roster roles'),
        roster_channel_id: channelId(b.roster_channel_id, 'Roster channel'),
        loa_channel_id: channelId(b.loa_channel_id, 'LOA channel'),
        announce_channel_id: channelId(b.announce_channel_id, 'Announce channel'),
        signup_channel_id: channelId(b.signup_channel_id, 'Signup channel'),
        // Not validated against the guild's live role list on purpose: Discord
        // being unreachable must not stop someone fixing the motto, and the
        // @everyone role (whose id is the Discord guild id) never appears in
        // that list anyway. A wrong id renders as a dead mention, which is
        // visible and harmless — unlike a wrong officer role.
        signup_mention_role_id: roleId(b.signup_mention_role_id, 'Signup ping role'),
      };

      const before = Array.isArray(guild.aliases) ? guild.aliases.filter(Boolean) : [];
      await assertAliasesSafe(guild, before.filter((a) => !aliases.includes(a)));
      await assertNotSelfLockout(guild, actor && actor.id, next);

      // `guilds` is on tenantDb's GLOBAL_TABLES list, so the wrapper injects NO
      // guild filter here — this is the tenant registry, scoped by its own id
      // rather than by guild_id. The .eq('id', …) below is therefore the only
      // thing standing between this and an update across every tenant on the
      // deployment, and it is written against the resolved row, never a body
      // field. (test/leakAudit.js allow-lists this file for the same reason it
      // allow-lists guildRegistry.js.)
      const { error } = await supabase.from('guilds')
        .update({ ...next, updated_at: new Date().toISOString() })
        .eq('id', guild.id);
      if (error) {
        console.error('guildSettings save error:', error.message);
        throw httpError(500, 'Could not save these settings.');
      }

      // Both caches, or the change appears to do nothing for up to a minute and
      // people press save again. The registry holds the row every request and
      // every slash command resolves through; discord.js holds this guild's
      // member and role lists, which member_role_ids decides the contents of.
      guildRegistry.invalidate(guild.discord_guild_id);
      invalidateGuild(guild);

      return { settings: current({ ...guild, ...next }) };
    },
  };
};
