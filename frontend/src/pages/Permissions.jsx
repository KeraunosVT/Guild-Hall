import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { ShieldCheck, AlertTriangle, X, Search } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';

// Grants attach to a Discord role or to one person. Roles are the default tab
// because they self-maintain — strip the role in Discord and the access goes
// with it — whereas a personal grant outlives the member who had it.
const TABS = [
  { key: 'role', label: 'Discord roles' },
  { key: 'user', label: 'People' },
];

export default function Permissions() {
  const { can } = useAuth();
  const [catalog, setCatalog] = useState([]);
  const [roles, setRoles] = useState([]);
  const [members, setMembers] = useState([]);
  const [grants, setGrants] = useState([]);
  const [tab, setTab] = useState('role');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(null); // `${type}:${id}:${perm}` in flight
  const [msg, flash] = useFlash(3000);

  const load = () => {
    setLoading(true);
    Promise.all([
      axios.get('/api/admin/permissions'),
      axios.get('/api/admin/members'),
    ])
      .then(([p, m]) => {
        setCatalog(p.data.catalog || []);
        setRoles(p.data.roles || []);
        setGrants(p.data.grants || []);
        setMembers(m.data.members || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load permissions.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  // subject key -> Set of capabilities, for O(1) checkbox state.
  const held = useMemo(() => {
    const m = new Map();
    grants.forEach((g) => {
      const k = `${g.subject_type}:${g.subject_id}`;
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(g.permission);
    });
    return m;
  }, [grants]);

  // Subjects with grants whose role or member no longer exists. They'd otherwise
  // be invisible and un-removable, since the grid only lists live subjects.
  const staleSubjects = useMemo(() => {
    const seen = new Map();
    grants.filter((g) => g.stale).forEach((g) => {
      const k = `${g.subject_type}:${g.subject_id}`;
      if (!seen.has(k)) {
        seen.set(k, { type: g.subject_type, id: g.subject_id, label: g.subject_label || g.subject_id, perms: [] });
      }
      seen.get(k).perms.push(g.permission);
    });
    return [...seen.values()];
  }, [grants]);

  const subjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = tab === 'role'
      ? roles.map((r) => ({ id: r.id, label: r.name }))
      : members.map((m) => ({ id: m.id, label: m.name }));
    // Anyone already granted something sorts first — the rows you're most
    // likely to be here to change, rather than buried in an alphabetical list
    // of every member in the guild.
    return list
      .filter((s) => !q || s.label.toLowerCase().includes(q))
      .sort((a, b) => {
        const ah = held.has(`${tab}:${a.id}`) ? 0 : 1;
        const bh = held.has(`${tab}:${b.id}`) ? 0 : 1;
        return ah - bh || a.label.localeCompare(b.label);
      });
  }, [tab, roles, members, filter, held]);

  const toggle = async (subject, permission, on) => {
    const key = `${tab}:${subject.id}:${permission}`;
    setSaving(key);
    try {
      if (on) {
        await axios.post('/api/admin/permissions', {
          subject_type: tab, subject_id: subject.id, subject_label: subject.label, permission,
        });
      } else {
        await axios.delete('/api/admin/permissions', {
          data: { subject_type: tab, subject_id: subject.id, permission },
        });
      }
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to save.', false);
    } finally {
      setSaving(null);
    }
  };

  const revokeStale = async (s, permission) => {
    try {
      await axios.delete('/api/admin/permissions', {
        data: { subject_type: s.type, subject_id: s.id, permission },
      });
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to revoke.', false);
    }
  };

  if (!can('permissions')) return <RestrictedGate />;

  return (
    <PageShell maxWidth="max-w-none">
      <Toast msg={msg} />
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      <p className="text-sm text-ash mb-5">
        Grant admin capabilities to a Discord role or to one person. Roles are usually the right choice — remove the
        role in Discord and the access goes with it. Changes reach a signed-in member within the hour, or immediately
        if they sign out and back in.
      </p>

      <div className="panel rounded-lg p-4 mb-4 flex items-center gap-3 text-sm">
        <ShieldCheck className="w-4 h-4 text-brass shrink-0" />
        <span className="text-ash">
          Anyone holding a role in <span className="text-bone font-mono text-xs">DISCORD_ADMIN_ROLE_IDS</span> keeps
          every capability regardless of what&apos;s set here. That&apos;s deliberate — it means no combination of
          grants can lock everyone out of this page.
        </span>
      </div>

      {staleSubjects.length > 0 && (
        <div className="panel rounded-lg p-4 mb-4 border border-brass/40">
          <div className="eyebrow text-[10px] text-brass mb-2 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5" /> Grants with no matching role or member
          </div>
          <p className="text-ash text-xs mb-3">
            The subject was deleted or has left the guild. These grant nothing now, but they&apos;ll apply again if the
            id ever comes back — worth clearing out.
          </p>
          <div className="space-y-1.5">
            {staleSubjects.map((s) => (
              <div key={`${s.type}:${s.id}`} className="flex items-center gap-3 bg-hall border border-line rounded-lg px-3 py-2 text-sm">
                <span className="text-bone w-48 shrink-0 truncate">{s.label}</span>
                <span className="text-ash/60 text-[10px] w-12 shrink-0">{s.type}</span>
                <div className="flex flex-wrap gap-1 flex-1">
                  {s.perms.map((p) => (
                    <button key={p} onClick={() => revokeStale(s, p)}
                      title="Revoke" className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-line text-ash hover:text-oxblood hover:border-oxblood/50 transition-colors">
                      {p} <X className="w-3 h-3" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-1">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => { setTab(t.key); setFilter(''); }}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide transition-colors border ${
                tab === t.key ? 'bg-brass text-ink border-transparent' : 'border-line text-ash hover:text-bone'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-ash absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={tab === 'role' ? 'Find a role…' : 'Find a member…'}
            className="bg-hall border border-line rounded-lg pl-8 pr-3 py-1.5 text-sm text-bone focus:outline-none focus:border-brass w-56" />
        </div>
      </div>

      {loading ? (
        <div className="panel rounded-lg p-8 text-center text-ash text-sm">Loading…</div>
      ) : subjects.length === 0 ? (
        <div className="panel rounded-lg p-8 text-center text-ash text-sm">
          {tab === 'role' && roles.length === 0
            ? 'No roles returned — the bot needs a token and the guild to be reachable.'
            : 'Nothing matches that search.'}
        </div>
      ) : (
        // Scrolls in both directions inside the panel so the capability labels
        // and the name column stay put — a 13-column grid is unreadable once
        // either one scrolls away. A sticky header needs the container to be
        // what scrolls, hence the height cap rather than letting the page grow.
        <div className="panel rounded-lg overflow-auto max-h-[70vh]">
          {/* border-separate, not collapse: collapsed borders belong to the
              table rather than the cell, so they don't travel with a sticky
              header and vanish as soon as it lifts off the first row. */}
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr>
                {/* Corner cell is stuck on both axes, so it outranks each. */}
                <th className="text-left font-normal text-ash eyebrow text-[10px] px-4 py-3 sticky top-0 left-0 z-30 bg-panel border-b border-line">
                  {tab === 'role' ? 'Role' : 'Member'}
                </th>
                {catalog.map((c) => (
                  <th key={c.key} title={c.hint}
                    className="font-normal text-ash text-[10px] px-2 py-3 whitespace-nowrap align-bottom sticky top-0 z-20 bg-panel border-b border-line">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subjects.map((s) => {
                const mine = held.get(`${tab}:${s.id}`) || new Set();
                return (
                  <tr key={s.id} className="group">
                    <td className="px-4 py-2 text-bone truncate max-w-[220px] sticky left-0 z-10 bg-panel border-b border-line/50 group-hover:bg-hall">
                      {s.label}
                      {mine.size > 0 && <span className="text-brass/60 text-[10px] ml-2">{mine.size}</span>}
                    </td>
                    {catalog.map((c) => {
                      const on = mine.has(c.key);
                      const key = `${tab}:${s.id}:${c.key}`;
                      return (
                        // Same hover fill as the sticky name cell: that one has
                        // to be opaque to hide rows sliding under it, so the
                        // rest match it rather than tinting differently.
                        <td key={c.key} className="px-2 py-2 text-center border-b border-line/50 group-hover:bg-hall">
                          <input
                            type="checkbox" checked={on} disabled={saving === key}
                            onChange={(e) => toggle(s, c.key, e.target.checked)}
                            title={`${c.label} — ${c.hint}`}
                            className="w-4 h-4 accent-brass cursor-pointer disabled:opacity-40"
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
