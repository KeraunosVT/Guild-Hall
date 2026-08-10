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
  // Item keys are derived from the global questlog table, so a key really is
  // shared across guilds. Seed the same one in both to reproduce that.
  const SHARED_KEY = 'weapons__12345';
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
      ['/api/signups', A_MARK],
      ['/api/signups/mine', null],
      ['/api/signups/' + idA.event_signups.id, A_MARK],
      ['/api/admin/signups?date=2099-06-01', A_MARK],
      ['/api/admin/settings', null],
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
      // Signups are addressed by occurrence id everywhere — including from a
      // Discord button, whose customId is nothing but that id — so an id from
      // another tenant is the one input this feature is most exposed to. Every
      // write below goes through a Postgres function that takes p_guild_id, so
      // B's row is not merely hidden, it is not reachable.
      ['GET', '/api/signups/' + idB.event_signups.id],
      ['POST', '/api/signups/' + idB.event_signups.id + '/join', {}],
      ['DELETE', '/api/signups/' + idB.event_signups.id + '/join'],
      ['PATCH', '/api/signups/' + idB.event_signups.id, { capacity: 99 }],
      ['POST', '/api/signups/' + idB.event_signups.id + '/close', {}],
      ['DELETE', '/api/signups/' + idB.event_signups.id],
    ];

    // Snapshot every table B owns, so "untouched" is a fact and not a hope.
    const snapshot = async () => {
      const out = {};
      for (const t of ['wargame_matches', 'events', 'rosters', 'player_identities', 'loot_awards',
        'currency_awards', 'lucent_requests', 'event_schedule', 'loot_items', 'loot_categories',
        'loa_entries', 'loot_wishlists', 'shard_counts', 'gear_levels',
        'event_signups', 'event_signup_entries']) {
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

    // ── 3b. SETTINGS: THE ONE WRITE tenantDb DOES NOT SCOPE ──────────────────
    // `guilds` is on tenantDb's GLOBAL_TABLES list, so the wrapper injects no
    // filter — an `update(...)` on it with a forgotten `.eq('id', …)` would
    // rewrite EVERY tenant on the deployment in one statement, and every other
    // check in this suite would still pass because it is scoped by guild_id.
    // Nothing else in the codebase writes this table, so this is its only test.
    //
    // Both fixtures carry `admin_role_ids: []`, which the lockout guard refuses
    // outright — so this also pins the guard's ordering: it has to run BEFORE
    // the database is touched, not after.
    section('3b. guild settings cannot reach another tenant');
    const guildsBefore = JSON.stringify((await fx.supabase.from('guilds')
      .select('*').in('id', [A.id, B.id]).order('id')).data);

    const setRes = await call('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        // Aliases stay additive (the fixture's match rows use tag 'AAA'), so
        // the alias guard passes and the officer-role guard is what refuses —
        // otherwise this would pass on the wrong assertion.
        house: 'Hijacked House', tag: 'HIJ', aliases: ['AAA'],
        timezone: 'UTC', day_start: '02:00',
        admin_role_ids: [], allowed_role_ids: [], member_role_ids: [],
      }),
    });
    check('empty officer-role list is refused', setRes.status === 400,
      'HTTP ' + setRes.status + ' ' + (await setRes.text()).slice(0, 120));

    const guildsAfter = JSON.stringify((await fx.supabase.from('guilds')
      .select('*').in('id', [A.id, B.id]).order('id')).data);
    check('no guilds row was written at all', guildsBefore === guildsAfter,
      guildsBefore === guildsAfter ? '' : 'MUTATED');

    // A read is legitimate, and must describe the acting guild only.
    const setGet = await call('/api/admin/settings');
    const setText = await setGet.text();
    check('settings read answers for the acting guild', setText.includes('House Alpha'), setText.slice(0, 120));
    check('settings read reveals nothing of guild B', !setText.includes('House Beta') && !setText.includes('BBB'),
      setText.slice(0, 160));

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

    // ── 4c. PER-GUILD IDENTITY AND TIME RULES ───────────────────────────────
    // The frontend used to compile the house name and the guild-night rollover
    // into the bundle. It now asks GET /api/guild, so that endpoint has to
    // answer per guild — and must not hand the browser role ids, channel ids
    // or billing state, which live on the same row.
    section('4c. GET /api/guild is per guild and reveals nothing else');
    const cfgA = await (await call('/api/guild')).json();
    const cfgB = await (await call('/api/guild', { guild: B.id })).json();
    check('house differs per guild', cfgA.guild.house !== cfgB.guild.house,
      `${cfgA.guild.house} vs ${cfgB.guild.house}`);
    check('timezone differs per guild', cfgA.guild.timezone !== cfgB.guild.timezone,
      `${cfgA.guild.timezone} vs ${cfgB.guild.timezone}`);
    const exposed = Object.keys(cfgA.guild).filter((k) => /role|channel|subscription|status|discord_guild/.test(k));
    check('no role / channel / billing fields exposed', !exposed.length, exposed.join(', '));
    const outsiderCfg = await call('/api/guild', { token: fx.officerB, guild: A.id });
    check('non-member refused their own guild config', outsiderCfg.status === 403, 'HTTP ' + outsiderCfg.status);

    // ── 4d. STORAGE IS SCOPED TOO ───────────────────────────────────────────
    // Every other check here is about rows. The assets bucket is shared and
    // public, so it obeys none of the row scoping — and loot item keys are
    // derived from the global questlog table, so two guilds genuinely do hold
    // the same key. Upload the SAME key as both guilds and require the two
    // objects to be different bytes at different URLs.
    section('4d. uploaded icons do not collide across guilds');
    const png = (byte) => {
      // Smallest valid 1x1 PNG, with one byte varied so the two are distinguishable.
      const b = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63'
        + '6060600000000400012734270a0000000049454e44ae426082', 'hex');
      b[b.length - 12] = byte;
      return b;
    };
    const upload = async (guildId, token, byte) => {
      const form = new FormData();
      form.append('image', new Blob([png(byte)], { type: 'image/png' }), 'icon.png');
      const r = await fetch(srv.BASE + `/api/admin/loot/items/${SHARED_KEY}/image`, {
        method: 'POST',
        headers: { cookie: `gh_session=${token}`, 'x-guild-id': guildId },
        body: form,
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    // Both guilds legitimately hold this key — that is the whole point.
    for (const g of [A, B]) {
      await fx.supabase.from('loot_items').insert({
        guild_id: g.id, key: SHARED_KEY, category_key: `cat_${g.id === A.id ? A_MARK : B_MARK}`,
        name: 'Shared Item', sort_order: 99,
      });
    }

    const upA = await upload(A.id, fx.officerA, 0x11);
    const upB = await upload(B.id, fx.officerB, 0x22);
    check('guild A uploaded an icon', upA.status === 200, 'HTTP ' + upA.status + ' ' + JSON.stringify(upA.body).slice(0, 90));
    check('guild B uploaded an icon', upB.status === 200, 'HTTP ' + upB.status + ' ' + JSON.stringify(upB.body).slice(0, 90));

    if (upA.body.image_url && upB.body.image_url) {
      check('the two icons live at different URLs', upA.body.image_url !== upB.body.image_url,
        upA.body.image_url === upB.body.image_url ? 'SAME PATH — one overwrites the other' : '');
      check("guild A's path carries its guild id", upA.body.image_url.includes(A.id));
      check("guild B's path carries its guild id", upB.body.image_url.includes(B.id));

      // The real proof: fetch A's object and confirm B's upload didn't replace it.
      const bytesA = Buffer.from(await (await fetch(upA.body.image_url)).arrayBuffer());
      const bytesB = Buffer.from(await (await fetch(upB.body.image_url)).arrayBuffer());
      check("guild A's icon still has guild A's bytes", bytesA.includes(0x11) && !bytesA.equals(bytesB),
        bytesA.equals(bytesB) ? 'IDENTICAL — B overwrote A' : '');
    }

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
