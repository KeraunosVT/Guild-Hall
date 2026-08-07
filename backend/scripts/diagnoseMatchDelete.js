// backend/scripts/diagnoseMatchDelete.js — why DELETE /api/admin/match/:id 500s.
//
// Reads the match and its player rows, then (only with --attempt) tries the
// same delete the endpoint runs and prints the full Postgres error, including
// the constraint name, which the endpoint's generic 500 throws away.
//
// Usage:
//   node scripts/diagnoseMatchDelete.js <match-id>            # read-only
//   node scripts/diagnoseMatchDelete.js <match-id> --attempt   # tries the delete
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const id = process.argv[2];
  const attempt = process.argv.includes('--attempt');
  if (!id) {
    console.error('Usage: node scripts/diagnoseMatchDelete.js <match-id> [--attempt]');
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: match, error: mErr } = await supabase
    .from('wargame_matches').select('id, title, match_date').eq('id', id).maybeSingle();
  if (mErr) { console.error('Match lookup failed:', mErr.message); process.exit(1); }
  if (!match) { console.log(`No match with id ${id} — it may already be gone.`); return; }
  console.log(`\nMatch: "${match.title}"  ${match.match_date}`);

  const { count, error: cErr } = await supabase
    .from('player_match_stats').select('*', { count: 'exact', head: true }).eq('match_id', id);
  console.log(cErr ? `  child rows: lookup failed (${cErr.message})` : `  player_match_stats rows: ${count}`);

  if (!attempt) {
    console.log('\nRead-only. Re-run with --attempt to try the delete and see the real error.');
    return;
  }

  console.log('\nAttempting the same delete the endpoint runs...');
  const { error } = await supabase.from('wargame_matches').delete().eq('id', id);
  if (!error) {
    console.log('  succeeded — the match is now deleted.');
    return;
  }
  console.log('  FAILED. Full error:');
  console.log(JSON.stringify({
    code: error.code, message: error.message, details: error.details, hint: error.hint,
  }, null, 2));
  if (error.code === '23503') {
    console.log('\n23503 = foreign_key_violation: a child row still references this match,');
    console.log('so at least one FK into wargame_matches is NOT ON DELETE CASCADE.');
    console.log('The constraint named above is the one blocking it.');
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
