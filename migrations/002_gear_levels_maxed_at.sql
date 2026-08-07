-- 002_gear_levels_maxed_at.sql — tracks when a member FIRST reached
-- 80/80/80 (weapon/armor/accessory maxed), so members at the cap can be
-- ranked by achievement order instead of being re-sorted arbitrarily every
-- time they're tied at the max value.
--
-- Run this in the Supabase SQL editor.

alter table gear_levels add column maxed_at timestamptz;
