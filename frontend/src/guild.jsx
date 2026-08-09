import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { useAuth } from './auth';
import { configureGuildTime } from './timeUtils';

// ── WHICH GUILD IS THIS BROWSER LOOKING AT ──────────────────────────────────
// One deployment serves many guilds, so guild identity cannot be compiled into
// the bundle. It used to come from shared/guild.json at build time, which meant
// every tenant would have seen whichever guild the bundle was built for — its
// name, its motto, and (worse, because it is silent) its guild-night rollover.
//
// Now: the session says which guilds you belong to, this picks the active one,
// every request carries it in a header, and the server answers with that
// guild's own config.
//
// The header is a CLAIM, not proof. The server checks it against the signed
// session on every request (backend/guildContext.js) and refuses a guild you
// aren't in, so a hand-edited localStorage value gets a 403, not another
// guild's data.

const GuildContext = createContext(null);
const ACTIVE_GUILD_KEY = 'activeGuildId';

// Set before any request goes out. Kept on the axios default so every existing
// call site is covered without touching a single one of them.
function applyHeader(guildId) {
  if (guildId) axios.defaults.headers.common['x-guild-id'] = guildId;
  else delete axios.defaults.headers.common['x-guild-id'];
}

export function GuildProvider({ children }) {
  const { user, loading: authLoading } = useAuth();

  const memberships = Array.isArray(user?.guilds) ? user.guilds : [];
  const [activeGuildId, setActiveGuildId] = useState(null);
  const [guild, setGuild] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // A session issued before multi-guild login carries no guilds list. It cannot
  // be repaired client-side — only a fresh sign-in produces the new shape — so
  // it is a distinct state from "you aren't in that guild", and the difference
  // is what decides whether we offer a sign-in button or an apology.
  const [needsReauth, setNeedsReauth] = useState(false);

  // Pick the active guild: the one remembered from last visit if the session
  // still includes it, otherwise whatever the server considers active, else the
  // first membership. A remembered id that is no longer in the session is
  // dropped rather than sent — that request would only 403.
  useEffect(() => {
    if (authLoading) return;
    if (!user) { setActiveGuildId(null); setGuild(null); setLoading(false); return; }

    const remembered = localStorage.getItem(ACTIVE_GUILD_KEY);
    const valid = (id) => id && (!memberships.length || memberships.some((g) => g.guild_id === id));

    const next = (valid(remembered) && remembered)
      || (valid(user.activeGuildId) && user.activeGuildId)
      || memberships[0]?.guild_id
      || user.activeGuildId
      || null;

    setActiveGuildId(next);
    applyHeader(next);
  }, [authLoading, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load that guild's identity and time rules.
  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const res = await axios.get('/api/guild');
        if (cancelled) return;
        const g = res.data?.guild || null;
        setGuild(g);
        // Before anything renders: daySlot/todayInGuildTz and friends read these
        // live, and a component that formats a time before this runs would show
        // the fallback rollover rather than this guild's.
        if (g) configureGuildTime({ timezone: g.timezone, dayStart: g.dayStart });
        if (g?.house) document.title = `${g.house} — Guild Hall`;
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setGuild(null);
        const status = err?.response?.status;
        const serverMsg = err?.response?.data?.error;
        // The server distinguishes "your session predates multi-guild login"
        // from "you aren't in that guild"; surface that difference rather than
        // flattening both into one dead end.
        const stale = status === 403 && /sign in again/i.test(serverMsg || '');
        setNeedsReauth(stale);
        setError(serverMsg || (status === 403
          ? 'You are not a member of that guild.'
          : 'Could not load this guild.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [authLoading, user, activeGuildId]);

  const switchGuild = useCallback((guildId) => {
    if (!guildId || guildId === activeGuildId) return;
    localStorage.setItem(ACTIVE_GUILD_KEY, guildId);
    applyHeader(guildId);
    setActiveGuildId(guildId);
    // Capabilities are per guild, so the session's view of "what may I do" has
    // to be re-read for the new one. A full reload is the honest way to do it:
    // every page's loaded data belongs to the guild being left.
    window.location.reload();
  }, [activeGuildId]);

  return (
    <GuildContext.Provider value={{
      guild,
      guilds: memberships,
      activeGuildId,
      switchGuild,
      loading,
      error,
      needsReauth,
      // Convenience for display; never used for a decision.
      house: guild?.house || 'Guild Hall',
      tag: guild?.tag || '',
    }}>
      {children}
    </GuildContext.Provider>
  );
}

export function useGuild() {
  const ctx = useContext(GuildContext);
  if (!ctx) throw new Error('useGuild must be used within GuildProvider');
  return ctx;
}
