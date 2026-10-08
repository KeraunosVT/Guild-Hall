import { useEffect, useState } from 'react';
import axios from 'axios';
import Button from './ui/Button';

// The guild's subscription, on Guild Settings. Read-only here: changing the
// card, seeing invoices and cancelling all happen in the payment provider's
// own portal, opened through a fresh one-time link (POST .../portal) because
// portal sessions are short-lived. A comped guild — one with no subscription,
// which is every guild created by hand — says so instead of offering a portal
// with nothing in it.

const LABELS = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Payment failed',
  paused: 'Paused',
  canceled: 'Cancelled',
};

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null);

export default function BillingPanel() {
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    axios.get('/api/admin/settings/billing')
      .then((r) => setBilling(r.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load billing.'));
  }, []);

  const openPortal = async () => {
    setOpening(true);
    setError('');
    try {
      const { data } = await axios.post('/api/admin/settings/billing/portal');
      window.location.href = data.url;
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open billing.');
      setOpening(false);
    }
  };

  const good = billing && (billing.status === 'trialing' || billing.status === 'active');

  return (
    <section id="billing" className="panel rounded-lg p-6 space-y-3 mt-6">
      <div className="eyebrow text-brass text-[10px]">Billing</div>
      {error && <div className="text-sm text-oxblood">{error}</div>}
      {!billing && !error && <div className="text-sm text-ash">Loading…</div>}

      {billing && billing.comped && (
        <p className="text-sm text-ash">This guild isn't billed — it was set up directly by Guild Hall.</p>
      )}

      {billing && !billing.comped && (
        <>
          <div className="flex items-center gap-3">
            <span className={`px-2.5 py-1 rounded-full text-xs border ${good ? 'border-brass/60 text-brassbright' : 'border-oxblood/60 text-oxblood'}`}>
              {LABELS[billing.status] || billing.status}
            </span>
            {billing.status === 'trialing' && fmtDate(billing.trial_ends_at) && (
              <span className="text-sm text-ash">Trial ends {fmtDate(billing.trial_ends_at)}</span>
            )}
            {billing.status === 'active' && fmtDate(billing.current_period_end) && (
              <span className="text-sm text-ash">Renews {fmtDate(billing.current_period_end)}</span>
            )}
          </div>
          {!good && billing.grace_until && (
            <p className="text-sm text-bone">
              The hall stays open until {fmtDate(billing.grace_until)}, then closes until the subscription is renewed.
              Nothing is deleted.
            </p>
          )}
          {billing.can_manage && (
            <Button size="sm" variant="secondary" onClick={openPortal} disabled={opening}>
              {opening ? 'Opening…' : 'Manage billing'}
            </Button>
          )}
          <p className="text-xs text-ash/70">Update your card, see invoices, or cancel. Payments are handled by Paddle, our reseller.</p>
        </>
      )}
    </section>
  );
}
