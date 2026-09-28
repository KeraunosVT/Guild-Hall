// Threat board editing — crowns and new guilds — against an in-memory stand-in
// for Supabase. No database: what is pinned here is the module's own logic
// (which cluster a crown lands on, what a move does to it, when an edit is a
// no-op), which fails by drawing a plausible wrong board rather than erroring.
// The one-king-per-cluster rule itself is enforced by the database
// (migrations/saas_011); the fake enforces it too, so a code path that would
// trip the real index fails here as well.
const assert = require('assert');
const createThreatBoard = require('../threatBoard');

let passed = 0;
const pending = [];
const test = (name, fn) => pending.push([name, fn]);

// ── A minimal fake of the query builder calls threatBoard.js makes ───────────
function fakeSupabase(seed) {
  const tables = {
    threat_guilds: seed.guilds.map((g) => ({ cd: null, king: false, ...g })),
    threat_clusters: seed.clusters.map((label, position) => ({ label, servers: label, position })),
    threat_alliances: [],
  };
  let nextId = 1000;
  const oneKingPerCluster = () => {
    const seen = new Set();
    for (const g of tables.threat_guilds.filter((x) => x.king)) {
      if (seen.has(g.cluster)) throw new Error(`index violation: two kings on ${g.cluster}`);
      seen.add(g.cluster);
    }
  };

  function builder(table) {
    const filters = [];
    let op = 'select';
    let payload = null;
    const rows = () => tables[table].filter((r) => filters.every(([k, v]) => r[k] === v));
    const run = () => {
      if (op === 'update') {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, payload));
        oneKingPerCluster();
        return hit;
      }
      if (op === 'insert') {
        const row = { id: `g${nextId++}`, ...payload };
        tables[table].push(row);
        return [row];
      }
      return rows();
    };
    const b = {
      select() { return b; },
      eq(k, v) { filters.push([k, v]); return b; },
      order() { return b; },
      update(row) { op = 'update'; payload = row; return b; },
      insert(row) { op = 'insert'; payload = row; return b; },
      async maybeSingle() { const r = run(); return { data: r[0] ? { ...r[0] } : null, error: null }; },
      async single() { const r = run(); return { data: { ...r[0] }, error: null }; },
    };
    return b;
  }

  return {
    tables,
    from: builder,
    // The SQL function, re-implemented: uncrown the holder, then crown.
    async rpc(name, { p_guild: id, p_actor: actor }) {
      assert.strictEqual(name, 'set_threat_king');
      const g = tables.threat_guilds.find((x) => x.id === id);
      if (!g) return { data: null, error: { message: 'That guild is not on the board.' } };
      const prev = tables.threat_guilds.find((x) => x.cluster === g.cluster && x.king && x.id !== id);
      if (prev) Object.assign(prev, { king: false, updated_by: actor });
      Object.assign(g, { king: true, updated_by: actor });
      oneKingPerCluster();
      return { data: prev ? prev.id : null, error: null };
    },
  };
}

const fresh = () => {
  const db = fakeSupabase({
    clusters: ['DESPAIR', 'ASCENSION'],
    guilds: [
      { id: 'appa', name: 'Appa', cluster: 'DESPAIR', status: 'Rebuild/TBD', king: true },
      { id: 'dusk', name: 'Dusk', cluster: 'DESPAIR', status: 'Not Competitive' },
      { id: 'gap', name: 'Gear Gap (FTP)', cluster: 'ASCENSION', status: 'Threat', king: true },
      { id: 'ping', name: 'Ping Gap (Ma Vontade)', cluster: 'ASCENSION', status: 'Threat' },
    ],
  });
  return { db, board: createThreatBoard(db) };
};
const kingOf = (db, cluster) => db.tables.threat_guilds.filter((g) => g.cluster === cluster && g.king).map((g) => g.id);

console.log('crown');
test('crowning a guild takes the crown from the holder', async () => {
  const { db, board } = fresh();
  const out = await board.updateGuild('dusk', { king: true }, 'staff');
  assert.deepStrictEqual(kingOf(db, 'DESPAIR'), ['dusk']);
  assert.strictEqual(out.previousKing, 'Appa');
  assert.strictEqual(out.king, true);
});
test('uncrowning leaves the cluster with no king', async () => {
  const { db, board } = fresh();
  await board.updateGuild('appa', { king: false }, 'staff');
  assert.deepStrictEqual(kingOf(db, 'DESPAIR'), []);
});
test('crowning the current holder again is "nothing to change"', async () => {
  const { board } = fresh();
  await assert.rejects(board.updateGuild('appa', { king: true }, 'staff'), /Nothing to change/);
});
test('a king that moves servers leaves its crown behind', async () => {
  const { db, board } = fresh();
  const out = await board.updateGuild('appa', { cluster: 'ASCENSION' }, 'staff');
  assert.deepStrictEqual(kingOf(db, 'DESPAIR'), []);
  assert.deepStrictEqual(kingOf(db, 'ASCENSION'), ['gap']);
  assert.strictEqual(out.crownDropped, true);
});
test('moving AND crowning lands the crown on the new cluster', async () => {
  const { db, board } = fresh();
  const out = await board.updateGuild('dusk', { cluster: 'ASCENSION', king: true }, 'staff');
  assert.deepStrictEqual(kingOf(db, 'DESPAIR'), ['appa']);
  assert.deepStrictEqual(kingOf(db, 'ASCENSION'), ['dusk']);
  assert.strictEqual(out.previousKing, 'Gear Gap (FTP)');
});
test('a crown that is not a boolean is refused', async () => {
  const { board } = fresh();
  await assert.rejects(board.updateGuild('dusk', { king: 'yes' }, 'staff'), /true or false/);
});
test('ordinary edits still work and leave the crown alone', async () => {
  const { db, board } = fresh();
  await board.updateGuild('appa', { status: 'Threat' }, 'staff');
  assert.deepStrictEqual(kingOf(db, 'DESPAIR'), ['appa']);
  assert.strictEqual(db.tables.threat_guilds.find((g) => g.id === 'appa').status, 'Threat');
});

console.log('adding guilds');
test('a new guild joins its cluster uncrowned', async () => {
  const { db, board } = fresh();
  const g = await board.addGuild({ name: '  Nightfall ', cluster: 'DESPAIR', status: 'Competitive' }, 'staff');
  assert.strictEqual(g.name, 'Nightfall');
  assert.strictEqual(g.king, false);
  assert.strictEqual(g.updated_by, 'staff');
  assert.ok(db.tables.threat_guilds.some((x) => x.name === 'Nightfall' && x.cluster === 'DESPAIR'));
});
test('the rating defaults to Potential', async () => {
  const { board } = fresh();
  assert.strictEqual((await board.addGuild({ name: 'New', cluster: 'DESPAIR' }, 'staff')).status, 'Potential');
});
test('a name already on that cluster is refused', async () => {
  const { board } = fresh();
  await assert.rejects(board.addGuild({ name: 'Dusk', cluster: 'DESPAIR' }, 'staff'), /already has a guild called "Dusk"/);
});
test('the same name on a different cluster is fine', async () => {
  const { board } = fresh();
  const g = await board.addGuild({ name: 'Dusk', cluster: 'ASCENSION' }, 'staff');
  assert.strictEqual(g.cluster, 'ASCENSION');
});
test('an unknown cluster, blank name or bad rating is refused', async () => {
  const { board } = fresh();
  await assert.rejects(board.addGuild({ name: 'X', cluster: 'ATLANTIS' }, 'staff'), /Unknown cluster/);
  await assert.rejects(board.addGuild({ name: '   ', cluster: 'DESPAIR' }, 'staff'), /needs a name/);
  await assert.rejects(board.addGuild({ name: 'X', cluster: 'DESPAIR', status: 'Scary' }, 'staff'), /Unknown status/);
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed} passed`);
})();
