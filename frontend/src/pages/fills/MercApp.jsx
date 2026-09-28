import { BrowserRouter as Router, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuth } from '../../auth';
import Sigil from '../../components/Sigil';
import { PageShell } from '../../components/ui/PageShell';
import EmptyState from '../../components/ui/EmptyState';
import FillProfile from './FillProfile';
import FillInvites from './FillInvites';
import FillRequests from './FillRequests';
import FillRequestDetail from './FillRequestDetail';
import LeaderClaim from './LeaderClaim';
import StaffClaims from './StaffClaims';
import { useFillsMe } from './shared';

// merc.guild-hall.gg — the wargame fill pool as its own site.
//
// Same build and same server as the guild app; App.jsx renders this instead
// when the page is served from the merc host. It deliberately has no sidebar
// and no guild context: most people here belong to no Guild Hall guild, and
// the ones who do only need the fill pages. Guild Hall members get the same
// pages inside their normal sidebar on guild-hall.gg.

const LOGIN_ERRORS = {
  state: 'Your sign-in expired or was interrupted. Please try again — if it keeps happening, check that cookies are allowed for this site.',
  config: 'Sign-in is misconfigured on our side. Guild Hall staff have been told by the server logs; please try again later.',
  error: 'Something went wrong signing you in. Please try again.',
};

function Landing() {
  const { login } = useAuth();
  const err = LOGIN_ERRORS[new URLSearchParams(window.location.search).get('auth')];
  return (
    <PageShell maxWidth="max-w-3xl">
      <div className="space-y-8 py-6">
        <div className="space-y-3">
          <div className="eyebrow text-[10px] text-ash">Throne and Liberty · Americas</div>
          <h1 className="font-display text-3xl sm:text-4xl tracking-[0.06em] text-bone" style={{ textWrap: 'balance' }}>
            Find fills for your wargame. Fill for someone else&apos;s.
          </h1>
          <p className="text-ash max-w-prose">
            List yourself with your role, classes and the hours you can play. Guild leaders post a wargame and invite
            players from the pool; you accept or decline. You don&apos;t need to be in a Guild Hall guild.
          </p>
        </div>
        {err && <p className="text-sm text-oxblood">{err}</p>}
        <button
          onClick={login}
          className="px-6 py-3 rounded-lg font-semibold tracking-wide text-white transition-colors hover:brightness-110"
          style={{ backgroundColor: '#5865F2' }}
        >
          Sign in with Discord
        </button>
        <ul className="grid gap-4 sm:grid-cols-3 text-sm">
          <li className="panel rounded-lg p-4"><div className="font-semibold mb-1">You stay hidden from the other side</div><span className="text-ash">Leaders wargaming against your guild or its ally never see you.</span></li>
          <li className="panel rounded-lg p-4"><div className="font-semibold mb-1">Nothing is booked without you</div><span className="text-ash">A slot is only filled when you accept the invite.</span></li>
          <li className="panel rounded-lg p-4"><div className="font-semibold mb-1">Leaders are checked</div><span className="text-ash">Invites show whether Guild Hall has verified the leader.</span></li>
        </ul>
      </div>
    </PageShell>
  );
}

function Shell({ children, me }) {
  const { user, logout } = useAuth();
  const tabs = [
    { to: '/', label: 'My profile', end: true },
    { to: '/invites', label: 'Invites' },
    { to: '/requests', label: 'Fill requests' },
    { to: '/leader', label: 'Leader status' },
    ...(me?.staff ? [{ to: '/staff', label: 'Leader claims' }] : []),
  ];
  return (
    <div className="min-h-screen bg-ink text-bone flex flex-col shell-vignette">
      <header className="border-b border-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
          <a href="/" className="flex items-center gap-3 text-bone">
            <Sigil className="w-6 h-8 text-brass shrink-0" />
            <span className="font-display text-sm tracking-[0.18em]">GUILD HALL</span>
            <span className="eyebrow text-[10px] text-ash">Mercs</span>
          </a>
          {user && (
            <nav className="flex flex-wrap gap-1 order-3 sm:order-none w-full sm:w-auto" aria-label="Fill pool">
              {tabs.map((t) => (
                <NavLink key={t.to} to={t.to} end={t.end}
                  className={({ isActive }) => `px-3 py-2 text-sm font-medium border-b-2 transition-colors ${isActive ? 'border-brass text-bone' : 'border-transparent text-ash hover:text-bone'}`}>
                  {t.label}
                </NavLink>
              ))}
            </nav>
          )}
          {user && (
            <div className="ml-auto flex items-center gap-3 text-sm">
              {user.avatar
                ? <img src={user.avatar} alt="" className="w-7 h-7 rounded-full border border-line" />
                : <span className="w-7 h-7 rounded-full bg-panelup border border-line" />}
              <span className="hidden sm:inline">{user.username}</span>
              <button onClick={logout} title="Sign out" aria-label="Sign out" className="p-1.5 rounded-md text-ash hover:text-oxblood transition-colors">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

function Page({ eyebrow, title, children }) {
  return (
    <PageShell>
      <div className="mb-8">
        <div className="eyebrow text-[10px] text-ash">{eyebrow}</div>
        <h1 className="font-display text-2xl tracking-[0.06em] mt-1">{title}</h1>
      </div>
      {children}
    </PageShell>
  );
}

function SignedIn() {
  const { me, error, reload } = useFillsMe();
  if (error) return <Shell><PageShell><p className="text-oxblood">{error}</p></PageShell></Shell>;
  if (!me) return <Shell><EmptyState>Opening the pool…</EmptyState></Shell>;
  return (
    <Shell me={me}>
      <Routes>
        <Route path="/" element={<Page eyebrow="Fill profile" title="List yourself as a fill"><FillProfile me={me} onSaved={reload} /></Page>} />
        <Route path="/invites" element={<Page eyebrow="Fill invites" title="Invites"><FillInvites /></Page>} />
        <Route path="/requests" element={<Page eyebrow="Leaders" title="Fill requests"><FillRequests me={me} base="/requests" claimPath="/leader" /></Page>} />
        <Route path="/requests/:id" element={<PageShell><FillRequestDetail base="/requests" /></PageShell>} />
        <Route path="/leader" element={<Page eyebrow="Leaders" title="Verify that you lead your guild"><LeaderClaim me={me} onSaved={reload} /></Page>} />
        {me.staff && <Route path="/staff" element={<Page eyebrow="Guild Hall staff" title="Leader claims"><StaffClaims /></Page>} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function MercApp() {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen bg-ink" />;
  return (
    <Router>
      {user ? <SignedIn /> : <Shell><Landing /></Shell>}
    </Router>
  );
}
