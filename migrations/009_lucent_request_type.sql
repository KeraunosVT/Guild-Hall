-- 009_lucent_request_type.sql — what kind of request this is.
--
-- Free text rather than a fixed list: the categories officers actually use
-- (enchanting, traits, a specific boss, an event) shift with the patch cycle,
-- and a constrained set would need a code change every time one appeared. The
-- form suggests values already in use so spelling stays consistent without
-- being enforced.
--
-- Nullable — every existing row predates the column, and not every request
-- needs a category.
--
-- Run this in the Supabase SQL editor.

alter table lucent_requests add column request_type text;
