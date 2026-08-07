// backend/auditLog.js — logs every successful write in the admin area, and
// serves the log to the (separately-mounted, isAdmin-only) viewer page.
const express = require('express');

// Human-readable label for a request path, so the viewer doesn't just show
// raw route strings. Order doesn't matter — each check requires either an
// exact match or a '/'-bounded prefix, so e.g. "/events" can't accidentally
// swallow "/event-schedule".
const FEATURE_PREFIXES = [
  { prefix: '/match', label: 'Upload Match' },
  { prefix: '/maps', label: 'Upload Match' },
  { prefix: '/rosters', label: 'Parties' },
  { prefix: '/member-roles', label: 'Parties' },
  { prefix: '/loa/unavailable', label: 'Parties' },
  { prefix: '/unmapped-names', label: 'Names' },
  { prefix: '/identities', label: 'Names' },
  { prefix: '/loot', label: 'Loot Council' },
  { prefix: '/currency-awards', label: 'Loot Council' },
  { prefix: '/lucent-requests', label: 'Loot Council' },
  { prefix: '/voice-channels', label: 'Attendance' },
  { prefix: '/events', label: 'Attendance' },
  { prefix: '/attendance', label: 'Attendance' },
  { prefix: '/gear-ilvl', label: 'Gear Levels' },
  { prefix: '/event-schedule', label: 'LOA Schedule' },
  { prefix: '/members', label: 'Members' },
];

function featureFor(path) {
  const hit = FEATURE_PREFIXES.find((f) => path === f.prefix || path.startsWith(f.prefix + '/'));
  return hit ? hit.label : null;
}

module.exports = function createAuditLog(supabase) {
  // Mounted right after requireAdmin in the general /api/admin chain. Only
  // write methods are logged, and only once the response actually finishes
  // successfully — res.on('finish', ...) fires after the whole request
  // lifecycle completes (including multer's multipart parsing on upload
  // routes), so req.body is fully populated by then even for file uploads;
  // the file bytes themselves land in req.file/req.files, never req.body.
  // A /match/commit body carries every parsed player row — ~20 KB each, and a
  // 500-row sample of this table held 1.75 MB of them. The audit log exists to
  // answer "who changed what, when", and 120 stat rows don't help with that, so
  // long arrays collapse to a count and long strings are clipped.
  //
  // Shape is preserved otherwise: the viewer just JSON.stringify()s this, so a
  // string standing in for an array renders fine and still reads honestly.
  const MAX_ARRAY_ITEMS = 5;
  const MAX_STRING_CHARS = 500;
  const MAX_DEPTH = 6;

  function summarise(value, depth = 0) {
    if (depth > MAX_DEPTH) return '[nested]';
    if (Array.isArray(value)) {
      return value.length > MAX_ARRAY_ITEMS
        ? `[${value.length} rows]`
        : value.map((v) => summarise(v, depth + 1));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarise(v, depth + 1)]));
    }
    if (typeof value === 'string' && value.length > MAX_STRING_CHARS) {
      return `${value.slice(0, MAX_STRING_CHARS)}… (${value.length} chars)`;
    }
    return value;
  }

  function log(req, res, next) {
    if (req.method === 'GET') return next();

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      supabase.from('audit_log').insert({
        discord_id: req.user?.id,
        display_name: req.user?.username || null,
        method: req.method,
        path: req.path,
        feature: featureFor(req.path),
        body: summarise(req.body || {}),
        status_code: res.statusCode,
      }).then(({ error }) => {
        // Never let a failed insert become an unhandled rejection — this app
        // has no global unhandledRejection handler, so an uncaught one here
        // would crash the whole server. A missed audit entry is fine; a
        // crashed server over a logging failure is not.
        if (error) console.error('Audit log insert failed:', error.message);
      });
    });

    next();
  }

  const router = express.Router();

  // Paginated, filterable list for the viewer page.
  router.get('/', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase.from('audit_log').select('*', { count: 'exact' }).order('created_at', { ascending: false });
    if (req.query.discord_id) query = query.eq('discord_id', req.query.discord_id);
    if (req.query.feature) query = query.eq('feature', req.query.feature);
    if (req.query.from_date) query = query.gte('created_at', req.query.from_date);
    if (req.query.to_date) query = query.lte('created_at', `${req.query.to_date}T23:59:59`);
    query = query.range(from, to);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: 'Failed to load the audit log.' });
    res.json({ entries: data || [], total: count || 0, page, limit });
  });

  return { log, router };
};
