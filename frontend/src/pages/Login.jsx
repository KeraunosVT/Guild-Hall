import { useAuth } from '../auth';
import Sigil from '../components/Sigil';

// The login page is the one screen that cannot know which guild it belongs to:
// it renders before there is a session, and the session is what says which
// guilds you are in. So it wears the product's own name rather than any house's
// — and it must, on a deployment serving several, since guessing would show one
// guild's banner to another guild's members.
function gateMessage() {
  const params = new URLSearchParams(window.location.search);
  switch (params.get('auth')) {
    case 'not_member':
      return "That Discord account isn't in a server this hall serves. Membership is required to enter.";
    case 'forbidden':
      return 'Your account is in the server but lacks the rank required to enter the hall.';
    case 'error':
      return 'Sign-in could not be completed. Please try again.';
    default:
      return null;
  }
}

export default function Login() {
  const { login } = useAuth();
  const message = gateMessage();

  return (
    <div className="min-h-screen bg-ink text-bone flex flex-col items-center justify-center px-6 text-center">
      <div className="rise">
        <Sigil className="w-16 h-20 text-brass mx-auto" />
      </div>

      <div className="rise rise-1 eyebrow text-brass text-[11px] mt-8 mb-4">The gate is barred</div>
      <h1 className="rise rise-1 font-display font-bold text-bone text-4xl md:text-5xl tracking-[0.08em]">
        Guild Hall
      </h1>
      <p className="rise rise-2 font-display text-brassbright text-lg md:text-xl tracking-[0.12em] mt-6">
        Muster the house.
      </p>
      <p className="rise rise-2 text-ash max-w-md mt-7 leading-relaxed">
        Sign in with Discord to prove your standing. You'll be taken to the halls
        of whichever houses you belong to.
      </p>

      {message && (
        <div className="rise rise-2 mt-6 max-w-md px-5 py-3 border border-oxblood/50 bg-oxblooddeep/20 rounded-lg text-sm text-bone">
          {message}
        </div>
      )}

      <div className="rise rise-3 mt-9 flex flex-wrap items-start justify-center gap-3">
        <div className="flex flex-col items-center gap-1.5">
          <button
            onClick={login}
            className="inline-flex items-center gap-3 px-7 py-3.5 rounded-lg font-semibold tracking-wide text-white transition-colors"
            style={{ backgroundColor: '#5865F2' }}
            onMouseOver={(e) => (e.currentTarget.style.backgroundColor = '#4752c4')}
            onMouseOut={(e) => (e.currentTarget.style.backgroundColor = '#5865F2')}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3c-.2.36-.43.84-.59 1.23a18.27 18.27 0 0 0-5.487 0A12.6 12.6 0 0 0 9.89 3 19.74 19.74 0 0 0 6.13 4.37C2.79 9.39 1.88 14.28 2.33 19.1a19.9 19.9 0 0 0 6.07 3.08c.49-.67.93-1.38 1.3-2.13-.71-.27-1.39-.6-2.03-.99.17-.13.34-.26.5-.4a14.2 14.2 0 0 0 12.06 0c.16.14.33.27.5.4-.64.39-1.32.72-2.03.99.37.75.81 1.46 1.3 2.13a19.84 19.84 0 0 0 6.07-3.08c.53-5.61-.9-10.46-3.77-14.73ZM9.55 16.1c-1.18 0-2.15-1.08-2.15-2.41 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.95 2.41-2.15 2.41Zm4.9 0c-1.18 0-2.15-1.08-2.15-2.41 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.09 2.15 2.42 0 1.33-.95 2.41-2.15 2.41Z" />
            </svg>
            Sign in with Discord
          </button>
          <span className="text-xs text-ash/70">(Members Only)</span>
        </div>
      </div>

      <div className="rise rise-3 mt-10 font-display text-[10px] tracking-[0.25em] text-ash">
        GUILD HALL
      </div>

      <div className="mt-6 flex gap-5 text-xs text-ash/70">
        <a href="/privacy" className="hover:text-brassbright transition-colors">Privacy</a>
        <a href="/terms" className="hover:text-brassbright transition-colors">Terms</a>
      </div>
    </div>
  );
}
