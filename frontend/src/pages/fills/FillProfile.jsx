import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Plus, X } from 'lucide-react';
import Button from '../../components/ui/Button';
import Toast from '../../components/ui/Toast';
import { useFlash } from '../../components/ui/useFlash';
import { TIMEZONE_OPTIONS } from '../../timeUtils';
import {
  ROLES, WEEKDAYS, CLASS_LIST, inputClass, labelClass, errorOf, browserTimezone,
  useThreatGuilds, GuildOptions, GuildName,
} from './shared';

// A player's listing in the fill pool. Everything here is what a leader sees
// when deciding whom to invite — except the home guild and "won't fill
// against" list, which are used to keep the player OUT of pools they shouldn't
// be in, and are never shown to the guild in question.

function initialDraft(me) {
  const p = me.profile;
  if (p) {
    return {
      active: p.active, role: p.role, classes: p.classes || [], gear: p.gear ?? '',
      timezone: p.timezone, windows: p.windows || [], home_guild_id: p.home_guild_id || '',
      avoid_guild_ids: p.avoid_guild_ids || [], notes: p.notes || '',
    };
  }
  const s = me.suggestion;
  return {
    active: true,
    role: s?.role || 'DPS',
    classes: s?.classes || [],
    gear: s?.gear ?? '',
    timezone: browserTimezone(),
    windows: [{ d: 6, from: '19:00', to: '23:00' }],
    home_guild_id: '',
    avoid_guild_ids: [],
    notes: '',
  };
}

export default function FillProfile({ me, onSaved }) {
  const board = useThreatGuilds();
  const [draft, setDraft] = useState(() => initialDraft(me));
  const [saving, setSaving] = useState(false);
  const [msg, flash] = useFlash();
  useEffect(() => { setDraft(initialDraft(me)); }, [me]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const byId = useMemo(() => new Map(board.guilds.map((g) => [g.id, g])), [board.guilds]);
  const tzOptions = useMemo(() => {
    const list = [...TIMEZONE_OPTIONS];
    if (!list.some((o) => o.value === draft.timezone)) list.unshift({ value: draft.timezone, label: draft.timezone });
    return list;
  }, [draft.timezone]);

  const save = async (patch = {}) => {
    setSaving(true);
    try {
      const body = { ...draft, ...patch, gear: draft.gear === '' ? null : Number(draft.gear), home_guild_id: draft.home_guild_id || null };
      await axios.put('/api/fills/me', body);
      flash(body.active ? 'Saved. Leaders can find you in the fill pool.' : 'Saved. You are paused and hidden from every pool.');
      onSaved?.();
    } catch (e) {
      flash(errorOf(e, 'Could not save your profile.'), false);
    } finally {
      setSaving(false);
    }
  };

  const setWindow = (i, patch) => set({ windows: draft.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const listed = !!me.profile;

  return (
    <div className="space-y-6">
      {me.suggestion && !listed && (
        <p className="text-sm text-ash">
          Started from what <span className="text-bone">{me.suggestion.from}</span> has on file for you. Check it and save to list yourself.
        </p>
      )}
      <Toast msg={msg} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button" role="switch" aria-checked={draft.active}
          onClick={() => set({ active: !draft.active })}
          className="inline-flex items-center gap-3"
        >
          <span className={`relative w-10 h-6 rounded-full transition-colors ${draft.active ? 'bg-emerald-500' : 'bg-line'}`}>
            <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-panel shadow transition-transform ${draft.active ? 'translate-x-4' : ''}`} />
          </span>
          <span className="text-sm">{draft.active ? 'Listed: leaders can find you' : 'Paused: hidden from every pool'}</span>
        </button>
        {!listed && <span className="text-xs text-ash">Not listed yet — nothing is visible until you save.</span>}
      </div>

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        <section className="panel rounded-lg p-5 space-y-4">
          <h2 className="font-display tracking-wide">What you play</h2>
          <div>
            <label className={labelClass} htmlFor="fp-role">Role</label>
            <select id="fp-role" className={inputClass} value={draft.role} onChange={(e) => set({ role: e.target.value })}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <span className={labelClass}>Classes (up to 3)</span>
            <div className="flex flex-wrap items-center gap-2">
              {draft.classes.map((c) => (
                <span key={c} className="inline-flex items-center gap-1 pl-3 pr-1 py-1 rounded-full bg-panelup border border-line text-sm">
                  {c}
                  <button type="button" aria-label={`Remove ${c}`} className="p-0.5 text-ash hover:text-bone" onClick={() => set({ classes: draft.classes.filter((x) => x !== c) })}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
              {draft.classes.length < 3 && (
                <select
                  aria-label="Add a class" value="" className={`${inputClass} w-auto`}
                  onChange={(e) => e.target.value && set({ classes: [...draft.classes, e.target.value] })}
                >
                  <option value="">Add class…</option>
                  {CLASS_LIST.filter((c) => !draft.classes.includes(c)).map((c) => <option key={c}>{c}</option>)}
                </select>
              )}
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="fp-gear">Gear level</label>
            <input id="fp-gear" type="number" min="0" className={`${inputClass} tabular-nums`} value={draft.gear}
              onChange={(e) => set({ gear: e.target.value })} placeholder="e.g. your average gear level" />
          </div>
          <div>
            <label className={labelClass} htmlFor="fp-notes">Note for leaders</label>
            <input id="fp-notes" type="text" maxLength={300} className={inputClass} value={draft.notes}
              onChange={(e) => set({ notes: e.target.value })} placeholder="Voice, experience, anything a leader should know" />
          </div>
        </section>

        <section className="panel rounded-lg p-5 space-y-4">
          <h2 className="font-display tracking-wide">When you can fill</h2>
          <div>
            <label className={labelClass} htmlFor="fp-tz">Your timezone</label>
            <select id="fp-tz" className={inputClass} value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {tzOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            {draft.windows.length === 0 && (
              <p className="text-sm text-ash">No windows yet. Leaders filtering by availability won&apos;t see you.</p>
            )}
            {draft.windows.map((w, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-2">
                <select aria-label="Day" className={inputClass} value={w.d} onChange={(e) => setWindow(i, { d: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, j) => <option key={d} value={j}>{d}</option>)}
                </select>
                <input aria-label="From" type="time" className={inputClass} value={w.from} onChange={(e) => setWindow(i, { from: e.target.value })} />
                <span className="text-ash text-xs">to</span>
                <input aria-label="To" type="time" className={inputClass} value={w.to} onChange={(e) => setWindow(i, { to: e.target.value })} />
                <button type="button" aria-label="Remove window" className="p-2 text-ash hover:text-oxblood"
                  onClick={() => set({ windows: draft.windows.filter((_, j) => j !== i) })}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            <Button type="button" variant="ghost" size="none" className="text-sm" icon={<Plus className="w-4 h-4" />}
              onClick={() => set({ windows: [...draft.windows, { d: 6, from: '19:00', to: '23:00' }] })}>
              Add a time window
            </Button>
          </div>

          <div>
            <label className={labelClass} htmlFor="fp-home">Home guild</label>
            <select id="fp-home" className={inputClass} value={draft.home_guild_id}
              onChange={(e) => {
                const next = e.target.value;
                // Your own guild is always on the "won't fill against" list.
                const avoid = draft.avoid_guild_ids.filter((id) => id !== draft.home_guild_id);
                set({ home_guild_id: next, avoid_guild_ids: next && !avoid.includes(next) ? [next, ...avoid] : avoid });
              }}>
              <option value="">No guild (free agent)</option>
              <GuildOptions guilds={board.guilds} clusters={board.clusters} />
            </select>
            <p className="text-xs text-ash mt-1.5">
              You&apos;re never shown to leaders wargaming against your home guild or its allies.
            </p>
          </div>

          <div>
            <span className={labelClass}>Won&apos;t fill against</span>
            <div className="flex flex-wrap items-center gap-2">
              {draft.avoid_guild_ids.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 pl-3 pr-1 py-1 rounded-full bg-panelup border border-line text-sm">
                  <GuildName guild={byId.get(id)} fallback="Guild no longer on the board" />
                  <button type="button" aria-label="Remove" className="p-0.5 text-ash hover:text-bone"
                    onClick={() => set({ avoid_guild_ids: draft.avoid_guild_ids.filter((x) => x !== id) })}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
              <select aria-label="Add a guild" value="" className={`${inputClass} w-auto`}
                onChange={(e) => e.target.value && set({ avoid_guild_ids: [...draft.avoid_guild_ids, e.target.value] })}>
                <option value="">Add guild…</option>
                <GuildOptions guilds={board.guilds} clusters={board.clusters} exclude={draft.avoid_guild_ids} />
              </select>
            </div>
          </div>
        </section>
      </div>

      <div className="flex items-center gap-4">
        <Button onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : listed ? 'Save profile' : 'List me as a fill'}</Button>
        <span className="text-xs text-ash">Leaders see your Discord name and avatar.</span>
      </div>
    </div>
  );
}
