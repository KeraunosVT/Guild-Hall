import { useState, useRef, useEffect } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Swords, Users, Gem, Package, CalendarOff, Layers, Gauge,
  Upload, LayoutGrid, Tag, Gavel, ClipboardCheck, ScrollText, ShieldCheck, LogOut, Settings, ChevronDown,
} from 'lucide-react';
import Sigil from './Sigil';
import { GUILD } from '../guild';
import { useAuth } from '../auth';
import { getDisplayTimezone, setDisplayTimezone, TIMEZONE_OPTIONS } from '../timeUtils';

export const guildLinks = [
  { to: '/', label: 'Dashboard', end: true, icon: LayoutDashboard },
  { to: '/war-record', label: 'War Record', icon: Swords },
  { to: '/roster', label: 'Roster', icon: Users },
];

export const memberLinks = [
  { to: '/shards', label: 'Shards', icon: Gem },
  { to: '/loot', label: 'Loot', icon: Package },
  { to: '/loa', label: 'LOA', icon: CalendarOff },
  { to: '/classes', label: 'Classes', icon: Layers },
  { to: '/gear', label: 'Gear Level', icon: Gauge },
];

// `perm` is the capability each destination needs — the same one its page gate
// and its API routes check. Links are filtered rather than merely disabled: a
// visible link to a page that only ever shows "restricted" is worse than no
// link. A parent with children keeps its own `perm` for the landing page and
// disappears entirely once every child is filtered out too.
export const adminLinks = [
  { to: '/admin', label: 'Upload Match', end: true, icon: Upload, perm: 'match' },
  { to: '/admin/parties', label: 'Parties', icon: LayoutGrid, perm: 'parties' },
  { to: '/admin/names', label: 'Names', icon: Tag, perm: 'names' },
  { to: '/admin/loot', label: 'Loot Council', icon: Gavel, perm: 'loot.awards', children: [
    { to: '/admin/loot/items', label: 'Manage Items', perm: 'loot.catalog' },
    { to: '/admin/loot/currency', label: 'Lucent & Shards', perm: 'loot.currency' },
    { to: '/admin/loot/requests', label: 'Lucent Requests', perm: 'loot.requests' },
    { to: '/admin/loot/history', label: 'Loot History', perm: 'loot.history' },
  ] },
  { to: '/admin/attendance', label: 'Attendance', icon: ClipboardCheck, perm: 'attendance' },
  { to: '/admin/gear-levels', label: 'Gear Levels', icon: Gauge, perm: 'gear' },
  { to: '/admin/permissions', label: 'Permissions', icon: ShieldCheck, perm: 'permissions' },
  { to: '/admin/audit-log', label: 'Audit Log', icon: ScrollText, perm: 'audit' },
];

// Loot History reads gear awards and currency side by side, so any loot
// capability opens it — a pseudo-permission rather than a real one, resolved
// here so the link table stays a flat list of strings.
const LOOT_ANY = ['loot.awards', 'loot.catalog', 'loot.currency', 'loot.requests'];

export function visibleAdminLinks(can) {
  const allowed = (perm) => (perm === 'loot.history' ? LOOT_ANY.some(can) : can(perm));
  return adminLinks
    .map((l) => ({ ...l, children: (l.children || []).filter((c) => allowed(c.perm)) }))
    .filter((l) => allowed(l.perm) || l.children.length > 0);
}

export const SIDEBAR_COLLAPSE_KEY = 'sidebarCollapsed';

// No stored preference yet → start collapsed on phone/small-tablet widths,
// matching today's Masthead losing the username below `sm`.
export function getInitialSidebarCollapsed() {
  const stored = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return window.matchMedia('(max-width: 767px)').matches;
}

export default function Sidebar({ collapsed }) {
  const { user, logout, can } = useAuth();
  // Section disappears entirely when no capability opens anything in it.
  const adminNav = visibleAdminLinks(can);

  const linkClass = ({ isActive }) =>
    `flex items-center gap-3 rounded-md font-medium tracking-wide transition-colors ${
      collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'
    } ${isActive ? 'text-brassbright bg-panel' : 'text-ash hover:text-bone'}`;

  return (
    <aside className={`shrink-0 border-r border-line bg-ink flex flex-col transition-[width] duration-150 ${collapsed ? 'w-16' : 'w-60'}`}>
      <NavLink to="/" className="flex items-center gap-3 px-4 h-16 border-b border-line shrink-0">
        <Sigil className="w-7 h-9 text-brass shrink-0" />
        {!collapsed && (
          <div className="leading-none min-w-0">
            <div className="font-display text-bone text-sm tracking-[0.18em] truncate">{GUILD.house.toUpperCase()}</div>
            <div className="text-[10px] text-ash tracking-[0.25em] mt-1">⟨ {GUILD.tag} ⟩</div>
          </div>
        )}
      </NavLink>

      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        <NavSection title="Guild" links={guildLinks} linkClass={linkClass} collapsed={collapsed} />
        {user && <NavSection title="Member" links={memberLinks} linkClass={linkClass} collapsed={collapsed} />}
        {adminNav.length > 0 && <NavSection title="Admin" links={adminNav} linkClass={linkClass} collapsed={collapsed} />}
      </nav>

      {user && (
        <div className="border-t border-line p-3 flex items-center gap-2.5">
          {/* Avatar and name are one link to your own profile. Collapsed, the
              avatar is the only affordance left, so it carries the link. */}
          <Link
            to="/me" title="My profile"
            className={`flex items-center gap-2.5 min-w-0 text-bone hover:text-brassbright transition-colors ${collapsed ? '' : 'flex-1'}`}
          >
            {user.avatar
              ? <img src={user.avatar} alt="" className="w-7 h-7 rounded-full border border-line object-cover shrink-0" />
              : <div className="w-7 h-7 rounded-full bg-panelup border border-line flex items-center justify-center text-[11px] text-brass shrink-0">{(user.username || '?').slice(0, 1).toUpperCase()}</div>}
            {!collapsed && <span className="text-sm truncate">{user.username}</span>}
          </Link>
          {!collapsed && (
            <>
              <SettingsMenu />
              <button onClick={logout} title="Sign out" aria-label="Sign out" className="p-1.5 rounded-md text-ash hover:text-oxblood hover:bg-panel transition-colors shrink-0">
                <LogOut className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [timezone, setTimezone] = useState(getDisplayTimezone);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const chooseTimezone = (tz) => {
    setDisplayTimezone(tz);
    setTimezone(tz);
    // Timestamps already on screen were formatted at render time and won't
    // re-format themselves just because localStorage changed — a reload is
    // the simplest way to guarantee every open page reflects the new choice.
    window.location.reload();
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Settings" aria-label="Settings" aria-haspopup="true" aria-expanded={open}
        className="p-1.5 rounded-md text-ash hover:text-bone hover:bg-panel transition-colors"
      >
        <Settings className="w-4 h-4" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-64 panel rounded-sm shadow-xl p-3 z-50">
          <div className="eyebrow text-[10px] text-ash mb-2">Settings</div>
          <label className="eyebrow text-[10px] text-ash/75 block mb-1.5">Timezone</label>
          <select
            value={timezone} onChange={(e) => chooseTimezone(e.target.value)}
            className="w-full bg-hall border border-line rounded-md px-2.5 py-2 text-sm text-bone focus:outline-none focus:border-brass"
          >
            {TIMEZONE_OPTIONS.map((tz) => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

function NavSection({ title, links, linkClass, collapsed }) {
  const { pathname } = useLocation();
  const [expanded, setExpanded] = useState(() => new Set());

  const isParentActive = (to) => pathname === to || pathname.startsWith(`${to}/`);
  const isOpen = (link) => expanded.has(link.to) || link.children.some((c) => c.to === pathname);
  const toggle = (to) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(to) ? next.delete(to) : next.add(to);
    return next;
  });

  return (
    <div>
      {!collapsed && <div className="eyebrow text-[10px] text-ash/75 px-3 mb-1.5">{title}</div>}
      <div className="space-y-0.5">
        {links.map(({ to, label, end, icon: Icon, children }) => {
          // Collapsed rail has no room for a chevron/sub-list — just link
          // straight to the parent page, same as any other icon-only item.
          if (!children || collapsed) {
            return (
              <NavLink key={to} to={to} end={end} className={linkClass} title={collapsed ? label : undefined}>
                <Icon className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="truncate">{label}</span>}
              </NavLink>
            );
          }

          const open = isOpen({ to, children });
          return (
            <div key={to}>
              <div className={linkClass({ isActive: isParentActive(to) })}>
                <NavLink to={to} end={end} className="flex items-center gap-3 flex-1 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{label}</span>
                </NavLink>
                <button
                  onClick={() => toggle(to)} aria-label={open ? `Collapse ${label}` : `Expand ${label}`} aria-expanded={open}
                  className="p-1 -mr-1 shrink-0 text-ash hover:text-bone"
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>
              </div>
              {open && (
                <div className="ml-4 pl-3 mt-0.5 border-l border-line space-y-0.5">
                  {children.map((child) => (
                    <NavLink
                      key={child.to} to={child.to}
                      className={({ isActive }) => `block px-3 py-1.5 rounded-md text-sm truncate transition-colors ${isActive ? 'text-brassbright bg-panel' : 'text-ash hover:text-bone'}`}
                    >
                      {child.label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
