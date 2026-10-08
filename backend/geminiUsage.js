'use strict';

// ── GEMINI USAGE LOG ─────────────────────────────────────────────────────────
// One log line per screenshot read, with the tokens Gemini says it billed:
//
//   Gemini usage: scoreboard model=gemini-3.5-flash-lite guild=<uuid> in=4120 out=1876 thinking=0 est=$0.0059
//
// It exists to replace guesses with numbers: what a screenshot really costs,
// whether the model is spending tokens "thinking" (billed at the output rate),
// and how much a busy guild actually uses — which is what the per-guild
// ceiling in geminiQuota.js should be set from.
//
// The dollar estimate appears only when GEMINI_PRICE_INPUT and
// GEMINI_PRICE_OUTPUT are set (USD per 1M tokens, from Google's pricing page),
// because prices change and a stale built-in table would quietly lie. Thinking
// tokens are billed at the output price.
//
// Read the logs on the droplet with:
//   journalctl -u guildhall --since "7 days ago" | grep "Gemini usage"

const PRICE_IN = parseFloat(process.env.GEMINI_PRICE_INPUT);
const PRICE_OUT = parseFloat(process.env.GEMINI_PRICE_OUTPUT);
const priced = Number.isFinite(PRICE_IN) && Number.isFinite(PRICE_OUT);

function logGeminiUsage(kind, model, response, { guildId } = {}) {
  try {
    const u = (response && response.usageMetadata) || {};
    const input = u.promptTokenCount || 0;
    const output = u.candidatesTokenCount || 0;
    const thinking = u.thoughtsTokenCount || 0;
    const est = priced ? ` est=$${((input * PRICE_IN + (output + thinking) * PRICE_OUT) / 1e6).toFixed(4)}` : '';
    console.log(`Gemini usage: ${kind} model=${model} guild=${guildId || '-'} in=${input} out=${output} thinking=${thinking}${est}`);
  } catch {
    // Logging must never break a read that succeeded.
  }
}

module.exports = { logGeminiUsage };
