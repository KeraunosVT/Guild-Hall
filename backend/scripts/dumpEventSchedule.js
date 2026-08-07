// backend/scripts/dumpEventSchedule.js — read-only dump of the recurring event
// schedule, to see which day_of_week each early-morning event is filed under.
//
// A 12:30am event can be stored two ways: under the night it belongs to
// (Saturday) or under the calendar day it starts (Sunday). Which one is in use
// decides whether the guild-day change needs a data migration, so look before
// changing anything.
//
// SELECTs only — makes no writes.
//
// Usage:
//   node scripts/dumpEventSchedule.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Times at or before this are the ones the convention question is about.
const EARLY_CUTOFF = '05:00';

function fmt12h(t) {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing from backend/.env');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const { data, error } = await supabase
    .from('event_schedule').select('id, name, day_of_week, event_time')
    .order('day_of_week').order('event_time');
  if (error) {
    console.error('Query failed:', error.message);
    process.exit(1);
  }

  const rows = data || [];
  console.log(`\n${rows.length} scheduled event(s)\n`);
  console.log('  DAY        TIME        NAME');
  console.log('  ' + '-'.repeat(58));
  rows.forEach((r) => {
    const early = r.event_time && r.event_time < EARLY_CUTOFF;
    console.log(
      `  ${(DAYS[r.day_of_week] || `?${r.day_of_week}`).padEnd(10)} ${fmt12h(r.event_time).padEnd(10)}  ${r.name}${early ? '   <-- early morning' : ''}`,
    );
  });

  const early = rows.filter((r) => r.event_time && r.event_time < EARLY_CUTOFF);
  console.log(`\n${early.length} event(s) start before ${EARLY_CUTOFF}.`);
  if (early.length) {
    console.log('For each, is the day above the night it belongs to, or the calendar day it starts?\n');
    early.forEach((r) => {
      const prev = DAYS[(r.day_of_week + 6) % 7];
      console.log(`  "${r.name}" @ ${fmt12h(r.event_time)} filed under ${DAYS[r.day_of_week]}`);
      console.log(`     if it's talked about as ${prev} night  -> already correct, no migration`);
      console.log(`     if it's talked about as ${DAYS[r.day_of_week]} night -> needs shifting back to ${prev}\n`);
    });
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
