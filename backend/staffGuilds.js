'use strict';

// ── STAFF: GUILDS (/api/staff/guilds) ────────────────────────────────────────
// Every tenant on the deployment, for Guild Hall staff — the people who run
// the platform (backend/staff.js), not any guild's officers. Replaces the SQL
// editor for the three things staff actually need to do to a guild:
//
//   · SUSPEND    with a reason. A 'staff' suspension, which no payment lifts
//                (billing_apply_subscription only lifts 'billing' ones).
//   · REACTIVATE a guild staff suspended. A BILLING suspension is refused:
//                the fix for that is a payment, or comping the guild.
//   · COMP       billing_exempt — never suspended for billing, whatever the
//                subscription does. Comping a billing-suspended guild reopens
//                it.
//
// Plus the read side: each guild's subscription, and seats that were paid for
// but never turned into a guild (someone who checked out and stopped).
//
// Cross-tenant by nature, so it reads `guilds` and `subscriptions` unscoped —
// both are GLOBAL_TABLES. Every write is by the guild's own id from the URL,
// and is recorded in THAT guild's audit log, so its officers can see what
// staff did to their hall.

const express = require('express');
const guildRegistry = require('./guildRegistry');
const { tenantDb } = require('./tenantDb');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUILD_COLUMNS = [
  'id', 'discord_guild_id', 'house', 'tag', 'status', 'suspended_reason',
  'suspended_note', 'suspended_by', 'suspended_at', 'billing_exempt',
  'subscription_status', 'created_at', 'created_by',
].join(', ');
const SUB_COLUMNS = 'guild_id, discord_user_id, status, trial_ends_at, current_period_end, grace_until, created_at';

module.exports = function createStaffGuilds(supabase) {
  const router = express.Router();

  // Only platform staff, resolved from deploy-time config at login. No guild
  // capability reaches this, however senior.
  router.use((req, res, next) => (req.user && req.user.staff
    ? next()
    : res.status(403).json({ error: 'Only Guild Hall staff can manage guilds.' })));
  router.use((req, res, next) => (supabase ? next() : res.status(503).json({ error: 'Database not configured.' })));

  const actorOf = (req) => `${req.user.username || 'unknown'} (${req.user.id})`;

  // Recorded in the affected guild's own audit log. Best-effort: a failed
  // audit insert never undoes the action it describes.
  function audit(req, guildId, action, body) {
    tenantDb(supabase, guildId).from('audit_log').insert({
      actor_id: req.user.id,
      actor_name: `Guild Hall staff · ${req.user.username || 'unknown'}`,
      action: `STAFF ${action}`,
      method: 'POST',
      path: `/staff/guilds/${action}`,
      feature: 'Guild Settings',
      body: body || {},
      status_code: 200,
    }).then(({ error }) => { if (error) console.error('staff audit insert failed:', error.message); });
  }

  async function load(id) {
    if (!UUID.test(String(id || ''))) return null;
    const { data, error } = await supabase.from('guilds').select(GUILD_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  router.get('/', async (req, res) => {
    try {
      const [guilds, subs] = await Promise.all([
        supabase.from('guilds').select(GUILD_COLUMNS).order('created_at', { ascending: false }),
        supabase.from('subscriptions').select(SUB_COLUMNS).order('created_at', { ascending: false }),
      ]);
      if (guilds.error) throw new Error(guilds.error.message);
      if (subs.error) throw new Error(subs.error.message);

      const byGuild = new Map((subs.data || []).filter((s) => s.guild_id).map((s) => [s.guild_id, s]));
      res.json({
        guilds: (guilds.data || []).map((g) => ({ ...g, subscription: byGuild.get(g.id) || null })),
        // Paid, never claimed: someone who checked out and didn't finish.
        unclaimed: (subs.data || []).filter((s) => !s.guild_id),
      });
    } catch (err) {
      console.error('staff guilds list:', err.message);
      res.status(500).json({ error: 'Could not load guilds.' });
    }
  });

  router.post('/:id/suspend', async (req, res) => {
    const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
    if (!note) return res.status(400).json({ error: 'Give a reason — it stays internal to staff.' });
    try {
      const g = await load(req.params.id);
      if (!g) return res.status(404).json({ error: 'No such guild.' });
      if (g.status === 'suspended' && g.suspended_reason === 'staff') {
        return res.status(409).json({ error: 'Already suspended by staff.' });
      }
      // A billing suspension can be turned into a staff one, so a later
      // payment doesn't reopen a guild staff meant to keep closed.
      const { data, error } = await supabase.from('guilds').update({
        status: 'suspended', suspended_reason: 'staff', suspended_note: note,
        suspended_by: actorOf(req), suspended_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', g.id).neq('status', 'deleted').select('id');
      if (error) throw new Error(error.message);
      if (!data || !data.length) return res.status(409).json({ error: 'That guild changed underneath you — reload and try again.' });
      guildRegistry.invalidate(g.discord_guild_id);
      audit(req, g.id, 'suspend', { note });
      res.json({ ok: true });
    } catch (err) {
      console.error('staff suspend:', err.message);
      res.status(500).json({ error: 'Could not suspend the guild.' });
    }
  });

  router.post('/:id/reactivate', async (req, res) => {
    try {
      const g = await load(req.params.id);
      if (!g) return res.status(404).json({ error: 'No such guild.' });
      if (g.status === 'active') return res.status(409).json({ error: 'Already active.' });
      if (g.suspended_reason === 'billing') {
        return res.status(409).json({ error: 'Suspended for billing — it reopens when they pay. To reopen it anyway, comp it.' });
      }
      // Conditional on still being staff-suspended, so this can't race a
      // billing change into reopening something it shouldn't.
      const { data, error } = await supabase.from('guilds').update({
        status: 'active', suspended_reason: null, suspended_note: null,
        suspended_by: null, suspended_at: null, updated_at: new Date().toISOString(),
      }).eq('id', g.id).eq('status', 'suspended').eq('suspended_reason', 'staff').select('id');
      if (error) throw new Error(error.message);
      if (!data || !data.length) return res.status(409).json({ error: 'That guild changed underneath you — reload and try again.' });
      guildRegistry.invalidate(g.discord_guild_id);
      audit(req, g.id, 'reactivate', {});
      res.json({ ok: true });
    } catch (err) {
      console.error('staff reactivate:', err.message);
      res.status(500).json({ error: 'Could not reactivate the guild.' });
    }
  });

  router.post('/:id/comp', async (req, res) => {
    const exempt = req.body && req.body.exempt;
    if (typeof exempt !== 'boolean') return res.status(400).json({ error: 'exempt must be true or false.' });
    try {
      const g = await load(req.params.id);
      if (!g) return res.status(404).json({ error: 'No such guild.' });
      const patch = { billing_exempt: exempt, updated_at: new Date().toISOString() };
      // Comping reopens a guild billing closed. A staff suspension stays.
      if (exempt && g.status === 'suspended' && g.suspended_reason === 'billing') {
        Object.assign(patch, { status: 'active', suspended_reason: null, suspended_at: null });
      }
      const { error } = await supabase.from('guilds').update(patch).eq('id', g.id);
      if (error) throw new Error(error.message);
      guildRegistry.invalidate(g.discord_guild_id);
      audit(req, g.id, exempt ? 'comp' : 'uncomp', {});
      res.json({ ok: true, reopened: patch.status === 'active' });
    } catch (err) {
      console.error('staff comp:', err.message);
      res.status(500).json({ error: 'Could not change billing for the guild.' });
    }
  });

  return router;
};
