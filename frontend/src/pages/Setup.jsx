import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import Lockup from '../components/Lockup';
import Button from '../components/ui/Button';

// ── /setup — add your guild ──────────────────────────────────────────────────
// Public: the person here has no guild yet, so no session either. The server
// (backend/onboarding.js) owns every decision; this page only shows whichever
// step /api/onboard/state says they're on:
//
//   1. sign in with Discord   2. pay (Paddle checkout)   3. add the bot
//   4. the basics → the guild is created and they go through normal sign-in
//
// Paying comes before the bot on purpose: a guild only ever exists for a seat
// someone has paid for.

const ERRORS = {
  unavailable: "Signups aren't open yet. Check back soon.",
  closed: "Signups aren't open to everyone yet — we're letting guilds in a few at a time. Check back soon.",
  signin: 'Your setup session expired. Sign in with Discord again to continue.',
  signin_cancelled: 'Sign-in was cancelled on Discord.',
  unpaid: 'Start your subscription first, then add the bot.',
  bot_cancelled: 'The bot wasn\'t added. Pick your server on Discord\'s screen and press Authorize.',
  not_manager: 'You need the Manage Server permission in that Discord server to add Guild Hall to it.',
  wrong_account: 'Add the bot with the same Discord account you paid with.',
  already_registered: 'That Discord server already has a Guild Hall. Sign in to it instead, or pick another server.',
  state: 'That step expired or was interrupted. Please try again — and check your browser isn\'t blocking cookies for this site.',
  discord: 'Discord didn\'t answer as expected. Please try again.',
  error: 'Something went wrong on our side. Please try again.',
};

function formatPrice(plan) {
  if (!plan || plan.amount == null || !plan.currency) return null;
  const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits;
  const price = fmt.format(plan.amount / 10 ** digits);
  const every = plan.frequency > 1 ? `${plan.frequency} ${plan.interval}s` : plan.interval;
  return `${price} / ${every}`;
}

function formatTrial(plan) {
  const t = plan && plan.trial;
  if (!t) return null;
  return `${t.frequency}-${t.interval} free trial`;
}

// Paddle.js has to come from Paddle's CDN (their rule, and the CSP allows it).
let paddleLoading = null;
function loadPaddle() {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  if (!paddleLoading) {
    paddleLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      s.onload = () => resolve(window.Paddle);
      s.onerror = () => { paddleLoading = null; reject(new Error('Could not load checkout.')); };
      document.head.appendChild(s);
    });
  }
  return paddleLoading;
}

const TIMEZONES = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'UTC']; }
})();
const guessZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch { return 'America/New_York'; } };

function StepDot({ n, state }) {
  const cls = state === 'done'
    ? 'bg-brass text-ink border-brass'
    : state === 'current' ? 'border-brass text-brassbright' : 'border-line text-ash';
  return <span className={`w-7 h-7 rounded-full border flex items-center justify-center text-xs font-semibold shrink-0 ${cls}`}>{state === 'done' ? '✓' : n}</span>;
}

function Steps({ current }) {
  const labels = ['Sign in', 'Subscribe', 'Add the bot', 'Your guild'];
  return (
    <ol className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mb-10">
      {labels.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={label} className="flex items-center gap-2 text-sm">
            <StepDot n={i + 1} state={state} />
            <span className={state === 'todo' ? 'text-ash' : 'text-bone'}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

const Card = ({ children }) => (
  <div className="w-full max-w-xl bg-panel border border-line rounded-xl p-6 md:p-8 text-left">{children}</div>
);

export default function Setup() {
  const [state, setState] = useState(null);
  const [plan, setPlan] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(() => ERRORS[new URLSearchParams(window.location.search).get('error')] || '');
  const [confirming, setConfirming] = useState(false);
  const pollTimer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/onboard/state');
      setState(data);
      setLoadError('');
      return data;
    } catch (err) {
      setLoadError(err.response?.data?.error || 'Could not load your setup.');
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
    axios.get('/api/onboard/plan').then((r) => setPlan(r.data)).catch(() => setPlan(null));
    // Clear ?error= so a refresh doesn't keep showing an old problem.
    if (window.location.search) window.history.replaceState(null, '', '/setup');
    return () => clearInterval(pollTimer.current);
  }, [refresh]);

  // After checkout, the seat arrives by webhook — usually within seconds.
  const waitForSeat = useCallback(() => {
    setConfirming(true);
    const started = Date.now();
    clearInterval(pollTimer.current);
    pollTimer.current = setInterval(async () => {
      const s = await refresh();
      if (s && s.seat) { clearInterval(pollTimer.current); setConfirming(false); }
      else if (Date.now() - started > 90_000) {
        clearInterval(pollTimer.current);
        setConfirming(false);
        setNotice('Your payment went through, but confirmation is taking longer than usual. Refresh this page in a minute — nothing is lost.');
      }
    }, 2000);
  }, [refresh]);

  const openCheckout = async () => {
    setNotice('');
    try {
      const Paddle = await loadPaddle();
      if (plan.environment === 'sandbox') Paddle.Environment.set('sandbox');
      Paddle.Initialize({
        token: plan.clientToken,
        eventCallback: (e) => { if (e && e.name === 'checkout.completed') waitForSeat(); },
      });
      Paddle.Checkout.open({
        items: [{ priceId: plan.priceId, quantity: 1 }],
        // Ties the subscription to this Discord account — it's how the
        // webhook knows whose seat it is.
        customData: { discord_user_id: state.user.id },
        settings: { displayMode: 'overlay' },
      });
    } catch (err) {
      setNotice(err.message || 'Could not open checkout.');
    }
  };

  const step = !state || !state.signedIn ? 0 : !state.seat ? 1 : !state.server ? 2 : 3;

  return (
    <div className="min-h-screen bg-ink text-bone flex flex-col items-center px-4 py-12">
      <a href="/landing" className="mb-8"><Lockup className="w-[220px] h-auto" /></a>
      <h1 className="font-display text-2xl tracking-[0.08em] text-brassbright mb-2 text-center">Add your guild</h1>
      <p className="text-ash text-sm mb-8 text-center max-w-md">
        A few minutes from here to your guild's own hall: rosters, attendance, loot and war records, signed in with Discord.
      </p>

      {state && state.available !== false && <Steps current={step} />}

      {notice && (
        <div className="w-full max-w-xl mb-6 px-5 py-3 border border-oxblood/50 bg-oxblooddeep/20 rounded-lg text-sm">{notice}</div>
      )}

      {!state && !loadError && <div className="text-ash text-sm">Loading…</div>}
      {loadError && <Card><p className="text-sm">{loadError}</p><Button className="mt-4" size="sm" onClick={refresh}>Try again</Button></Card>}

      {state && state.available === false && (
        <Card>
          <p className="text-bone">Signups aren't open yet.</p>
          <p className="text-ash text-sm mt-2">We're getting the doors ready. Check back soon.</p>
        </Card>
      )}

      {state && state.available !== false && step === 0 && (
        <Card>
          <h2 className="font-display tracking-[0.06em] text-lg mb-2">Sign in with Discord</h2>
          <p className="text-ash text-sm mb-6">We only read your Discord name and avatar for this step. Your subscription is tied to this account.</p>
          <Button as="a" href="/api/onboard/start" className="!bg-[#5865F2] hover:!bg-[#4752c4] !text-white">Sign in with Discord</Button>
        </Card>
      )}

      {state && step === 1 && (
        <Card>
          <h2 className="font-display tracking-[0.06em] text-lg mb-1">Start your subscription</h2>
          <p className="text-ash text-sm mb-5">Signed in as <span className="text-bone">{state.user.username}</span>.</p>
          {plan ? (
            <>
              <div className="flex items-baseline gap-3 mb-1">
                <span className="text-3xl font-display text-brassbright">{formatPrice(plan)}</span>
                <span className="text-ash text-sm">per guild</span>
              </div>
              {formatTrial(plan) && (
                <p className="text-sm text-bone mb-4">
                  {formatTrial(plan)} — you won't be charged until it ends, and you can cancel any time before then.
                </p>
              )}
              <ul className="text-sm text-ash space-y-1 mb-6 list-disc pl-5">
                <li>Every feature, for every member of your guild</li>
                <li>Cancel any time from your guild's settings</li>
                <li>Payments handled by Paddle, our reseller</li>
              </ul>
              <Button onClick={openCheckout} disabled={confirming}>
                {confirming ? 'Confirming your payment…' : (plan.trial ? 'Start free trial' : 'Subscribe')}
              </Button>
            </>
          ) : (
            <p className="text-sm text-ash">Pricing is unavailable right now. Please try again shortly.</p>
          )}
        </Card>
      )}

      {state && step === 2 && (
        <Card>
          <h2 className="font-display tracking-[0.06em] text-lg mb-2">Add Guild Hall to your Discord server</h2>
          <p className="text-ash text-sm mb-2">
            Your subscription is {state.seat.status === 'trialing' ? 'in its free trial' : 'active'}. Next, pick the
            Discord server your guild uses.
          </p>
          <p className="text-ash text-sm mb-6">You'll need the <span className="text-bone">Manage Server</span> permission there.</p>
          <Button as="a" href="/api/onboard/bot">Add the bot</Button>
        </Card>
      )}

      {state && step === 3 && <BasicsForm state={state} onRefresh={refresh} onNotice={setNotice} />}

      <div className="mt-10 flex gap-5 text-xs text-ash/70">
        <a href="/landing" className="hover:text-brassbright">Home</a>
        <a href="/privacy" className="hover:text-brassbright">Privacy</a>
        <a href="/terms" className="hover:text-brassbright">Terms</a>
      </div>
    </div>
  );
}

function BasicsForm({ state, onRefresh, onNotice }) {
  const { server } = state;
  const held = useMemo(() => new Set(server.heldRoleIds), [server.heldRoleIds]);
  const [form, setForm] = useState(() => ({
    house: server.name || '',
    tag: '',
    timezone: guessZone(),
    day_start: '01:00',
    admin_role_ids: server.roles.filter((r) => held.has(r.id)).slice(0, 1).map((r) => r.id),
    allowed_role_ids: [],
    accept_terms: false,
  }));
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const toggle = (k, id) => setForm((f) => ({
    ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id],
  }));

  const submit = async (e) => {
    e.preventDefault();
    onNotice('');
    setSaving(true);
    try {
      const { data } = await axios.post('/api/onboard/complete', form);
      window.location.href = data.next || '/api/auth/login';
    } catch (err) {
      onNotice(err.response?.data?.error || 'Could not create your guild.');
      setSaving(false);
    }
  };

  if (!server.botPresent) {
    return (
      <Card>
        <p className="text-bone">The Guild Hall bot isn't in <span className="text-brassbright">{server.name || 'that server'}</span>.</p>
        <p className="text-ash text-sm mt-2 mb-5">It may have been removed. Add it again to continue.</p>
        <Button as="a" href="/api/onboard/bot">Add the bot</Button>
      </Card>
    );
  }

  const noRoles = held.size === 0;
  const officerOk = form.admin_role_ids.some((id) => held.has(id));
  const input = 'w-full bg-ink border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brass';

  return (
    <Card>
      <form onSubmit={submit} className="space-y-5">
        <div>
          <h2 className="font-display tracking-[0.06em] text-lg">Your guild</h2>
          <p className="text-ash text-sm">On <span className="text-bone">{server.name}</span>. Everything here can be changed later in Guild Settings.</p>
        </div>

        <label className="block">
          <span className="text-sm text-bone">Guild name</span>
          <input className={input} value={form.house} onChange={set('house')} maxLength={120} required />
        </label>

        <label className="block">
          <span className="text-sm text-bone">In-game tag</span>
          <span className="block text-xs text-ash mb-1">Exactly as it appears on match scoreboards — that's how war records find your members.</span>
          <input className={input} value={form.tag} onChange={set('tag')} maxLength={32} required />
        </label>

        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm text-bone">Timezone</span>
            <select className={input} value={form.timezone} onChange={set('timezone')}>
              {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm text-bone">Guild night ends at</span>
            <input className={input} type="time" value={form.day_start} onChange={set('day_start')} required />
          </label>
        </div>

        <fieldset>
          <legend className="text-sm text-bone">Officer roles</legend>
          <span className="block text-xs text-ash mb-2">Officers can manage the guild in Guild Hall. Pick at least one you hold.</span>
          {noRoles ? (
            <div className="text-sm px-4 py-3 border border-oxblood/50 bg-oxblooddeep/20 rounded-lg">
              You don't hold any roles in this server. In Discord, create a role for your officers (for example
              "Officer"), give it to yourself, then{' '}
              <button type="button" onClick={onRefresh} className="text-brassbright underline">refresh</button>.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {server.roles.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => toggle('admin_role_ids', r.id)}
                  className={`px-3 py-1.5 rounded-full border text-sm ${form.admin_role_ids.includes(r.id) ? 'border-brass bg-brass/15 text-brassbright' : 'border-line text-ash hover:text-bone'}`}
                >
                  {r.name}{held.has(r.id) ? ' · you' : ''}
                </button>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend className="text-sm text-bone">Who can sign in <span className="text-ash">(optional)</span></legend>
          <span className="block text-xs text-ash mb-2">Leave empty to let anyone in your Discord server sign in. Pick roles to limit it to members holding them.</span>
          <div className="flex flex-wrap gap-2">
            {server.roles.map((r) => (
              <button
                type="button"
                key={r.id}
                onClick={() => toggle('allowed_role_ids', r.id)}
                className={`px-3 py-1.5 rounded-full border text-sm ${form.allowed_role_ids.includes(r.id) ? 'border-brass bg-brass/15 text-brassbright' : 'border-line text-ash hover:text-bone'}`}
              >
                {r.name}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={form.accept_terms} onChange={set('accept_terms')} className="mt-1" />
          <span className="text-ash">
            I accept the <a href="/terms" target="_blank" rel="noreferrer" className="text-brassbright underline">Terms of Service</a> and{' '}
            <a href="/privacy" target="_blank" rel="noreferrer" className="text-brassbright underline">Privacy Policy</a> on behalf of my guild.
          </span>
        </label>

        <Button type="submit" disabled={saving || noRoles || !officerOk || !form.accept_terms || !form.tag.trim() || !form.house.trim()}>
          {saving ? 'Opening your hall…' : 'Create my guild'}
        </Button>
      </form>
    </Card>
  );
}
