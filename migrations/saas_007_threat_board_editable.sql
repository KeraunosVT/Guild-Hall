-- saas_007_threat_board_editable.sql — make the board itself editable.
--
-- Run this in the Supabase SQL editor of BOTH projects, AFTER saas_006, and
-- then run saas_008 — which is not optional.
--
-- ⚠ SUPERSEDED IN PART BY saas_008. The key chosen below is wrong: it makes
-- threat_guilds.name the primary key, which cannot hold two guilds of the same
-- name on different servers, and the Americas board has exactly that
-- ("Original Sin" plays on ENCHANTED and DISTORTION). Run on its own, this file
-- seeds 129 of the board's 130 guilds and drops the second one silently.
-- saas_008 re-keys the table by a surrogate id and puts the missing guild back.
-- The pair still lands correctly on a fresh install; read saas_008 for why.
--
-- ── WHY THE BOARD MOVES OUT OF THE FLAT FILE ────────────────────────────────
-- Until now shared/threatBoard.json was the whole board: which guilds exist,
-- which cluster each sits on, how dangerous it is, and its server's transfer
-- cooldown. That was right while the data was a one-way import of somebody
-- else's spreadsheet — nobody edited it here, so a file that ships with the
-- build was the simplest thing that could work.
--
-- It stops being right the moment guilds are edited in the app. Ratings change
-- after a siege, guilds rename, and — the case the file handles worst — a guild
-- transfers servers and has to move between clusters. None of that can be
-- written to a file baked into the bundle at build time.
--
-- So the rows move here and the JSON becomes a SEED, not a source of truth.
-- The import script still refreshes the file from the spreadsheet, but the
-- board the app reads is this table.
--
-- ── WHY name IS THE PRIMARY KEY ─────────────────────────────────────────────
-- A mutable natural key is normally a poor primary key, and a surrogate id
-- would be the textbook choice. It is deliberate here: threat_alliances already
-- addresses guilds BY NAME (see saas_006 — the alliance map predates this table
-- and there was no stable id upstream to point at), so making name the key is
-- what lets the foreign keys below carry ON UPDATE CASCADE.
--
-- That cascade is the entire point. Renaming a guild has to move its alliance
-- with it, and a rename that silently orphaned both halves of a bond is exactly
-- the kind of quiet corruption this schema is shaped to prevent. With the
-- cascade, a rename is one UPDATE and the bond follows automatically; without
-- it, every future code path touching names would have to remember.
--
-- ── ORDER MATTERS IN THIS FILE ──────────────────────────────────────────────
-- The seed runs BEFORE the foreign keys are added. It has to: threat_alliances
-- may already hold bonds, and adding a key against an empty table would reject
-- every one of them. Seed first, constrain second, all in one transaction.

begin;

create table if not exists threat_guilds (
  name       text primary key,
  cluster    text not null,
  status     text not null,
  -- Remaining character-transfer cooldown on this guild's server, or null when
  -- the sheet recorded none.
  cd         text,
  -- Holds the cluster. Not edited in the app yet — it comes from the import and
  -- there is exactly one per cluster, so changing it is a two-row operation the
  -- UI does not offer.
  king       boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text,
  -- Both are closed sets. A typo in either would render as an unstyled chip and
  -- silently drop out of every filter, so the database refuses it outright.
  constraint threat_guilds_status_valid check (status in
    ('Threat','Competitive','Potential','Rebuild/TBD','Not Competitive','Disbanded/Merged')),
  constraint threat_guilds_cd_valid check (cd is null or cd in ('30 Days','15 Days','No CD')),
  constraint threat_guilds_name_not_blank check (length(trim(name)) > 0)
);

-- The five Americas clusters. A table rather than a hardcoded list so a guild
-- can only ever be moved to a cluster that exists — see the foreign key below.
create table if not exists threat_clusters (
  label    text primary key,
  servers  text not null,
  position int  not null
);

insert into threat_clusters (label, servers, position) values
  ('DESPAIR', 'Zairos + Oblivion + Moonstone + Invoker', 0),
  ('ASCENSION', 'Adrenaline + Carnage', 1),
  ('DISTORTION', 'Snowburn + Stellarite', 2),
  ('ENCHANTED', 'Ivory + Vulcan + Roen', 3),
  ('ECLIPSE', 'Deluzhnoa + Starlight + Resistance + Eldritch', 4)
on conflict (label) do update set servers = excluded.servers, position = excluded.position;

-- Seed from shared/threatBoard.json as imported from the community sheet.
-- ON CONFLICT DO NOTHING so re-running this file never clobbers edits made in
-- the app — a migration that quietly reverted a month of corrections would be
-- worse than one that fails loudly.
insert into threat_guilds (name, cluster, status, cd, king) values
  ('Appa', 'DESPAIR', 'Rebuild/TBD', 'No CD', true),
  ('Gear Gap (FTP)', 'ASCENSION', 'Threat', 'No CD', true),
  ('Missionary', 'DISTORTION', 'Potential', 'No CD', true),
  ('Undercooked', 'ENCHANTED', 'Threat', 'No CD', true),
  ('Lokthar', 'ECLIPSE', 'Potential', 'No CD', true),
  ('Dusk', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Ping Gap (Ma Vontade)', 'ASCENSION', 'Threat', '30 Days', false),
  ('Backshotz', 'DISTORTION', 'Competitive', 'No CD', false),
  ('Jailed', 'ENCHANTED', 'Threat', 'No CD', false),
  ('Project Nix', 'ECLIPSE', 'Potential', 'No CD', false),
  ('Unhinged', 'DESPAIR', 'Competitive', '15 Days', false),
  ('Villainous', 'ASCENSION', 'Potential', 'No CD', false),
  ('Lotus', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('Pirates', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('NHOX', 'ECLIPSE', 'Potential', '15 Days', false),
  ('Big Chillin', 'DESPAIR', 'Competitive', '15 Days', false),
  ('REEPORS', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('DehydratedGamers', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('The Cyndicate', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('Enfasis', 'ECLIPSE', 'Not Competitive', '15 Days', false),
  ('Supple', 'DESPAIR', 'Competitive', '30 Days', false),
  ('Repentant Faith', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Swoosh', 'DISTORTION', 'Potential', '15 Days', false),
  ('Metamorphosis', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('Hanami', 'ECLIPSE', 'Rebuild/TBD', '15 Days', false),
  ('MILK', 'DESPAIR', 'Competitive', 'No CD', false),
  ('WANTED', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Paragon', 'DISTORTION', 'Potential', '15 Days', false),
  ('Jasmine Dragons', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('Epoca Dourada', 'ECLIPSE', 'Not Competitive', 'No CD', false),
  ('Ting Force One', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Uppies', 'DISTORTION', 'Potential', '15 Days', false),
  ('Lost Tavern', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('ReaperZ', 'ECLIPSE', 'Not Competitive', 'No CD', false),
  ('Zenkai', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Mimirca', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('The Privateers', 'DISTORTION', 'Not Competitive', '15 Days', false),
  ('Original Sin', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('OsPaisdeFamilia', 'ECLIPSE', 'Not Competitive', 'No CD', false),
  ('Hated', 'DESPAIR', 'Potential', 'No CD', false),
  ('Ripley Rebellion', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Darkness', 'DISTORTION', 'Potential', '30 Days', false),
  ('OFF META', 'ECLIPSE', 'Not Competitive', 'No CD', false),
  ('Revenants', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Threnody', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Endurance', 'DISTORTION', 'Potential', '30 Days', false),
  ('Delirium', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('LMTYS', 'ECLIPSE', 'Not Competitive', 'No CD', false),
  ('Badrep', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Twisted Fates', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Abandoned', 'DISTORTION', 'Potential', '15 Days', false),
  ('Blair', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('Scarlet Lotus', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Cursed Touch', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Zenith', 'ECLIPSE', 'Disbanded/Merged', 'No CD', false),
  ('Animate', 'DISTORTION', 'Potential', 'No CD', false),
  ('Syndicate', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('NN', 'ECLIPSE', 'Disbanded/Merged', 'No CD', false),
  ('Sacred knightz', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('SchoolOfTheWolf', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Preguicinha', 'ECLIPSE', 'Disbanded/Merged', 'No CD', false),
  ('Virtuous', 'DISTORTION', 'Potential', '15 Days', false),
  ('Fedaykins', 'ENCHANTED', 'Not Competitive', 'No CD', false),
  ('Machado', 'ECLIPSE', 'Disbanded/Merged', 'No CD', false),
  ('Kaoanashi', 'DESPAIR', 'Potential', 'No CD', false),
  ('GarraNocturna', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Flame', 'ECLIPSE', 'Disbanded/Merged', 'No CD', false),
  ('Nube Tormenta', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('Bubble Blowers', 'ENCHANTED', 'Disbanded/Merged', 'No CD', false),
  ('Kingless', 'ECLIPSE', 'Disbanded/Merged', 'No CD', false),
  ('Baywatch', 'DESPAIR', 'Potential', 'No CD', false),
  ('Glass Cannon', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Isekaid', 'ENCHANTED', 'Disbanded/Merged', 'No CD', false),
  ('Acme', 'ECLIPSE', 'Disbanded/Merged', 'No CD', false),
  ('Sangre Latina', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('Nordik', 'ENCHANTED', 'Disbanded/Merged', 'No CD', false),
  ('Language Barrier', 'ECLIPSE', 'Disbanded/Merged', 'No CD', false),
  ('Horizon', 'DESPAIR', 'Potential', '30 Days', false),
  ('SquanchySquad', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('GOMDOL', 'ENCHANTED', 'Disbanded/Merged', 'No CD', false),
  ('Ma Vontade (transfer)', 'ECLIPSE', 'Disbanded/Merged', 'No CD', false),
  ('xxxWICKEDxxx', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('CURSED', 'ENCHANTED', 'Disbanded/Merged', 'No CD', false),
  ('Boba Tea', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Barely Active', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('KittyDeathCult', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('Straw Hats', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Sprouts', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Voidwalker', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('Poached', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Immortal', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Virtue', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('Hive', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('The Voidbourne', 'ASCENSION', 'Not Competitive', 'No CD', false),
  ('Slappin Em', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('Division XII', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Disregarded', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Huracan', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Evicted', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('-Akatsuki-', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Glassy', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Menace', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Stay Loyal', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('Night Raid', 'DESPAIR', 'Not Competitive', 'No CD', false),
  ('Mictlan', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('NoDamage', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Original Sin', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('Corgi Club', 'DESPAIR', 'Disbanded/Merged', 'No CD', false),
  ('Yoink亗', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Cream', 'DESPAIR', 'Disbanded/Merged', 'No CD', false),
  ('Sails', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Abyss', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('DefinitelyaCult', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Los Michis', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('SAUVAGE', 'DISTORTION', 'Not Competitive', 'No CD', false),
  ('WeTheOpps', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('TRICKSTER', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('SmokeTopia', 'DISTORTION', 'Disbanded/Merged', 'No CD', false),
  ('Betrayed', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Supple Dash', 'DISTORTION', 'Disbanded/Merged', 'No CD', false),
  ('NewWhaleOrder', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Compty', 'DISTORTION', 'Disbanded/Merged', 'No CD', false),
  ('Mortuary', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Gwenchana', 'DISTORTION', 'Disbanded/Merged', 'No CD', false),
  ('Raging', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Homies', 'DISTORTION', 'Disbanded/Merged', 'No CD', false),
  ('Wild', 'ASCENSION', 'Disbanded/Merged', 'No CD', false),
  ('Night', 'DISTORTION', 'Disbanded/Merged', 'No CD', false),
  ('UWU', 'DISTORTION', 'Disbanded/Merged', 'No CD', false),
  ('sit dog', 'DISTORTION', 'Disbanded/Merged', 'No CD', false)
on conflict (name) do nothing;

-- A guild can only sit on a cluster that exists. Added after the seed for the
-- same reason as the alliance keys below.
alter table threat_guilds drop constraint if exists threat_guilds_cluster_fk;
alter table threat_guilds add constraint threat_guilds_cluster_fk
  foreign key (cluster) references threat_clusters (label) on update cascade;

-- ── THE CASCADE ─────────────────────────────────────────────────────────────
-- Both halves of a bond follow a rename, and both disappear if the guild is
-- deleted. Orphan rows are cleared first so the constraints can be added at
-- all: a bond naming a guild that is not on the board could never be drawn
-- anyway, and the API already discards it on read.
delete from threat_alliances a
 where not exists (select 1 from threat_guilds g where g.name = a.name)
    or not exists (select 1 from threat_guilds g where g.name = a.partner);

alter table threat_alliances drop constraint if exists threat_alliances_name_fk;
alter table threat_alliances add constraint threat_alliances_name_fk
  foreign key (name) references threat_guilds (name) on update cascade on delete cascade;

alter table threat_alliances drop constraint if exists threat_alliances_partner_fk;
alter table threat_alliances add constraint threat_alliances_partner_fk
  foreign key (partner) references threat_guilds (name) on update cascade on delete cascade;

commit;
