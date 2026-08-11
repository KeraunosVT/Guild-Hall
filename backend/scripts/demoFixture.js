// ============================================================================
// The demo guild's cast and constants — shared by the seeder and the Discord
// stub so the two can never disagree about who exists.
// ============================================================================
// If the stub served a member list that the database's member_roles rows didn't
// match, the roster would show people with no role and the party builder would
// refuse to seed — a demo that looks broken for a reason that has nothing to do
// with the app. One list, imported by both.

// Fixed ids so a re-seed replaces the demo rather than stacking a second one,
// and so `--purge` can always find it. Deliberately in a range no real Discord
// snowflake occupies (they encode a timestamp; 8.1e16 is year 2100+).
const DEMO_DISCORD_GUILD = '810000000000000001';

// The tenant uuid, pinned rather than generated. Re-seeding purges and
// re-inserts, so a generated id would be different every time — and the demo
// server pins SINGLE_GUILD_ID to whatever it found at boot, which means a
// re-seed would silently orphan a running demo. Every page would answer as if
// the guild had been deleted, which it had.
//
// Hex only — Postgres rejects a uuid with a letter past 'f' in it, so the
// obvious-looking 'd3m0…' spelling is not available.
const DEMO_GUILD_ID = 'deadbee5-0000-4000-8000-000000000001';

const ROLE_OFFICER = '810000000000000101';
const ROLE_MEMBER = '810000000000000102';
const ROLE_RAIDER = '810000000000000103';
const ROLE_TRIAL = '810000000000000104';

const ROLES = [
  { id: ROLE_OFFICER, name: 'Officer', color: 0xd64545, position: 40 },
  { id: ROLE_RAIDER, name: 'Raider', color: 0xd8ab5e, position: 30 },
  { id: ROLE_MEMBER, name: 'Member', color: 0x5865f2, position: 20 },
  { id: ROLE_TRIAL, name: 'Trial', color: 0x8a8a8d, position: 10 },
];

const uid = (n) => `81000000000${String(n).padStart(6, '0')}`;

// 24 members: enough to fill four parties with people left over, which is the
// only size at which the party builder and the waitlist look like themselves.
//
// `role` is what lands in member_roles.pvp_role and must be spelled exactly
// 'Tank' | 'DPS' | 'Healer' — eventSignups.roleOf() matches case-sensitively,
// and a lowercase 'dps' silently becomes "no role on file".
//
// Four members deliberately have NO role: that group is its own column on the
// signup embed and its own warning in the party builder, and a demo where it is
// always empty hides the feature.
const MEMBERS = [
  { n: 1, name: 'Aurelian', role: 'Tank', classes: ['SnSGreatsword'], gear: 78, officer: true },
  { n: 2, name: 'Brannoc', role: 'Tank', classes: ['SnSWand'], gear: 74 },
  { n: 3, name: 'Caradoc', role: 'Tank', classes: ['SnSGreatsword'], gear: 69 },
  { n: 4, name: 'Delwyn', role: 'Healer', classes: ['WandLongbow'], gear: 80, officer: true },
  { n: 5, name: 'Eirwen', role: 'Healer', classes: ['WandDagger'], gear: 72 },
  { n: 6, name: 'Faelan', role: 'Healer', classes: ['WandLongbow'], gear: 66 },
  { n: 7, name: 'Gwyneira', role: 'Healer', classes: ['WandDagger'], gear: 63 },
  { n: 8, name: 'Hafgan', role: 'DPS', classes: ['GreatswordDagger'], gear: 80 },
  { n: 9, name: 'Idris', role: 'DPS', classes: ['CrossbowDagger'], gear: 79 },
  { n: 10, name: 'Jorunn', role: 'DPS', classes: ['StaffDagger'], gear: 77 },
  { n: 11, name: 'Kelwyn', role: 'DPS', classes: ['LongbowDagger'], gear: 76 },
  { n: 12, name: 'Lorcan', role: 'DPS', classes: ['GreatswordDagger'], gear: 74 },
  { n: 13, name: 'Maelor', role: 'DPS', classes: ['SpearDagger'], gear: 72 },
  { n: 14, name: 'Nerys', role: 'DPS', classes: ['StaffLongbow'], gear: 70 },
  { n: 15, name: 'Osian', role: 'DPS', classes: ['CrossbowGreatsword'], gear: 68 },
  { n: 16, name: 'Peredur', role: 'DPS', classes: ['DaggerOrb'], gear: 66 },
  { n: 17, name: 'Rhiannon', role: 'DPS', classes: ['StaffDagger'], gear: 64 },
  { n: 18, name: 'Seren', role: 'DPS', classes: ['LongbowDagger'], gear: 61 },
  { n: 19, name: 'Taliesin', role: 'DPS', classes: ['GreatswordSpear'], gear: 58 },
  { n: 20, name: 'Ualan', role: 'DPS', classes: ['CrossbowOrb'], gear: 56 },
  // No role on file — the group every other surface counts separately.
  { n: 21, name: 'Vaughn', role: null, classes: [], gear: 54, trial: true },
  { n: 22, name: 'Wynne', role: null, classes: [], gear: 52, trial: true },
  { n: 23, name: 'Yestin', role: null, classes: [], gear: 50, trial: true },
  { n: 24, name: 'Zephyrine', role: null, classes: [], gear: 0, trial: true },
].map((m) => ({
  ...m,
  id: uid(m.n),
  // Everyone is a Member; officers add Officer, trials swap to Trial. The
  // guild's member_role_ids lists Member and Trial, so the roster is everyone.
  discordRoles: [
    m.trial ? ROLE_TRIAL : ROLE_MEMBER,
    ...(m.officer ? [ROLE_OFFICER] : []),
    ...(!m.trial ? [ROLE_RAIDER] : []),
  ],
}));

// Whoever the browser is signed in as. An officer, because the point of the
// demo is to see the officer surfaces.
const VIEWER = MEMBERS[0];

module.exports = {
  DEMO_DISCORD_GUILD, DEMO_GUILD_ID,
  ROLE_OFFICER, ROLE_MEMBER, ROLE_RAIDER, ROLE_TRIAL,
  ROLES, MEMBERS, VIEWER,
};
