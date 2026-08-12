#!/usr/bin/env node
// ============================================================================
// Screenshot the demo guild for the landing page.
// ============================================================================
// Usage, from backend/:
//   node scripts/demoServer.js          (in one terminal — must be running)
//   node scripts/demoShots.js           (in another)
//
// Writes PNGs to frontend/public/shots/, which Vite copies into dist/ on the
// next build, so the landing page can reference them as /shots/<name>.png.
//
// ── WHAT IT IS ALLOWED TO PHOTOGRAPH ───────────────────────────────────────
// The demo guild, and nothing else. Every name, gear level and loot award in
// these images is invented by scripts/demoFixture.js. That is not a nicety: a
// screenshot on a public marketing page is published forever, and a shot of a
// real tenant would publish real members' names, their attendance record and
// what the guild has given them — none of which they agreed to.
//
// So the target is pinned to the demo proxy and the run ABORTS if the page it
// lands on isn't the demo guild. There is no flag to point this at production.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { VIEWER } = require('./demoFixture');

const BASE = `http://127.0.0.1:${parseInt(process.env.DEMO_PORT, 10) || 4300}`;
const OUT = path.join(__dirname, '..', '..', 'frontend', 'public', 'shots');
const EXPECT_HOUSE = 'House Umbral';

// 1440×900 at 2× — wide enough that the sidebar and the content both read, and
// retina so the images stay sharp when the landing page scales them down.
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;

// Looked up from the running demo rather than hardcoded: the seeder dates its
// signups relative to today, so a literal here would silently stop matching
// tomorrow and the party board would photograph itself empty.
let SIEGE_DATE = '';

// `wait` is a selector that must be on screen before the shutter, so a shot is
// never taken of a half-loaded page — the failure mode that produces a gallery
// of loading spinners nobody notices until it is live.
const SHOTS = [
  {
    name: 'signups',
    path: '/signups',
    wait: 'text=Guild Siege',
    // Open the first card so the roster, the role split and the waitlist are
    // all visible — collapsed, this page is just a list of titles.
    act: async (p) => { await p.locator('button:has-text("Guild Siege")').first().click(); },
  },
  {
    name: 'parties',
    path: '/admin/parties',
    wait: 'text=Absent',
    // The board defaults to today, which in the demo has no signup — so the
    // shot would be eleven empty boxes, which is a poor advertisement for a
    // party builder. Point it at the siege night and press Seed, which fills
    // the parties AND brings up the two things that make this page worth
    // having: the signup composition banner and the LOA warning.
    act: async (p) => {
      await p.locator('input[type=date]').first().fill(SIEGE_DATE);
      await p.locator('button:has-text("Seed parties")').first().waitFor({ timeout: 15_000 });
      await p.locator('button:has-text("Seed parties")').first().click();
    },
  },
  {
    name: 'attendance',
    path: '/admin/attendance',
    wait: 'text=Past Events',
    // Expand a logged night: collapsed, this page is a snap form and a list of
    // dates, and the thing worth showing is the table underneath — who was
    // there, who was excused, who signed up and then didn't turn up, and when
    // each row was recorded.
    act: async (p) => {
      await p.locator('button:has-text("Guild Field Boss")').first().click();
      // Scroll the empty snap form off the top. It is the first thing on the
      // page and the least interesting thing on it — left in frame, half the
      // screenshot is a blank form nobody has filled in. Anchored on the
      // pending-requests heading rather than a pixel count, so the shot doesn't
      // silently drift the next time the form above it changes height.
      await p.locator('text=Late attendance').first().scrollIntoViewIfNeeded();
    },
  },
  {
    // The member's half of the same feature. Worth its own frame: the officer
    // page shows the record, this shows the one thing a member can do about it.
    name: 'late-attendance',
    path: '/attendance',
    wait: 'text=My Attendance',
    act: async (p) => {
      const ask = p.locator('button:has-text("Request late attendance")').first();
      await ask.waitFor({ timeout: 15_000 });
      // Opened, so the frame shows what asking actually involves rather than
      // just a button that might do anything.
      await ask.click();
    },
  },
  { name: 'war-record', path: '/war-record', wait: 'text=UMBRA' },
  { name: 'roster', path: '/roster', wait: 'text=Aurelian' },
  { name: 'loot', path: '/admin/loot', wait: 'text=Loot Council' },
  { name: 'gear-levels', path: '/admin/gear-levels', wait: 'text=Aurelian' },
  { name: 'settings', path: '/admin/settings', wait: 'text=Guild tag' },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Fail early and clearly rather than timing out eight times over.
  try {
    const health = await fetch(`${BASE}/api/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`The demo is not answering on ${BASE} (${err.message}).\n  Start it first:  node scripts/demoServer.js`);
    process.exit(1);
  }

  const guild = await fetch(`${BASE}/api/guild`).then((r) => r.json()).catch(() => null);
  if (guild?.guild?.house !== EXPECT_HOUSE) {
    console.error(`Refusing to run: ${BASE} is serving "${guild?.guild?.house || 'something unknown'}", not the demo guild.\n`
      + '  These images end up on a public page. They may only ever contain invented data.');
    process.exit(1);
  }

  const feed = await fetch(`${BASE}/api/signups`).then((r) => r.json()).catch(() => null);
  SIEGE_DATE = feed?.signups?.find((x) => x.capacity)?.event_date || '';
  if (!SIEGE_DATE) console.warn('  note: no capped signup found — the party board will be shot empty.');

  // Uses the Edge that ships with Windows rather than downloading a browser —
  // playwright-core is the driver only, which keeps this out of the install
  // path for anyone deploying the app.
  const browser = await chromium.launch({ channel: process.env.DEMO_BROWSER || 'msedge' });
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: 'dark',
  });

  let taken = 0;
  for (const shot of SHOTS) {
    try {
      await page.goto(BASE + shot.path, { waitUntil: 'networkidle', timeout: 30_000 });
      if (shot.wait) {
        // Any one of the listed selectors will do — pages differ in what they
        // render when a section is empty, and demanding all of them would fail
        // a screenshot that is perfectly good.
        await Promise.any(shot.wait.split(', ').map((sel) => page.locator(sel).first().waitFor({ timeout: 15_000 })));
      }
      if (shot.act) await shot.act(page);
      // Animations and count-ups settle; without this the numbers are caught
      // mid-transition and the images look broken rather than alive.
      await page.waitForTimeout(900);
      const file = path.join(OUT, `${shot.name}.png`);
      await page.screenshot({ path: file });
      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log(`  ${shot.name.padEnd(14)} ${String(kb).padStart(4)} KB  ${shot.path}`);
      taken += 1;
    } catch (err) {
      // One bad page must not cost the other seven.
      console.error(`  ${shot.name.padEnd(14)} FAILED  ${err.message.split('\n')[0]}`);
    }
  }

  await browser.close();
  console.log(`\n${taken}/${SHOTS.length} written to frontend/public/shots/  (signed in as ${VIEWER.name})`);
  if (taken) console.log('Run `npm run build` in frontend/ so they are served at /shots/<name>.png');
})();
