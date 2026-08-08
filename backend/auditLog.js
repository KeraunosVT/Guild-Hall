// backend/auditLog.js — logs every successful write in the admin area, and
// serves the log to the (separately-mounted, isAdmin-only) viewer page.
const express = require('express');
const { tenantDb } = require('./tenantDb');

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
  function log(req, res, next) {
    if (req.method === 'GET') return next();

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      // The scoped client is built here rather than in the factory: this module
      // is instantiated once at boot, so it has no guild of its own — the guild
      // belongs to the request. tenantDb() throws when req.guildId is missing,
      // and that throw would land in a 'finish' listener where nothing can catch
      // it, so it goes inside the same try as the insert.
      try {
        tenantDb(supabase, req.guildId).from('audit_log').insert({
          discord_id: req.user?.id,
          display_name: req.user?.username || null,
          method: req.method,
          path: req.path,
          feature: featureFor(req.path),
          body: req.body || {},
          status_code: res.statusCode,
        }).then(({ error }) => {
          // Never let a failed insert become an unhandled rejection — this app
          // has no global unhandledRejection handler, so an uncaught one here
          // would crash the whole server. A missed audit entry is fine; a
          // crashed server over a logging failure is not.
          if (error) console.error('Audit log insert failed:', error.message);
        });
      } catch (err) {
        console.error('Audit log insert skipped:', err.message);
      }
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

    // Scoped read: an officer must never page through another guild's audit
    // trail. tenantDb applies .eq('guild_id', …) immediately after .select(),
    // so the filters and .range() below still chain exactly as before.
    let query = tenantDb(supabase, req.guildId)
      .from('audit_log').select('*', { count: 'exact' }).order('created_at', { ascending: false });
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
