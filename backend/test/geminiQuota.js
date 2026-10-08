// ============================================================================
// The per-guild Gemini quota
// ============================================================================
// Every screenshot read is money out of our pocket, and the quota is the only
// thing between one guild and an unbounded bill. What's worth holding: guilds
// don't share a budget, a batch is all-or-nothing, the window really rolls,
// and the refusal is a 429 the upload page won't offer to retry.
//
// No database, no server: a fake clock drives the window.
//
// Run:  node test/geminiQuota.js       (from backend/)
const createGeminiQuota = require('../geminiQuota');

const HOUR = 3_600_000;
let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + label.padEnd(60) + detail);
  ok ? pass++ : fail++;
};

let clock = 0;
const q = createGeminiQuota({ limit: 10, now: () => clock });

console.log('\n1. guilds have separate budgets');
check('A can spend its whole budget', q.take('A', 10).ok);
check('A is then refused', !q.take('A', 1).ok);
check('B is untouched by A', q.take('B', 1).ok);

console.log('\n2. a batch is all or nothing');
const b = q.take('B', 10);
check('a batch that would overflow is refused', !b.ok, `${b.remaining} left`);
check('and charged nothing', q.take('B', 9).ok);
check('so exactly the remainder fit', !q.take('B', 1).ok);

console.log('\n3. the window rolls');
clock = 0;
const c = createGeminiQuota({ limit: 3, now: () => clock });
c.take('C', 1);           // t = 0h
clock = 6 * HOUR; c.take('C', 2); // t = 6h, now full
clock = 12 * HOUR;
const full = c.take('C', 1);
check('full guild is refused', !full.ok);
check('told when the oldest read frees up', full.retryAfterSec === 12 * 3600, `${full.retryAfterSec}s`);
clock = 24 * HOUR + 1;
check('the 0h read has aged out', c.take('C', 1).ok);
check('but the 6h reads have not', !c.take('C', 1).ok);
const two = c.take('C', 2);
check('a 2-image batch waits for both 6h reads', two.retryAfterSec === Math.ceil((30 * HOUR - clock) / 1000), `${two.retryAfterSec}s`);

console.log('\n4. edge cases');
check('no guild id is refused', !c.take(undefined, 1).ok);
check('a CSV-only batch (0 images) always passes', c.take('C', 0).ok);
const huge = c.take('D', 4);
check('a batch bigger than the whole limit is refused', !huge.ok);

console.log('\n5. the refusal');
let status, body, headers = {};
const res = {
  set: (k, v) => { headers[k] = v; return res; },
  status: (s) => { status = s; return res; },
  json: (j) => { body = j; return res; },
};
c.refuse(res, full, 1);
check('is a 429', status === 429);
check('is not retryable', body.retryable === false);
check('carries Retry-After', headers['Retry-After'] === String(full.retryAfterSec));
check('says how long to wait', /about 12 hours/.test(body.error), body.error);
c.refuse(res, huge, 4);
check('an oversized batch says to upload fewer', /Upload fewer/.test(body.error));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
