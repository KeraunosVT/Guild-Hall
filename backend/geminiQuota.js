'use strict';

// ── PER-GUILD GEMINI QUOTA ───────────────────────────────────────────────────
// Every screenshot we read costs real API money, and the bill is ours, not the
// guild's. The per-member gear limiter in server.js stops one member hammering
// the endpoint, but nothing stopped a whole guild — fifty members each at their
// hourly cap, or officers re-uploading a 20-file batch over and over — from
// running it up. This is that ceiling: a rolling 24-hour count of images sent
// to Gemini, per tenant, shared across every route that calls it.
//
// It counts IMAGES, not requests: /api/admin/match/parse takes up to twenty in
// one request, and each one is a separate model call. CSVs never reach Gemini
// and are never counted.
//
// In memory on purpose. One process serves every guild (DEPLOY_GUILDHALL.md),
// so one Map is the whole truth, and a restart forgetting the count only ever
// errs toward letting a guild work. If this ever runs as more than one process,
// the count has to move to the database.

const WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = parseInt(process.env.GEMINI_DAILY_LIMIT_PER_GUILD, 10) || 300;

function createGeminiQuota({ limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
  const used = new Map(); // guildId -> [timestamps of each image read]

  const live = (guildId) => {
    const cutoff = now() - WINDOW_MS;
    const stamps = (used.get(guildId) || []).filter((t) => t > cutoff);
    if (stamps.length) used.set(guildId, stamps); else used.delete(guildId);
    return stamps;
  };

  // Reserve `n` reads for a guild, all or nothing. A batch that won't fit is
  // refused whole rather than half-read, so an officer never gets a match with
  // some screenshots silently missing. Reads are charged up front and never
  // refunded: a call that errors at Gemini may still have been billed.
  function take(guildId, n = 1) {
    if (!guildId) return { ok: false, remaining: 0, retryAfterSec: 0 };
    if (n <= 0) return { ok: true, remaining: limit - live(guildId).length, retryAfterSec: 0 };

    const stamps = live(guildId);
    if (stamps.length + n > limit) {
      // When enough of the oldest reads age out to make room for this batch.
      const freeAt = stamps[stamps.length + n - limit - 1];
      const retryAfterSec = n > limit ? 0 : Math.max(1, Math.ceil((freeAt + WINDOW_MS - now()) / 1000));
      return { ok: false, remaining: limit - stamps.length, retryAfterSec };
    }
    const t = now();
    for (let i = 0; i < n; i++) stamps.push(t);
    used.set(guildId, stamps);
    return { ok: true, remaining: limit - stamps.length, retryAfterSec: 0 };
  }

  // The response every route sends when take() refuses. Not retryable: the
  // upload page offers Retry on anything that isn't marked otherwise, and
  // pressing it inside the window only burns another refusal.
  function refuse(res, result, n = 1) {
    const hours = Math.ceil(result.retryAfterSec / 3600);
    const error = n > limit
      ? `That's ${n} screenshots — more than this guild can read in a day (${limit}). Upload fewer at a time.`
      : `This guild has used its ${limit} screenshot reads for the last 24 hours`
        + (result.remaining > 0 ? ` (${result.remaining} left, this needs ${n})` : '')
        + `. Try again in about ${hours} hour${hours === 1 ? '' : 's'}.`;
    if (result.retryAfterSec) res.set('Retry-After', String(result.retryAfterSec));
    return res.status(429).json({ error, retryable: false });
  }

  return { take, refuse, limit };
}

module.exports = createGeminiQuota;
