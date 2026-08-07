-- 010_market_potentials.sql — auction-house potential prices scraped from
-- tl-tracker.
--
-- Written by the standalone scraper (scrappers/index.js), not by this app. That
-- scraper can't live in this process: tl-tracker's API is 403 without a session,
-- so it drives a logged-in Playwright browser — ~300 MB of binaries, a headed
-- first login, and a profile directory that this app's host wipes on every
-- deploy. It runs on an officer's machine and publishes here; the site only ever
-- reads. If the machine is off the data just ages, and fetched_at makes that
-- visible instead of silent.
--
-- One row per region holding the whole snapshot, deliberately shape-agnostic:
-- the meaning of tl-tracker's fields (label, kind, listed, floor, listings)
-- isn't pinned down yet, so a normalised table would be guessing at a primary
-- key. Normalising later is a migration, not a rewrite.
--
-- Run this in the Supabase SQL editor.

create table market_potentials (
  region text primary key,
  items jsonb not null,
  item_count int not null default 0,
  fetched_at timestamptz not null default now()
);
