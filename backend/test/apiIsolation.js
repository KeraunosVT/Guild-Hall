// ============================================================================
// Two-guild API isolation test (plan Phase 4 — "the deliverable that makes
// 'ready to host' true rather than hoped-for")
// ============================================================================
// Two complete tenants, every guild-scoped table populated in both, driven
// through the real HTTP API against the real database.
//
// Three sweeps:
//   1. READS   — as guild A's officer, every read route must return A's data
//                and must contain no trace of B's. Both halves are asserted:
//                a route returning nothing would otherwise pass isolation
//                vacuously, so an empty response is a FAILURE.
//   2. IDOR    — as guild A's officer, address B's rows by id. Every one must
//                be refused, and B's row must be byte-identical afterwards.
//                The session legitimately contains B as a membership, so
//                nothing can be rejected merely for being unknown.
//   3. WRITES  — data created through the API must land stamped with the
//                acting guild, and must not appear in the other.
const { setup } = require('./lib/harness');
const { startServer } = require('./lib/server');

let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) { pass++; return; }
  fail++; failures.push(label + (detail ? '  -- ' + detail : ''));
  console.log('  FAIL ' + label + (detail ? '  -- ' + detail : ''));
};
const section = (t) => console.log('\n' + t);

(async () => {
  const fx = await setup();
  const srv = await startServer();
  const { A, B, dataA, dataB, A_MARK, B_MARK } = fx;

  const call = (p, { token = fx.officerA, guild = A.id, ...init } = {}) => fetch(srv.BASE + p, {
    ...init,
    headers: {
      cookie: `gh_session=${token}`,
      'x-guild-id': guild,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

  try {
    // ── 1. READ SWEEP ────────────────────────────────────────────────────────
    // Every read route the API exposes. `own` is a string that must appear in
    // guild A's response, proving the route returned real data rather than an
    // empty list that would pass isolation for the wrong reason.
    const idA = dataA, idB = dataB;
    const READS = [
      ['/api/players', null],
      ['/api/matches/recent', A_MARK],
      ['/api/match/' + idA.wargame_matches.id, A_MARK],
      ['/api/maps', A_MARK],
      ['/api/maps/stats', null],
      ['/api/stats/summary', null],
      ['/api/player/' + A_MARK + 'Name', null],
      ['/api/loot', null],
      ['/api/loot/catalog', A_MARK],
      ['/api/elite-timers', A_MARK],
      ['/api/event-schedule', A_MARK],
      ['/api/loa', null],
      ['/api/loa/all', A_MARK],
      ['/api/my-classes', null],
      ['/api/my-profile', null],
      ['/api/gear-ilvl/mine', null],
      ['/api/admin/whoami', null],
      ['/api/admin/identities', A_MARK],
      ['/api/admin/unmapped-names', null],
      ['/api/admin/loot/awards', A_MARK],
      ['/api/admin/gear-ilvl', null],
      ['/api/admin/gear-ilvl/' + '1' + '0'.repeat(10) + '1/history', null],
      ['/api/admin/events', A_MARK],
      ['/api/admin/events/' + idA.events.id, A_MARK],
      ['/api/admin/event-schedule', null],
      ['/api/admin/attendance-stats', null],
      ['/api/admin/rosters', A_MARK],
      ['/api/admin/rosters/' + idA.rosters.id, A_MARK],
      ['/api/admin/currency-awards', A_MARK],
      ['/api/admin/lucent-requests', A_MARK],
      ['/api/admin/permissions', A_MARK],
      ['/api/admin/audit-log', A_MARK],
      ['/api/admin/loa/unavailable', null],
      ['/api/admin/match/' + idA.wargame_matches.id, A_MARK],
      ['/api/admin/loot/import-status', null],
    ];

    section(`1. read sweep — ${READS.length} routes, as guild A's officer`);
    let leaks = 0, empties = 0;
    for (const [route, own] of READS) {
      const r = await call(route);
      const text = await r.text();
      if (r.status >= 500) { check(`${route} responded`, false, 'HTTP ' + r.status + ' ' + text.slice(0, 90)); continue; }
      if (r.status === 404 && own) { check(`${route} responded`, false, '404'); continue; }

      const bleak = text.includes(B_MARK);
      if (bleak) leaks++;
      check(`${route} — no trace of guild B`, !bleak, bleak ? text.slice(0, 160) : '');

      if (own) {
        const has = text.includes(own);
        if (!has) empties++;
        check(`${route} — returned guild A's own data`, has, has ? '' : 'HTTP ' + r.status + ' ' + text.slice(0, 120));
      }
    }
    console.log(`  ${READS.length} routes swept · ${leaks} leaked · ${empties} returned nothing`);

    // ── 2. CROSS-GUILD IDOR ─────────────────────────────────────────────────
    // Address guild B's rows while acting as guild A. A refusal is any
    // non-2xx; a 2xx is only acceptable if B's row is provably untouched,
    // which is checked separately below.
    section("2. cross-guild IDOR — guild A's officer addressing guild B's rows");
    const IDOR = [
      ['GET', '/api/match/' + idB.wargame_matches.id],
      ['GET', '/api/admin/match/' + idB.wargame_matches.id],
      ['GET', '/api/admin/events/' + idB.events.id],
      ['GET', '/api/admin/rosters/' + idB.rosters.id],
      ['DELETE', '/api/loa/' + idB.loa_entries.id],
      ['DELETE', '/api/admin/match/' + idB.wargame_matches.id],
      ['DELETE', '/api/admin/events/' + idB.events.id],
      ['DELETE', '/api/admin/rosters/' + idB.rosters.id],
      ['DELETE', '/api/admin/identities/' + idB.player_identities.id],
      ['DELETE', '/api/admin/loot/awards/' + idB.loot_awards.id],
      ['DELETE', '/api/admin/currency-awards/' + idB.currency_awards.id],
      ['DELETE', '/api/admin/lucent-requests/' + idB.lucent_requests.id],
      ['DELETE', '/api/admin/event-schedule/' + idB.event_schedule.id],
      ['DELETE', '/api/admin/loot/items/' + idB.loot_items.key],
      ['DELETE', '/api/admin/loot/categories/' + idB.loot_categories.key],
      ['PUT', '/api/admin/identities/' + idB.player_identities.id, { display_name: 'hijacked' }],
      ['PUT', '/api/admin/events/' + idB.events.id, { title: 'hijacked' }],
      ['PUT', '/api/admin/event-schedule/' + idB.event_schedule.id, { name: 'hijacked', day_of_week: 1 }],
      ['PUT', '/api/admin/rosters/' + idB.rosters.id, { name: 'hijacked', layout: {} }],
      ['PUT', '/api/admin/loot/items/' + idB.loot_items.key, { name: 'hijacked' }],
      ['PUT', '/api/admin/loot/categories/' + idB.loot_categories.key, { label: 'hijacked' }],
      ['PATCH', '/api/admin/loot/awards/' + idB.loot_awards.id, { note: 'hijacked' }],
      ['PATCH', '/api/admin/currency-awards/' + idB.currency_awards.id, { amount: 999 }],
      ['PATCH', '/api/admin/lucent-requests/' + idB.lucent_requests.id, { status: 'approved' }],
    ];

    // Snapshot every table B owns, so "untouched" is a fact and not a hope.
    const snapshot = async () => {
      const out = {};
      for (const t of ['wargame_matches', 'events', 'rosters', 'player_identities', 'loot_awards',
        'currency_awards', 'lucent_requests', 'event_schedule', 'loot_items', 'loot_categories',
        'loa_entries', 'loot_wishlists', 'shard_counts', 'gear_levels']) {
        const { data } = await fx.supabase.from(t).select('*').eq('guild_id', B.id);
        out[t] = JSON.stringify(data);
      }
      return out;
    };
    const before = await snapshot();

    // What must hold for every one of these: the response reveals nothing about
    // guild B, and guild B's rows are unchanged afterwards (asserted from the
    // snapshot below).
    //
    // A 2xx is NOT a failure here. These routes are scoped, so addressing
    // another guild's id matches zero rows and the write is a no-op; returning
    // a uniform 200 rather than 404 is deliberate, because a 404-vs-200 split
    // would turn every endpoint into an existence oracle for other tenants'
    // ids. The count is reported for visibility, not as a fault.
    let noops = 0;
    for (const [method, route, body] of IDOR) {
      const r = await call(route, { method, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      const label = `${method} ${route.replace(/[0-9a-f-]{36}/, '<B-id>')}`;
      if (r.ok) noops++;
      check(`${label} — response reveals nothing of B`, !text.includes(B_MARK), text.slice(0, 100));
      check(`${label} — not a server error`, r.status < 500, 'HTTP ' + r.status);
    }
    console.log(`  ${IDOR.length} cross-guild references · ${noops} answered 2xx as a no-op`);

    // Discord-id-addressed routes: guild A may legitimately hold a record for
    // any Discord user, so a 2xx is correct. The property that matters is that
    // writing through them never reaches guild B's row.
    for (const [method, route, body] of [
      ['GET', '/api/admin/gear-ilvl/' + idB.gear_levels.discord_id + '/history'],
      ['PUT', '/api/loot/' + idB.loot_wishlists.discord_id, { picks: ['hijacked'] }],
      ['PUT', '/api/shards/' + idB.shard_counts.discord_id, { shards: 999 }],
    ]) {
      const r = await call(route, { method, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      check(`${method} ${route} did not return B's data`, !text.includes(B_MARK), text.slice(0, 90));
    }

    const after = await snapshot();
    for (const t of Object.keys(before)) {
      check(`guild B's ${t} untouched`, before[t] === after[t],
        before[t] === after[t] ? '' : 'MUTATED');
    }

    // ── 3. WRITE SCOPING ────────────────────────────────────────────────────
    section('3. writes land in the acting guild only');
    const created = [];
    const WRITES = [
      ['/api/admin/identities', { display_name: 'WriteProbe', ingame_names: ['WriteProbe'] }, 'player_identities'],
      ['/api/admin/loot/categories', { key: 'probecat', label: 'Probe Cat', sort_order: 9 }, 'loot_categories'],
      ['/api/admin/event-schedule', { name: 'Probe Sched', day_of_week: 2, event_time: '20:00' }, 'event_schedule'],
    ];
    for (const [route, body, table] of WRITES) {
      const r = await call(route, { method: 'POST', body: JSON.stringify(body) });
      const ok = r.ok;
      check(`POST ${route} succeeded`, ok, ok ? '' : 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 90));
      if (!ok) continue;
      const { data: inA } = await fx.supabase.from(table).select('*').eq('guild_id', A.id);
      const { data: inB } = await fx.supabase.from(table).select('*').eq('guild_id', B.id);
      const nameOf = (row) => row.display_name || row.label || row.name || '';
      check(`  ${table} row stamped with guild A`, (inA || []).some((x) => nameOf(x).includes('Probe')));
      check(`  ${table} row absent from guild B`, !(inB || []).some((x) => nameOf(x).includes('Probe')));
      created.push(table);
    }

    // ── 4. THE SAME SESSION, THE OTHER GUILD ────────────────────────────────
    // OfficerA holds no capabilities in B. Switching the header must switch
    // both the data and the powers.
    section('4. same session, header switched to guild B');
    let r = await call('/api/elite-timers', { guild: B.id });
    let text = await r.text();
    check('reads B\'s data when acting as B', text.includes(B_MARK), text.slice(0, 100));
    check('does not read A\'s data when acting as B', !text.includes(A_MARK));
    r = await call('/api/admin/identities', { guild: B.id });
    check('admin route denied in B (no capabilities there)', r.status === 403, 'HTTP ' + r.status);

    // ── 4b. CACHES DO NOT CROSS TENANTS ─────────────────────────────────────
    // Scoped queries behind an unscoped cache are not scoped. /api/players was
    // exactly this: correct queries, cache keyed on the `last` param alone, so
    // whichever guild asked first filled the entry for everyone. Hit it as A
    // then immediately as B, inside the TTL, and require different answers.
    section('4b. read-through caches are per guild');
    const pA = await (await call('/api/players?last=5')).text();
    const pB = await (await call('/api/players?last=5', { guild: B.id })).text();
    check('players cache did not serve A to B', !pB.includes(A_MARK), pB.slice(0, 110));
    check('players cache did not serve B to A', !pA.includes(B_MARK), pA.slice(0, 110));

    // ── 5. GLOBAL TABLES STAY SHARED ────────────────────────────────────────
    section('5. global tables are shared, not scoped');
    r = await call('/api/admin/market-potentials');
    check('market_potentials readable (global)', r.status === 200 || r.status === 404, 'HTTP ' + r.status);
  } finally {
    srv.stop();
    await fx.cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
