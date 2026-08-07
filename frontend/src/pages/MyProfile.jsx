import { useState, useEffect } from 'react';
import { Navigate, Link } from 'react-router-dom';
import axios from 'axios';
import { UserSearch } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';

// /me is a resolver, not a page: a session knows a Discord id, but profiles are
// addressed by in-game name. Redirecting means the nav link can be a plain
// static entry and the profile itself stays a single component addressed one
// way — and a shared /roster/<name> link still works for everyone else.
export default function MyProfile() {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get('/api/my-profile')
      .then((res) => setState(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not resolve your profile.'));
  }, []);

  if (error) return <PageShell maxWidth="max-w-2xl"><EmptyState>{error}</EmptyState></PageShell>;
  if (!state) return <PageShell maxWidth="max-w-2xl"><EmptyState>Finding your record…</EmptyState></PageShell>;

  if (state.mapped && state.hasRecord) {
    return <Navigate to={`/roster/${encodeURIComponent(state.name)}`} replace />;
  }

  // Both failure modes are fixable, so say which one it is and by whom.
  return (
    <PageShell maxWidth="max-w-2xl">
      <div className="panel rounded-lg p-8 text-center">
        <UserSearch className="w-8 h-8 text-brass mx-auto mb-4" />
        <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-3">No profile yet</h2>
        {!state.mapped ? (
          <p className="text-ash text-sm leading-relaxed">
            Your Discord account isn&apos;t linked to an in-game name yet, so there&apos;s nothing to show.
            An officer can link it on the <span className="text-bone">Names</span> page.
          </p>
        ) : (
          <p className="text-ash text-sm leading-relaxed">
            You&apos;re linked as <span className="text-brassbright">{state.name}</span>, but no match records
            carry that name yet. One will appear here once you show up on a logged scoreboard.
          </p>
        )}
        <Link to="/roster" className="inline-block mt-5 text-sm text-brass hover:text-brassbright transition-colors">
          Browse the roster
        </Link>
      </div>
    </PageShell>
  );
}
