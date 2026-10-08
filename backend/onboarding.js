'use strict';

// ── SELF-SERVE ONBOARDING (/api/onboard) ─────────────────────────────────────
// How a guild adds itself — after paying. The /setup page walks through it:
//
//   1. Sign in   GET /start → Discord (identify) → /callback
//                Sets gh_onboard, a short-lived signed cookie naming the
//                Discord user. Deliberately NOT a session: this person may
//                belong to no guild yet, and the session cookie is already
//                close to the browser's 4KB limit.
//   2. Pay       Paddle checkout in the browser (billing.js). The webhook
//                turns it into an unclaimed seat; GET /state shows the page
//                when it lands.
//   3. Add bot   GET /bot → Discord (identify guilds bot) → /callback
//                Discord only lets someone add a bot to a server they hold
//                Manage Server in, so this step is also the authority check.
//                The server id comes from the token response, never the URL.
//   4. Basics    POST /complete → onboard_claim_guild() turns the seat into a
//                guilds row, then the browser goes through normal login and
//                lands as an officer.
//
// Everything here is checked again at /complete, because a cookie is a claim
// about the past: the seat may have lapsed, the bot may have been kicked, the
// officer role may have been taken away, someone else may have registered the
// server first.
//
// Not served on the merc host — /api/onboard isn't in sites.js MERC_API.

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { signScoped, verifyScoped, oauth } = require('./auth');
const { listRoles, fetchMember, botGuild, botConfigured } = require('./discord');
const { validateGuildFields, assertKeepsAccess } = require('./guildSettings');
const guildRegistry = require('./guildRegistry');
const { tenantDb } = require('./tenantDb');

const COOKIE = 'gh_onboard';
const STATE_COOKIE = 'gh_onboard_state';
const COOKIE_TTL = '2h';
const SNOWFLAKE = /^\d{17,20}$/;
// View Channels, Send Messages, Embed Links, Attach Files, Read Message History —
// the same set as the invite link in DEPLOY_GUILDHALL.md.
const BOT_PERMISSIONS = process.env.DISCORD_BOT_PERMISSIONS || '52224';
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

module.exports = function createOnboarding(supabase, {
  billing,
  notifyStaff = async () => false,
  discord = 'https://discord.com/api',
} = {}) {
  const router = express.Router();

  // ── Invite-only mode ──────────────────────────────────────────────────────
  // ONBOARDING_ALLOWED_USERS: comma-separated Discord user ids. While it is
  // set, only those people get past sign-in — everyone else is told signups
  // aren't open. It exists for testing on the live site against Paddle's
  // sandbox, where anyone with Paddle's public test card could otherwise
  // create a real guild. Unset (or empty) means open to everyone.
  //
  // Checked at every step, not just sign-in: a cookie minted while someone was
  // on the list must stop working the moment they're taken off it.
  const allowlist = String(process.env.ONBOARDING_ALLOWED_USERS || '')
    .split(',').map((s) => s.trim()).filter((s) => SNOWFLAKE.test(s));
  const allowed = (uid) => !allowlist.length || allowlist.includes(String(uid || ''));
  if (allowlist.length) console.log(`Onboarding is invite-only (${allowlist.length} allowed user(s)).`);

  const redirectUri = `${oauth.origin}/api/onboard/callback`;
  const setupUrl = `${oauth.origin}/setup`;
  const ready = () => Boolean(oauth.configured && oauth.origin && supabase && billing && billing.configured && botConfigured);

  // Sign-in and bot steps are a person clicking through Discord; a burst
  // beyond this is a script. /state is polled while checkout completes, so it
  // gets its own, looser budget.
  const stepLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, limit: 30,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many attempts — please try again later.' },
  });
  const pollLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, limit: 600,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests — please try again later.' },
  });

  const readCookie = (req) => verifyScoped('onboard', req.cookies && req.cookies[COOKIE]);
  const writeCookie = (res, payload) => res.cookie(COOKIE, signScoped('onboard', payload, COOKIE_TTL),
    { ...oauth.baseCookie, maxAge: 2 * 60 * 60 * 1000 });
  const back = (res, code) => res.redirect(`${setupUrl}${code ? `?error=${encodeURIComponent(code)}` : ''}`);

  // ── Discord OAuth, shared by both steps ───────────────────────────────────
  // The stage rides in the state cookie next to the CSRF nonce, so one
  // registered redirect serves both and a callback can't be replayed into the
  // other step.
  function authorize(res, stage, scope, extra = {}) {
    const nonce = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, `${stage}.${nonce}`, { ...oauth.baseCookie, maxAge: 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      state: nonce,
      prompt: 'consent',
      ...extra,
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  }

  router.get('/start', stepLimiter, (req, res) => {
    if (!ready()) return back(res, 'unavailable');
    authorize(res, 'identify', 'identify');
  });

  router.get('/bot', stepLimiter, async (req, res) => {
    if (!ready()) return back(res, 'unavailable');
    const who = readCookie(req);
    if (!who) return back(res, 'signin');
    if (!allowed(who.uid)) return back(res, 'closed');
    try {
      if (!(await billing.unclaimedSeat(who.uid))) return back(res, 'unpaid');
    } catch (err) {
      console.error('onboard /bot:', err.message);
      return back(res, 'error');
    }
    authorize(res, 'bot', 'identify guilds bot applications.commands', { permissions: BOT_PERMISSIONS });
  });

  router.get('/callback', stepLimiter, async (req, res) => {
    if (!ready()) return back(res, 'unavailable');
    const saved = String((req.cookies && req.cookies[STATE_COOKIE]) || '');
    res.clearCookie(STATE_COOKIE, oauth.baseCookie);
    const [stage, nonce] = saved.split('.');
    const { code, state, error } = req.query;

    // Cancelling on Discord's screen comes back as ?error=access_denied.
    if (error) return back(res, stage === 'bot' ? 'bot_cancelled' : 'signin_cancelled');
    if (!code || !state || !nonce || state !== nonce || !['identify', 'bot'].includes(stage)) {
      return back(res, 'state');
    }

    try {
      const tokenRes = await axios.post(`${discord}/oauth2/token`, new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: (s) => s < 500,
      });
      const token = tokenRes.data && tokenRes.data.access_token;
      if (tokenRes.status !== 200 || !token) {
        console.error(`onboard callback: token exchange failed (HTTP ${tokenRes.status}).`, JSON.stringify(tokenRes.data));
        return back(res, 'discord');
      }
      const headers = { Authorization: `Bearer ${token}` };
      const me = (await axios.get(`${discord}/users/@me`, { headers, validateStatus: (s) => s < 500 })).data || {};
      if (!SNOWFLAKE.test(String(me.id || ''))) return back(res, 'discord');

      if (!allowed(me.id)) return back(res, 'closed');

      if (stage === 'identify') {
        writeCookie(res,{ uid: String(me.id), username: me.global_name || me.username || 'Unknown' });
        return back(res);
      }

      // ── stage === 'bot' ───────────────────────────────────────────────────
      const who = readCookie(req);
      // The account that added the bot must be the one that paid. Otherwise a
      // payer could hand their session to someone else's consent screen.
      if (!who || who.uid !== String(me.id)) return back(res, 'wrong_account');

      // Discord's word on which server the bot joined. The redirect's own
      // guild_id is only a hint, per Discord's docs, and a user can edit it.
      const server = tokenRes.data.guild;
      if (!server || !SNOWFLAKE.test(String(server.id || ''))) return back(res, 'bot_cancelled');
      const serverId = String(server.id);

      // Belt and braces: Discord required Manage Server to add the bot, but
      // confirm it rather than assume it.
      const mine = (await axios.get(`${discord}/users/@me/guilds`, { headers, validateStatus: (s) => s < 500 })).data;
      const entry = Array.isArray(mine) ? mine.find((g) => String(g.id) === serverId) : null;
      let perms = 0n;
      try { perms = BigInt((entry && entry.permissions) || 0); } catch { perms = 0n; }
      if (!entry || !(entry.owner || (perms & MANAGE_GUILD) || (perms & ADMINISTRATOR))) {
        return back(res, 'not_manager');
      }

      const { data: existing, error: lookupErr } = await supabase.from('guilds')
        .select('id').eq('discord_guild_id', serverId).maybeSingle();
      if (lookupErr) throw new Error(lookupErr.message);
      if (existing) return back(res, 'already_registered');

      writeCookie(res, { uid: who.uid, username: who.username, sid: serverId, sname: String(server.name || '').slice(0, 100) });
      return back(res);
    } catch (err) {
      console.error('onboard callback error:', err.message);
      return back(res, 'error');
    }
  });

  // ── What the /setup page should show ──────────────────────────────────────
  router.get('/state', pollLimiter, async (req, res) => {
    if (!ready()) return res.json({ available: false });
    const who = readCookie(req);
    if (!who) return res.json({ available: true, signedIn: false });
    if (!allowed(who.uid)) return res.json({ available: false });

    try {
      const seat = await billing.unclaimedSeat(who.uid);
      const out = {
        available: true,
        signedIn: true,
        user: { id: who.uid, username: who.username },
        seat: seat ? { status: seat.status, trial_ends_at: seat.trial_ends_at } : null,
        server: null,
      };
      if (seat && who.sid) {
        const [{ inGuild, name }, roles, member] = await Promise.all([
          botGuild(who.sid),
          listRoles({ discord_guild_id: who.sid }).catch(() => []),
          fetchMember(who.uid, who.sid).then((r) => r.member).catch(() => null),
        ]);
        out.server = {
          id: who.sid,
          name: name || who.sname || null,
          botPresent: inGuild,
          roles,
          heldRoleIds: member ? (member.roles || []).map(String) : [],
        };
      }
      res.json(out);
    } catch (err) {
      console.error('onboard /state:', err.message);
      res.status(500).json({ error: 'Could not load your setup.' });
    }
  });

  // The price, for the landing page and step 2. Public on purpose.
  router.get('/plan', pollLimiter, async (req, res) => {
    try {
      const plan = billing && billing.configured ? await billing.plan() : null;
      if (!plan) return res.status(503).json({ error: 'Signups are not open yet.' });
      res.json(plan);
    } catch (err) {
      console.error('onboard /plan:', err.message);
      res.status(502).json({ error: 'Could not load pricing.' });
    }
  });

  // ── Create the guild ──────────────────────────────────────────────────────
  router.post('/complete', stepLimiter, async (req, res) => {
    if (!ready()) return res.status(503).json({ error: 'Signups are not open yet.' });
    const who = readCookie(req);
    if (!who) return res.status(401).json({ error: 'Your setup session expired — sign in with Discord again.' });
    if (!allowed(who.uid)) return res.status(403).json({ error: "Signups aren't open yet." });
    if (!who.sid) return res.status(400).json({ error: 'Add the bot to your server first.' });

    const b = req.body || {};
    if (b.accept_terms !== true) {
      return res.status(400).json({ error: 'Please accept the Terms of Service and Privacy Policy.' });
    }

    try {
      // Only the basics the wizard asks for. Channels and the rest are set
      // afterwards on Guild Settings, through the same validator.
      const fields = validateGuildFields({
        house: b.house,
        tag: b.tag,
        timezone: b.timezone,
        day_start: b.day_start,
        admin_role_ids: b.admin_role_ids,
        allowed_role_ids: b.allowed_role_ids,
      });

      const bot = await botGuild(who.sid);
      if (!bot.inGuild) {
        return res.status(409).json({ error: "The Guild Hall bot isn't in your server any more. Add it again, then finish setup." });
      }
      // The same guard the settings page uses: the creator must hold an
      // officer role they picked, or the guild they just paid for locks them
      // out on its first hour.
      await assertKeepsAccess(who.sid, who.uid, fields);

      const { data, error } = await supabase.rpc('onboard_claim_guild', {
        p_discord_user_id: who.uid,
        p_discord_guild_id: who.sid,
        p_guild: {
          house: fields.house,
          tag: fields.tag,
          aliases: fields.aliases,
          timezone: fields.timezone,
          day_start: fields.day_start,
          admin_role_ids: fields.admin_role_ids,
          allowed_role_ids: fields.allowed_role_ids,
          member_role_ids: fields.member_role_ids,
        },
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;

      if (!row || row.result === 'no_seat') {
        return res.status(402).json({ error: "We couldn't find a paid subscription waiting for a guild. If you just paid, wait a moment and try again." });
      }
      if (row.result === 'already_registered') {
        return res.status(409).json({ error: 'That Discord server already has a Guild Hall. Sign in instead.' });
      }

      guildRegistry.invalidate(who.sid);

      // The new guild's first audit entry: who created it, from what. Its
      // officers will see it at the top of their audit log.
      tenantDb(supabase, row.guild_id).from('audit_log').insert({
        actor_id: who.uid,
        actor_name: who.username || null,
        action: 'POST /onboard/complete',
        method: 'POST',
        path: '/onboard/complete',
        feature: 'Guild Settings',
        body: { house: fields.house, tag: fields.tag, timezone: fields.timezone, admin_role_ids: fields.admin_role_ids },
        status_code: 200,
      }).then(({ error: auditErr }) => { if (auditErr) console.error('onboard audit insert failed:', auditErr.message); });

      Promise.resolve(notifyStaff({
        content: `🏰 New guild: **${fields.house}** [${fields.tag}] — set up by ${who.username} (${who.uid}), Discord server ${who.sid}.`,
      })).catch(() => {});

      res.clearCookie(COOKIE, oauth.baseCookie);
      res.json({ ok: true, next: '/api/auth/login' });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('onboard /complete error:', err.message);
      res.status(500).json({ error: 'Could not create your guild just now. Your subscription is still waiting for it — try again in a moment.' });
    }
  });

  return router;
};
