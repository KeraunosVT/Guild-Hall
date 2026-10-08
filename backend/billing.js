'use strict';

// ── BILLING (Paddle) ─────────────────────────────────────────────────────────
// The only file that knows which payment provider we use. Paddle is the
// merchant of record: it is the legal seller, so it handles sales tax and VAT,
// and it owns checkout, card storage, renewals and the customer portal. What
// lives here is the mirror of that state we need to decide who gets a guild:
//
//   · the webhook, which records every subscription change in `subscriptions`
//     through billing_apply_subscription() (migrations/saas_014);
//   · the seat lookup onboarding uses to decide whether someone has paid;
//   · the sweep that suspends a guild once its grace period runs out;
//   · the plan (price + trial) the landing and setup pages display, read from
//     Paddle so the price is never hard-coded here;
//   · the customer-portal link officers use to manage or cancel.
//
// Swapping to another merchant of record means rewriting this file and nothing
// else: everything outside it speaks in seats, statuses and portal URLs.

const crypto = require('crypto');
const express = require('express');
const guildRegistry = require('./guildRegistry');

const GOOD_STANDING = new Set(['trialing', 'active']);
const STATUSES = new Set(['trialing', 'active', 'past_due', 'paused', 'canceled']);

// ── Webhook signature ───────────────────────────────────────────────────────
// Paddle-Signature: ts=1671552777;h1=<hex>  (more than one h1 while a secret
// is being rotated). The signed string is `${ts}:${rawBody}`, HMAC-SHA256 with
// the notification destination's secret. The body must be the exact bytes
// Paddle sent — which is why the webhook is mounted with express.raw ahead of
// the app's JSON parser.
//
// Paddle's own default tolerance is 5 seconds. We allow more because a retry
// queued behind a slow handler can legitimately arrive later than that, and
// replay is already harmless: billing_events dedupes on event_id.
function verifySignature(rawBody, header, secret, { nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300 } = {}) {
  if (!secret || !header || rawBody == null) return false;
  const parts = String(header).split(';').map((p) => p.trim().split('='));
  const ts = (parts.find(([k]) => k === 'ts') || [])[1];
  const sigs = parts.filter(([k, v]) => k === 'h1' && v).map(([, v]) => v);
  if (!ts || !/^\d+$/.test(ts) || !sigs.length) return false;
  if (Math.abs(nowSec - Number(ts)) > toleranceSec) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${ts}:`, 'utf8'), body]))
    .digest();
  return sigs.some((hex) => {
    if (!/^[0-9a-f]+$/i.test(hex)) return false;
    const got = Buffer.from(hex, 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

// ── Event → the fields we keep ──────────────────────────────────────────────
// Returns null for anything that isn't a usable subscription event.
function normalizeSubscription(event) {
  if (!event || typeof event.event_type !== 'string' || !event.event_type.startsWith('subscription.')) return null;
  const d = event.data || {};
  if (!d.id || !STATUSES.has(d.status)) return null;

  // A subscription's trial lives on its items. Our plan has one item, but take
  // the latest end in case a second is ever added.
  const trialEnds = (Array.isArray(d.items) ? d.items : [])
    .map((i) => i && i.trial_dates && i.trial_dates.ends_at)
    .filter(Boolean)
    .sort()
    .pop() || null;

  const custom = d.custom_data && typeof d.custom_data === 'object' ? d.custom_data : {};
  const discordUserId = /^\d{17,20}$/.test(String(custom.discord_user_id || '')) ? String(custom.discord_user_id) : null;

  return {
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: event.occurred_at || null,
    subscriptionId: d.id,
    customerId: d.customer_id || null,
    discordUserId,
    status: d.status,
    trialEndsAt: trialEnds,
    periodEnd: (d.current_billing_period && d.current_billing_period.ends_at) || null,
  };
}

function createBilling(supabase, {
  env = process.env,
  fetchImpl = (...a) => fetch(...a),
  onGuildChanged = (discordGuildId) => guildRegistry.invalidate(discordGuildId),
} = {}) {
  const API_KEY = env.PADDLE_API_KEY || '';
  const WEBHOOK_SECRET = env.PADDLE_WEBHOOK_SECRET || '';
  const PRICE_ID = env.PADDLE_PRICE_ID || '';
  const CLIENT_TOKEN = env.PADDLE_CLIENT_TOKEN || '';
  // Sandbox unless production is named explicitly — a missing variable should
  // never be what sends a real charge.
  const ENVIRONMENT = env.PADDLE_ENV === 'production' ? 'production' : 'sandbox';
  const API = ENVIRONMENT === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
  const GRACE_DAYS = parseInt(env.BILLING_GRACE_DAYS, 10) || 7;
  const TOLERANCE = parseInt(env.PADDLE_WEBHOOK_TOLERANCE_SECONDS, 10) || 300;
  const SWEEP_MS = 10 * 60 * 1000;

  const configured = Boolean(API_KEY && WEBHOOK_SECRET && PRICE_ID && CLIENT_TOKEN);

  async function paddle(method, path, body) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (json && json.error && (json.error.detail || json.error.code)) || `HTTP ${res.status}`;
      throw new Error(`Paddle ${method} ${path} failed: ${detail}`);
    }
    return json;
  }

  // ── The plan, for display ─────────────────────────────────────────────────
  // Cached: it's on the landing page, and prices change about never.
  //
  // NEVER the thing that stops a signup. Checkout itself only needs the price
  // id and client token, which are config — the API call is just for showing
  // the amount. So when Paddle can't be reached (an outage, an expired or
  // revoked key), this serves the last price it did load, or failing that a
  // plan with no amount, and checkout still opens and shows the price itself.
  // Either way it's marked `stale`, and health() reports the failure so the
  // uptime monitor still catches it — degraded, not silent.
  let planCache = null;
  let lastError = null; // { message, since } while Paddle is failing
  async function plan() {
    if (!configured) return null;
    if (planCache && Date.now() - planCache.at < 10 * 60 * 1000) return planCache.value;
    let data;
    try {
      ({ data } = await paddle('GET', `/prices/${encodeURIComponent(PRICE_ID)}`));
    } catch (err) {
      if (!lastError) lastError = { message: err.message, since: new Date().toISOString() };
      console.error(`billing plan: ${err.message} — serving ${planCache ? 'the last known price' : 'checkout without a displayed price'}.`);
      return planCache
        ? { ...planCache.value, stale: true }
        : {
          priceId: PRICE_ID, clientToken: CLIENT_TOKEN, environment: ENVIRONMENT,
          amount: null, currency: null, interval: null, frequency: null, trial: null, stale: true,
        };
    }
    lastError = null;
    const value = {
      priceId: PRICE_ID,
      clientToken: CLIENT_TOKEN,
      environment: ENVIRONMENT,
      amount: data.unit_price ? Number(data.unit_price.amount) : null, // lowest denomination
      currency: data.unit_price ? data.unit_price.currency_code : null,
      interval: data.billing_cycle ? data.billing_cycle.interval : null,
      frequency: data.billing_cycle ? data.billing_cycle.frequency : null,
      trial: data.trial_period ? { interval: data.trial_period.interval, frequency: data.trial_period.frequency } : null,
    };
    planCache = { value, at: Date.now() };
    return value;
  }

  // Can we talk to Paddle right now? For the uptime monitor on
  // /api/billing/status: plan() above degrades gracefully, so its own
  // endpoint stays 200 even with a dead key — this is what turns red instead.
  async function health() {
    if (!configured) return { ok: false, error: 'Billing is not configured.' };
    await plan();
    return lastError ? { ok: false, error: lastError.message, since: lastError.since } : { ok: true };
  }

  // ── Seats ─────────────────────────────────────────────────────────────────
  // An unclaimed subscription in good standing that this Discord user paid
  // for. Onboarding asks this to decide whether to show checkout or move on.
  async function unclaimedSeat(discordUserId) {
    if (!supabase || !discordUserId) return null;
    const { data, error } = await supabase.from('subscriptions')
      .select('id, status, trial_ends_at, current_period_end')
      .eq('discord_user_id', String(discordUserId))
      .is('guild_id', null)
      .in('status', [...GOOD_STANDING])
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`seat lookup failed: ${error.message}`);
    return data || null;
  }

  // What the officer billing panel shows. null means the guild is comped (no
  // subscription), which the panel says rather than offering a portal.
  async function forGuild(guildId) {
    if (!supabase || !guildId) return null;
    // A guild staff comped (saas_015) is shown as comped whatever its
    // subscription says — otherwise its officers would get lapse warnings
    // for a hall that will never close.
    const { data: g, error: gErr } = await supabase.from('guilds')
      .select('billing_exempt').eq('id', guildId).maybeSingle();
    if (gErr) throw new Error(`guild lookup failed: ${gErr.message}`);
    if (g && g.billing_exempt) return null;
    const { data, error } = await supabase.from('subscriptions')
      .select('status, trial_ends_at, current_period_end, grace_until, provider_customer_id')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (error) throw new Error(`subscription lookup failed: ${error.message}`);
    return data || null;
  }

  // A short-lived link into Paddle's customer portal. Never cached: Paddle
  // says portal sessions are temporary.
  async function portalUrl(customerId) {
    if (!configured) throw new Error('Billing is not configured.');
    if (!/^ctm_[a-z\d]{26}$/.test(String(customerId || ''))) throw new Error('No billing customer on file for this guild.');
    const { data } = await paddle('POST', `/customers/${customerId}/portal-sessions`, {});
    const url = data && data.urls && data.urls.general && data.urls.general.overview;
    if (!url) throw new Error('Paddle returned no portal link.');
    return url;
  }

  // ── Webhook ───────────────────────────────────────────────────────────────
  // 401 on a bad signature, 500 when our database fails (so Paddle retries),
  // and 200 for everything else — including events we don't act on, which
  // would otherwise be retried for days.
  async function handleWebhook(req, res) {
    if (!WEBHOOK_SECRET || !supabase) return res.status(503).json({ error: 'Billing is not configured.' });
    if (!verifySignature(req.body, req.get('Paddle-Signature'), WEBHOOK_SECRET, { toleranceSec: TOLERANCE })) {
      return res.status(401).json({ error: 'Bad signature.' });
    }

    let event;
    try { event = JSON.parse(req.body.toString('utf8')); } catch {
      return res.status(400).json({ error: 'Bad JSON.' });
    }

    const sub = normalizeSubscription(event);
    if (!sub) {
      // Recorded for the audit trail, never acted on.
      if (event && event.event_id) {
        const { error } = await supabase.from('billing_events').insert({
          event_id: String(event.event_id),
          type: String(event.event_type || 'unknown'),
          occurred_at: event.occurred_at || null,
          payload: event,
        });
        // 23505: already recorded — a retry of an event we have. Not an error.
        if (error && error.code !== '23505') {
          console.error('billing webhook: record failed:', error.message);
          return res.status(500).json({ error: 'Could not record event.' });
        }
      }
      return res.json({ ok: true, ignored: true });
    }

    if (sub.eventType === 'subscription.created' && !sub.discordUserId) {
      // A subscription made outside our checkout (e.g. in Paddle's dashboard)
      // has no buyer to give the seat to. Still recorded, so staff can attach it.
      console.warn(`billing webhook: ${sub.subscriptionId} has no discord_user_id — the seat can't be claimed until staff attach it.`);
    }

    const { data, error } = await supabase.rpc('billing_apply_subscription', {
      p_event_id: String(sub.eventId),
      p_event_type: sub.eventType,
      p_occurred_at: sub.occurredAt,
      p_payload: event,
      p_subscription_id: sub.subscriptionId,
      p_customer_id: sub.customerId,
      p_discord_user_id: sub.discordUserId,
      p_status: sub.status,
      p_trial_ends_at: sub.trialEndsAt,
      p_period_end: sub.periodEnd,
      p_grace_days: GRACE_DAYS,
    });
    if (error) {
      console.error('billing webhook: apply failed:', error.message);
      return res.status(500).json({ error: 'Could not apply event.' });
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (row && row.discord_guild_id) onGuildChanged(row.discord_guild_id);
    return res.json({ ok: true, result: row ? row.result : null });
  }

  // Mounted in server.js BEFORE express.json(): the signature is over the raw
  // bytes, and a parsed-then-restringified body would never match.
  function webhookRouter() {
    const router = express.Router();
    // For the uptime monitor: 200 when Paddle answers, 503 when it doesn't.
    // The error is Paddle's own message ("authentication_malformed", …),
    // never the key.
    router.get('/status', (req, res) => {
      health().then((h) => res.status(h.ok ? 200 : 503).json(h))
        .catch((err) => res.status(503).json({ ok: false, error: err.message }));
    });
    router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
      handleWebhook(req, res).catch((err) => {
        console.error('billing webhook error:', err.message);
        res.status(500).json({ error: 'Webhook failed.' });
      });
    });
    return router;
  }

  // ── Lapse sweep ───────────────────────────────────────────────────────────
  async function suspendLapsed() {
    if (!supabase) return [];
    const { data, error } = await supabase.rpc('billing_suspend_lapsed');
    if (error) throw new Error(`lapse sweep failed: ${error.message}`);
    const ids = (data || []).map((r) => r.discord_guild_id).filter(Boolean);
    ids.forEach((id) => onGuildChanged(id));
    if (ids.length) console.log(`Billing: suspended ${ids.length} guild(s) past their grace period.`);
    return ids;
  }

  let sweepTimer = null;
  function startSweep() {
    if (sweepTimer || !supabase) return;
    const run = () => suspendLapsed().catch((err) => console.error(err.message));
    sweepTimer = setInterval(run, SWEEP_MS);
    if (sweepTimer.unref) sweepTimer.unref();
    run();
  }

  return {
    configured, environment: ENVIRONMENT, graceDays: GRACE_DAYS,
    plan, health, unclaimedSeat, forGuild, portalUrl,
    handleWebhook, webhookRouter, suspendLapsed, startSweep,
  };
}

module.exports = createBilling;
module.exports.verifySignature = verifySignature;
module.exports.normalizeSubscription = normalizeSubscription;
module.exports.GOOD_STANDING = GOOD_STANDING;
