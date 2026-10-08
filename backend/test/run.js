// Run every test in order, cheapest first, and stop at the first failure.
//
// The static audit runs before anything that needs a database, so a structural
// mistake is reported in under a second instead of after a full integration
// run — and so CI still says something useful when Supabase is unreachable.
const { spawnSync } = require('child_process');
const path = require('path');
// The suites load .env themselves; this runner needs it too, to decide whether
// a database is reachable before it skips anything.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SUITES = [
  ['leak audit (static)', 'leakAudit.js', false],
  // Stubbed data module, so it runs without a database too.
  ['elite timer buttons', 'eliteButtons.js', false],
  // Pure rules — who the pool shows a leader, and availability across timezones.
  ['wargame fill rules', 'wargameFills.js', false],
  // Crowns and new guilds, against an in-memory stand-in for the database.
  ['threat board editing', 'threatBoard.js', false],
  // The per-guild ceiling on Gemini spend, against a fake clock.
  ['gemini quota', 'geminiQuota.js', false],
  // The Paddle webhook: signatures, reading the buyer, and answering so Paddle
  // retries exactly the events we failed to apply.
  ['billing webhook', 'billing.js', false],
  ['login flow', 'loginFlow.js', true],
  ['bot isolation', 'botIsolation.js', true],
  ['API isolation (two guilds)', 'apiIsolation.js', true],
  // Correctness WITHIN a guild rather than isolation between guilds — capacity,
  // waitlist order, and the races the signup RPCs exist to serialise.
  ['signup semantics (concurrency)', 'signupSemantics.js', true],
  // Same shape of question for late attendance: the 24-hour window, the
  // approve-once claim, and who owns a request. All of them fail silently.
  ['late attendance semantics', 'lateAttendance.js', true],
  // Paid self-serve onboarding end to end: no seat no guild, one seat one
  // guild (raced), the webhook's idempotency and ordering, lapse and recovery,
  // and staff suspensions surviving a payment.
  ['paid onboarding', 'onboarding.js', true],
  // The staff Guilds page: staff only, and suspend / reactivate / comp each
  // doing exactly what they say against billing.
  ['staff guilds', 'staffGuilds.js', true],
];

const needsDb = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
let failed = 0;

for (const [label, file, requiresDb] of SUITES) {
  if (requiresDb && !needsDb) {
    console.log(`\n=== ${label} — SKIPPED (no SUPABASE_URL / SUPABASE_SERVICE_KEY) ===`);
    continue;
  }
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; break; }
}

if (failed) {
  console.log('\nFAILED');
  process.exit(1);
}
console.log('\nAll suites passed.');
