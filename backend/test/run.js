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
  ['login flow', 'loginFlow.js', true],
  ['bot isolation', 'botIsolation.js', true],
  ['API isolation (two guilds)', 'apiIsolation.js', true],
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
