import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { Save, ShieldAlert, Hash, Clock, Plus, X, Loader2, AlertTriangle, AtSign, Volume2 } from 'lucide-react';
import { useAuth } from '../auth';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import Button from '../components/ui/Button';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';
import { TIMEZONE_OPTIONS } from '../timeUtils';

// ── WHAT THIS PAGE IS ───────────────────────────────────────────────────────
// The tenant's own guilds row — everything scripts/onboardGuild.js sets and
// nothing could change afterwards without the SQL editor.
//
// Three of these fields reach further than they look, and the UI says so at the
// point of editing rather than in documentation nobody opens:
//   · officer / allow-list roles gate this very page, and the effect is delayed
//     by up to an hour because capabilities live in the session cookie;
//   · the guild-night rollover silently re-buckets which night after-midnight
//     events belong to, across LOA, attendance, rosters and signups at once;
//   · past in-game names must stay listed forever or their matches leave the
//     war record.
// The server refuses the unrecoverable versions of the first and third; this
// page's job is to make sure nobody is surprised by the refusal.

const CHANNELS = [
  { key: 'roster_channel_id', label: 'Roster', hint: 'Where the party builder posts finished rosters' },
  { key: 'loa_channel_id', label: 'LOA', hint: 'Where filed absences are announced' },
  { key: 'announce_channel_id', label: 'Announcements', hint: 'Where /announce posts' },
  { key: 'signup_channel_id', label: 'Signups', hint: 'Falls back to Announcements when left blank' },
];

const ROLE_GROUPS = [
  {
    key: 'admin_role_ids',
    label: 'Officer roles',
    hint: 'Hold every capability, including ones added in future releases. At least one is required, and you must keep one you hold yourself.',
    critical: true,
  },
  {
    key: 'allowed_role_ids',
    label: 'Member allow-list',
    hint: 'Who may sign in at all. Leave empty to allow every member of the server.',
    critical: true,
  },
  {
    key: 'member_role_ids',
    label: 'Roster roles',
    hint: 'Who appears in the party builder and member pickers. Empty means everyone.',
  },
];

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="eyebrow text-[10px] text-ash block mb-2">{label}</label>
      {children}
      {hint && <p className="text-ash/50 text-xs mt-1">{hint}</p>}
    </div>
  );
}

const inputClass = 'w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass';

// Roles are picked, never typed. A hand-entered snowflake that is off by one
// digit doesn't error — it silently matches nobody, which for the officer list
// means the guild finds out at the next re-verify.
function RolePicker({ roles, selected, onChange, critical }) {
  const byId = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  // A stored id the bot can no longer see (deleted role, or Discord is down)
  // still has to be visible to be removable — otherwise loading the page while
  // the bot is offline and pressing save would quietly wipe the list.
  const orphans = selected.filter((id) => !byId.has(id));

  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.length === 0 && orphans.length === 0 && (
        <span className="text-ash/50 text-xs">No roles available — the Discord bot is unreachable.</span>
      )}
      {roles.map((r) => {
        const on = selected.includes(r.id);
        return (
          <button key={r.id} type="button" onClick={() => toggle(r.id)}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
              on
                ? (critical ? 'border-brass bg-brass text-ink' : 'border-emerald-500 bg-emerald-500 text-ink')
                : 'border-line text-ash hover:text-bone'
            }`}>
            {r.name}
          </button>
        );
      })}
      {orphans.map((id) => (
        <button key={id} type="button" onClick={() => toggle(id)} title="This role no longer exists in Discord — click to remove"
          className="px-3 py-1 rounded-full text-xs font-mono border border-oxblood/50 text-oxblood">
          {id} <X className="w-3 h-3 inline" />
        </button>
      ))}
    </div>
  );
}

export default function GuildSettings() {
  const { can } = useAuth();
  const [form, setForm] = useState(null);
  const [original, setOriginal] = useState(null);
  const [roles, setRoles] = useState([]);
  const [channels, setChannels] = useState([]);
  // Voice channels, kept in their own list rather than merged into `channels`.
  // The attendance setting names a channel the bot READS a member list out of;
  // every other picker on this page names one it POSTS into. One combined list
  // would let a guild point its LOA announcements at a voice channel.
  const [voiceChannels, setVoiceChannels] = useState([]);
  // The @everyone role, sent separately from `roles` on purpose — see the
  // comment on GET /api/admin/settings. It belongs in the signup ping picker
  // and in none of the role pickers above it.
  const [everyoneId, setEveryoneId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash(6000);
  const [aliasDraft, setAliasDraft] = useState('');

  useEffect(() => {
    axios.get('/api/admin/settings')
      .then((res) => {
        setForm(res.data.settings);
        setOriginal(res.data.settings);
        setRoles(res.data.roles || []);
        setChannels(res.data.channels || []);
        setVoiceChannels(res.data.voice_channels || []);
        setEveryoneId(res.data.everyone_role_id || '');
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load settings.'))
      .finally(() => setLoading(false));
  }, []);

  if (!can('settings')) return <RestrictedGate />;

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const addAlias = () => {
    const v = aliasDraft.trim();
    if (!v || form.aliases.includes(v)) { setAliasDraft(''); return; }
    set('aliases', [...form.aliases, v]);
    setAliasDraft('');
  };

  const changed = (key) => JSON.stringify(form?.[key]) !== JSON.stringify(original?.[key]);
  const removedAliases = (original?.aliases || []).filter((a) => !(form?.aliases || []).includes(a));

  const save = async () => {
    // Confirmations only for the changes whose consequence is invisible at the
    // moment of making it. The server independently refuses the unrecoverable
    // cases; these exist so a correct-but-surprising save isn't a surprise.
    const warnings = [];
    if (changed('day_start')) {
      warnings.push(`Moving the guild-night rollover to ${form.day_start} changes which night after-midnight events belong to — across LOA, attendance, rosters and signups, for past records as well as future ones.`);
    }
    if (changed('tag')) {
      warnings.push(`Renaming the tag to "${form.tag}" adds it to the past-names list automatically, so both old and new scoreboards keep counting.`);
    }
    if (removedAliases.length) {
      warnings.push(`Removing past name(s) ${removedAliases.join(', ')} will be refused if any match still uses them.`);
    }
    if (changed('admin_role_ids') || changed('allowed_role_ids')) {
      warnings.push('Role changes take effect when each member\'s session re-verifies — within the hour, or at their next sign-in. They are not immediate.');
    }
    if (warnings.length && !window.confirm(`${warnings.join('\n\n')}\n\nSave anyway?`)) return;

    setSaving(true); setError('');
    try {
      const res = await axios.put('/api/admin/settings', form);
      setForm(res.data.settings);
      setOriginal(res.data.settings);
      flash('Settings saved. Branding and time rules apply on your next page load.');
    } catch (err) {
      flash(err.response?.data?.error || 'Could not save settings.', false);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <PageShell maxWidth="max-w-3xl"><div className="py-20 text-center text-ash">Loading settings…</div></PageShell>;
  if (!form) {
    return (
      <PageShell maxWidth="max-w-3xl">
        <div className="px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error || 'No settings available.'}</div>
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="max-w-3xl">
      <p className="text-sm text-ash mb-6">
        Everything set when this house was onboarded. Changes apply to this guild only.
      </p>

      <Toast msg={msg} />
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      <div className="space-y-6">
        {/* ── Identity ─────────────────────────────────────────────── */}
        <section className="panel rounded-lg p-6 space-y-4">
          <div className="eyebrow text-brass text-[10px]">Identity</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="House name" hint="The ceremonial name shown across the site.">
              <input value={form.house || ''} onChange={(e) => set('house', e.target.value)} className={inputClass} />
            </Field>
            <Field label="Guild tag" hint="Exactly as it appears on in-game scoreboards.">
              <input value={form.tag || ''} onChange={(e) => set('tag', e.target.value)} className={inputClass} />
            </Field>
          </div>

          <Field label="Past in-game names"
            hint="A scoreboard records whatever the guild was called that day, so every past name has to stay listed or its matches leave the war record. The current tag is always included.">
            <div className="flex flex-wrap gap-1.5 mb-2">
              {(form.aliases || []).map((a) => (
                <span key={a} className="inline-flex items-center gap-1.5 text-sm bg-hall border border-line rounded-full px-3 py-1 text-bone">
                  {a}
                  {a !== form.tag && (
                    <button onClick={() => set('aliases', form.aliases.filter((x) => x !== a))}
                      className="text-ash hover:text-oxblood" title="Remove this past name">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={aliasDraft} onChange={(e) => setAliasDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAlias(); } }}
                placeholder="Add a former name" className={inputClass} />
              <Button variant="secondary" size="none" className="px-3 shrink-0" onClick={addAlias}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            {removedAliases.length > 0 && (
              <p className="text-brass text-xs mt-2 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Removing {removedAliases.join(', ')} — this is refused if any match still uses that name.
              </p>
            )}
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Motto">
              <input value={form.motto || ''} onChange={(e) => set('motto', e.target.value)} className={inputClass} />
            </Field>
            <Field label="Creed">
              <input value={form.creed || ''} onChange={(e) => set('creed', e.target.value)} className={inputClass} />
            </Field>
          </div>
        </section>

        {/* ── Time ─────────────────────────────────────────────────── */}
        <section className="panel rounded-lg p-6 space-y-4">
          <div className="eyebrow text-brass text-[10px] flex items-center gap-2"><Clock className="w-3.5 h-3.5" /> Time</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Guild timezone" hint="Every scheduled time on the site is written in this zone.">
              <select value={form.timezone || ''} onChange={(e) => set('timezone', e.target.value)} className={inputClass}>
                {!TIMEZONE_OPTIONS.some((t) => t.value === form.timezone) && form.timezone && (
                  <option value={form.timezone}>{form.timezone}</option>
                )}
                {TIMEZONE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Guild-night rollover"
              hint="Anything before this counts as the night before, so a 12:30 AM boss is still Saturday's last event. Must sit after your latest event and before the next evening's earliest.">
              <input type="time" value={form.day_start || ''} onChange={(e) => set('day_start', e.target.value)} className={inputClass} />
            </Field>
          </div>
          {changed('day_start') && (
            <p className="text-brass text-xs flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              This re-buckets which night after-midnight events belong to, for existing records as well as new ones.
            </p>
          )}
        </section>

        {/* ── Roles ────────────────────────────────────────────────── */}
        <section className="panel rounded-lg p-6 space-y-5">
          <div className="eyebrow text-brass text-[10px] flex items-center gap-2"><ShieldAlert className="w-3.5 h-3.5" /> Discord roles</div>
          <div className="px-4 py-2.5 rounded-lg border border-brass/30 bg-hall text-xs text-ash flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-brass shrink-0 mt-0.5" />
            <span>
              These two lists gate this page and the login itself, and the effect is delayed — capabilities live in each
              member&apos;s session and refresh within the hour. A save that removes your own access is refused rather than
              confirmed, because there would be no way back from inside the app.
            </span>
          </div>
          {ROLE_GROUPS.map(({ key, label, hint, critical }) => (
            <Field key={key} label={label} hint={hint}>
              <RolePicker roles={roles} selected={form[key] || []} onChange={(v) => set(key, v)} critical={critical} />
            </Field>
          ))}
        </section>

        {/* ── Channels ─────────────────────────────────────────────── */}
        <section className="panel rounded-lg p-6 space-y-4">
          <div className="eyebrow text-brass text-[10px] flex items-center gap-2"><Hash className="w-3.5 h-3.5" /> Discord channels</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {CHANNELS.map(({ key, label, hint }) => {
              const value = form[key] || '';
              const known = channels.some((c) => c.id === value);
              return (
                <Field key={key} label={label} hint={hint}>
                  <select value={value} onChange={(e) => set(key, e.target.value || null)} className={inputClass}>
                    <option value="">— none —</option>
                    {/* A stored id the bot can't see must stay selectable, or
                        saving while Discord is unreachable would silently clear it. */}
                    {value && !known && <option value={value}>{value} (not visible to the bot)</option>}
                    {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                  </select>
                </Field>
              );
            })}
          </div>

          {/* A VOICE channel, and the only one on this page. Kept visually
              apart from the grid above for that reason — the others are places
              the bot writes to, this is the place it reads a member list from
              when attendance is taken. */}
          <Field label={<span className="flex items-center gap-1.5"><Volume2 className="w-3 h-3" /> Attendance voice channel</span>}
            hint="Snapped by /attendance when the officer running it isn't already in a voice channel, and preselected on the Attendance page. Naming a channel on the command always wins.">
            <select value={form.attendance_voice_channel_id || ''}
              onChange={(e) => set('attendance_voice_channel_id', e.target.value || null)}
              className={`${inputClass} md:w-1/2`}>
              <option value="">— ask every time —</option>
              {/* Same rule as every other picker here: a stored id the bot
                  can't currently see stays selectable, so saving during a
                  Discord outage doesn't quietly clear the setting. */}
              {form.attendance_voice_channel_id
                && !voiceChannels.some((c) => c.id === form.attendance_voice_channel_id) && (
                <option value={form.attendance_voice_channel_id}>
                  {form.attendance_voice_channel_id} (not visible to the bot)
                </option>
              )}
              {voiceChannels.map((c) => <option key={c.id} value={c.id}>🔊 {c.name}</option>)}
            </select>
          </Field>

          {/* Not a channel, but it belongs with them: this is the other half of
              "where does a signup announcement go and who does it reach". */}
          <Field label={<span className="flex items-center gap-1.5"><AtSign className="w-3 h-3" /> Default signup ping</span>}
            hint="Pinged once when a signup announcement is posted — never again as people click. Officers can override it per event, and choose no ping at all.">
            <select value={form.signup_mention_role_id || ''}
              onChange={(e) => set('signup_mention_role_id', e.target.value || null)}
              className={`${inputClass} md:w-1/2`}>
              <option value="">— No ping —</option>
              {everyoneId && <option value={everyoneId}>@everyone</option>}
              {roles.map((r) => <option key={r.id} value={r.id}>@{r.name}</option>)}
              {/* A role the bot can't see has to stay selectable, or opening
                  this page during a Discord outage and saving would clear it. */}
              {form.signup_mention_role_id
                && form.signup_mention_role_id !== everyoneId
                && !roles.some((r) => r.id === form.signup_mention_role_id) && (
                <option value={form.signup_mention_role_id}>
                  {form.signup_mention_role_id} (not visible to the bot)
                </option>
              )}
            </select>
            {form.signup_mention_role_id && form.signup_mention_role_id === everyoneId && (
              <p className="text-brass text-xs mt-2 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Every signup will notify the whole server by default, including members who never raid.
              </p>
            )}
          </Field>
        </section>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={save} disabled={saving} icon={saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
        <span className="text-ash/50 text-xs">Every change is recorded in the audit log.</span>
      </div>
    </PageShell>
  );
}
