-- 006_currency_award_reason.sql — why a Lucent/shard grant was given.
--
-- currency_awards previously recorded only recipient, type, and amount, so a
-- line in the ledger couldn't say whether it was a raid payout, a reimbursement,
-- or a correction. Nullable, since every existing row predates the column and
-- officers shouldn't be forced to justify small routine grants.
--
-- Run this in the Supabase SQL editor.

alter table currency_awards add column reason text;
