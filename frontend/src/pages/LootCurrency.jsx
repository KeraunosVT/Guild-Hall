import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { X, Coins, UserPlus, Pencil, Check } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';
import { fmtDatetime } from '../timeUtils';
import { CURRENCY_TYPES, CURRENCY_LABEL } from '../currencies';
import CurrencyIcon from '../components/ui/CurrencyIcon';

// Split out of LootTally.jsx's "Lucent & Shards" toggle panel so it's a real,
// linkable page under the Loot Council sidebar dropdown instead of a
// same-page toggle — this only ever touches members/currency-awards, never
// the loot catalog/tally data LootTally itself needs, so it's fully
// self-contained.
export default function LootCurrency() {
  const { user, can } = useAuth();
  const [members, setMembers] = useState([]);
  const [currencyAwards, setCurrencyAwards] = useState([]);
  const [currencyBusy, setCurrencyBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash(3500);

  const load = () => {
    Promise.all([axios.get('/api/admin/members'), axios.get('/api/admin/currency-awards')])
      .then(([mem, cur]) => {
        setMembers(mem.data.members || []);
        setCurrencyAwards(cur.data.awards || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the currency ledger.'));
  };
  useEffect(() => { load(); }, []);

  const currencyTotals = useMemo(() => {
    const m = {};
    currencyAwards.forEach((a) => {
      if (!m[a.discord_id]) m[a.discord_id] = { discord_id: a.discord_id, display_name: a.display_name, byType: {} };
      m[a.discord_id].byType[a.currency] = (m[a.discord_id].byType[a.currency] || 0) + a.amount;
      if (a.display_name) m[a.discord_id].display_name = a.display_name;
    });
    return Object.values(m).sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  }, [currencyAwards]);

  const giveCurrency = (discordId, currency, amount, reason) => {
    const member = members.find((m) => m.id === discordId);
    setCurrencyBusy(true);
    axios.post('/api/admin/currency-awards', { discord_id: discordId, display_name: member?.name, currency, amount, reason })
      .then(() => { load(); flash(`Gave ${amount.toLocaleString()} ${currency} to ${member?.name || 'member'}.`); })
      .catch((err) => flash(err.response?.data?.error || 'Failed to record grant.', false))
      .finally(() => setCurrencyBusy(false));
  };

  const revokeCurrency = (id) => {
    axios.delete(`/api/admin/currency-awards/${id}`).then(load).catch((err) => flash(err.response?.data?.error || 'Revoke failed.', false));
  };

  // Which grant is open for editing, and the in-progress values for it. Held
  // here rather than per-row so only one row can be mid-edit at a time.
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ currency: 'lucent', amount: '', reason: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  const startEdit = (a) => {
    setEditingId(a.id);
    setEdit({ currency: a.currency, amount: String(a.amount), reason: a.reason || '' });
  };
  const cancelEdit = () => { setEditingId(null); setSavingEdit(false); };

  const saveEdit = (id) => {
    const amt = parseInt(edit.amount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return flash('Amount must be a positive number.', false);
    setSavingEdit(true);
    axios.patch(`/api/admin/currency-awards/${id}`, { currency: edit.currency, amount: amt, reason: edit.reason })
      .then(() => { setEditingId(null); load(); flash('Grant updated.'); })
      .catch((err) => flash(err.response?.data?.error || 'Update failed.', false))
      .finally(() => setSavingEdit(false));
  };

  if (!can('loot.currency')) {
    return <RestrictedGate />;
  }

  return (
    <PageShell>
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}
      <Toast msg={msg} />

      <div className="panel rounded-lg p-6 space-y-6">
        <CurrencyGiveForm members={members} busy={currencyBusy} onGive={giveCurrency} />

        {currencyTotals.length > 0 && (
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Totals</label>
            <div className="panel rounded-lg divide-y divide-line">
              {currencyTotals.map((t) => (
                <div key={t.discord_id} className="flex items-center gap-3 px-4 py-2 text-sm flex-wrap">
                  <span className="text-bone w-36 shrink-0 truncate">{t.display_name || t.discord_id}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {CURRENCY_TYPES.filter((c) => t.byType[c.key]).map((c) => (
                      // Summary chips, so the icon keeps the grade backdrop but
                      // at pill scale — a full 36px box would be taller than
                      // the chip that contains it.
                      <span key={c.key} className="inline-flex items-center gap-1.5 text-xs bg-hall border border-line rounded-full pl-1 pr-2.5 py-0.5 text-ash">
                        <CurrencyIcon currency={c.key} size={20} />
                        {c.label} <span className="font-mono text-brassbright">{t.byType[c.key].toLocaleString()}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="eyebrow text-[10px] text-ash block mb-2">Recent grants</label>
          {currencyAwards.length === 0 ? (
            <p className="text-ash text-sm">Nothing given yet.</p>
          ) : (
            <div className="space-y-1.5 max-h-72 overflow-auto pr-1">
              {currencyAwards.map((a) => (editingId === a.id ? (
                <div key={a.id} className="flex flex-wrap items-center gap-2 bg-hall border border-brass/50 rounded-lg px-3 py-2 text-sm">
                  {/* Recipient is shown but not editable — see the PATCH route. */}
                  <span className="text-bone w-32 shrink-0 truncate" title="Recipient can't be changed — revoke and re-give instead">
                    {a.display_name || a.discord_id}
                  </span>
                  <input type="number" min={1} value={edit.amount} autoFocus
                    onChange={(e) => setEdit((p) => ({ ...p, amount: e.target.value }))}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass w-24" />
                  <select value={edit.currency} onChange={(e) => setEdit((p) => ({ ...p, currency: e.target.value }))}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass">
                    {CURRENCY_TYPES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                  <input type="text" value={edit.reason} maxLength={300} placeholder="Reason (optional)"
                    onChange={(e) => setEdit((p) => ({ ...p, reason: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(a.id); if (e.key === 'Escape') cancelEdit(); }}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass flex-1 min-w-[140px]" />
                  <button onClick={() => saveEdit(a.id)} disabled={savingEdit} className="text-brass hover:text-brassbright shrink-0 disabled:opacity-40" title="Save">
                    <Check className="w-4 h-4" />
                  </button>
                  <button onClick={cancelEdit} disabled={savingEdit} className="text-ash hover:text-bone shrink-0 disabled:opacity-40" title="Cancel">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div key={a.id} className="flex items-center gap-3 bg-hall border border-line rounded-lg px-3 py-2 text-sm">
                  <span className="text-bone w-32 shrink-0 truncate">{a.display_name || a.discord_id}</span>
                  <span className="font-mono text-brassbright shrink-0">{a.amount.toLocaleString()}</span>
                  <span className="text-ash text-xs w-36 shrink-0 truncate inline-flex items-center gap-2">
                    <CurrencyIcon currency={a.currency} />
                    {CURRENCY_LABEL[a.currency] || a.currency}
                  </span>
                  <span className={`text-xs flex-1 truncate ${a.reason ? 'text-ash/80 italic' : 'text-ash/30'}`} title={a.reason || ''}>
                    {a.reason || '—'}
                  </span>
                  <span className="text-ash/60 text-[10px] w-28 text-right shrink-0">{fmtDatetime(a.awarded_at)}</span>
                  <button onClick={() => startEdit(a)} className="text-ash hover:text-brass shrink-0" title="Edit">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => revokeCurrency(a.id)} className="text-ash hover:text-oxblood shrink-0" title="Revoke">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )))}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}

// Quick "give lucent/shards to a member" form — kept as its own component so its
// in-progress selection resets after each submit without touching page state.
function CurrencyGiveForm({ members, busy, onGive }) {
  const [memberId, setMemberId] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState('lucent');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || memberId) return [];
    return members.filter((m) => (m.name || '').toLowerCase().includes(q)).slice(0, 8);
  }, [query, memberId, members]);

  const pick = (m) => { setMemberId(m.id); setQuery(m.name); setOpen(false); };
  const clear = () => { setMemberId(''); setQuery(''); setOpen(false); };

  const onQueryChange = (e) => {
    setQuery(e.target.value);
    setOpen(true);
    if (memberId) setMemberId(''); // typing again invalidates the previous pick
  };

  const onQueryBlur = () => {
    // Give a suggestion's onClick a chance to register before we close/validate.
    setTimeout(() => {
      setOpen(false);
      if (memberId) return;
      const q = query.trim().toLowerCase();
      const exact = q && members.find((m) => (m.name || '').toLowerCase() === q);
      if (exact) { setMemberId(exact.id); setQuery(exact.name); }
      else setQuery(''); // unresolved text can't be sent as a target
    }, 150);
  };

  const onQueryKeyDown = (e) => {
    if (e.key === 'Enter' && suggestions.length > 0) { e.preventDefault(); pick(suggestions[0]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const submit = () => {
    const amt = parseInt(amount, 10);
    if (!memberId || !Number.isFinite(amt) || amt <= 0) return;
    onGive(memberId, currency, amt, reason.trim());
    // Member and currency stay put — grants tend to come in runs for the same
    // person or the same payout, so only the per-grant fields reset.
    setAmount(''); setReason('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[160px]">
        <input
          type="text" value={query} onChange={onQueryChange}
          onFocus={() => setOpen(true)} onBlur={onQueryBlur} onKeyDown={onQueryKeyDown}
          placeholder="Member…" autoComplete="off"
          className="w-full bg-hall border border-line rounded-lg pl-3 pr-8 py-2 text-sm text-bone focus:outline-none focus:border-brass"
        />
        {memberId && (
          <button type="button" onClick={clear} title="Clear"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ash hover:text-oxblood">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {open && suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 w-full bg-hall border border-line rounded-lg shadow-lg max-h-56 overflow-auto">
            {suggestions.map((m) => (
              <button
                key={m.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)}
                className="w-full text-left px-3 py-1.5 text-sm text-bone hover:bg-panelup transition-colors"
              >
                {m.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <select value={currency} onChange={(e) => setCurrency(e.target.value)}
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass">
        {CURRENCY_TYPES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      <input
        type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount"
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-28"
      />
      <input
        type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
        placeholder="Reason (optional)" title="Why this was given — e.g. raid payout, reimbursement, correction"
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass flex-1 min-w-[160px]"
      />
      <button type="button" onClick={submit} disabled={busy || !memberId || !amount}
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
        <Coins className="w-4 h-4" /> Give
      </button>
    </div>
  );
}
