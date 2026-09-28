import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import { PageShell } from '../../components/ui/PageShell';
import EmptyState from '../../components/ui/EmptyState';
import RestrictedGate from '../../components/ui/RestrictedGate';
import Tabs from '../../components/ui/Tabs';
import FillProfile from './FillProfile';
import FillInvites from './FillInvites';
import FillRequests from './FillRequests';
import FillRequestDetail from './FillRequestDetail';
import { useFillsMe } from './shared';

// The wargame fill pages as they appear inside the guild app's sidebar. Same
// components as merc.guild-hall.gg (see MercApp.jsx) — only the chrome differs.

function Header({ eyebrow, title, me }) {
  return (
    <div className="mb-8 space-y-1">
      <div className="eyebrow text-[10px] text-ash">{eyebrow}</div>
      <h1 className="font-display text-2xl tracking-[0.06em]">{title}</h1>
      {me?.mercUrl && (
        <p className="text-sm text-ash">
          Players outside Guild Hall use the same pool at{' '}
          <a className="text-brass hover:text-brassbright underline underline-offset-4" href={me.mercUrl}>{me.mercUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>.
        </p>
      )}
    </div>
  );
}

// /fills and /fills/invites: a member's own listing and invites.
export function FillsMemberPage() {
  const { me, error, reload } = useFillsMe();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tab = pathname.endsWith('/invites') ? 'invites' : 'profile';
  return (
    <PageShell>
      <Header eyebrow="Wargame fills" title="Fill for other guilds" me={me} />
      <Tabs variant="flat" active={tab}
        items={[{ key: 'profile', label: 'My fill profile' }, { key: 'invites', label: 'Invites' }]}
        onChange={(k) => navigate(k === 'invites' ? '/fills/invites' : '/fills')} />
      {error && <p className="text-oxblood">{error}</p>}
      {!me && !error && <EmptyState>Opening the pool…</EmptyState>}
      {me && (tab === 'invites' ? <FillInvites /> : <FillProfile me={me} onSaved={reload} />)}
    </PageShell>
  );
}

// /admin/fills: this guild's fill requests.
export function FillsAdminPage() {
  const { can } = useAuth();
  const { me, error } = useFillsMe();
  if (!can('fills')) return <RestrictedGate reason="Posting fill requests takes the Wargame Fills permission." />;
  return (
    <PageShell>
      <Header eyebrow="Admin" title="Fill requests" me={me} />
      {error && <p className="text-oxblood">{error}</p>}
      {!me && !error && <EmptyState>Loading…</EmptyState>}
      {me && <FillRequests me={me} base="/admin/fills" />}
    </PageShell>
  );
}

export function FillsAdminDetail() {
  const { can } = useAuth();
  if (!can('fills')) return <RestrictedGate reason="Posting fill requests takes the Wargame Fills permission." />;
  return <PageShell><FillRequestDetail base="/admin/fills" /></PageShell>;
}
