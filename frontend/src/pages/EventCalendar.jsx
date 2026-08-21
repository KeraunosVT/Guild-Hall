import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  CalendarRange, Check, Clock, Users, ChevronLeft, ChevronRight,
  CalendarOff, AlertTriangle, Moon, Loader2, ClipboardCheck,
} from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import Button from '../components/ui/Button';
import Toast from '../components/ui/Toast';
import EmptyState from '../components/ui/EmptyState';
import { useFlash } from '../components/ui/useFlash';
import {
  todayInGuildTz, eventsForGuildDay, daySlot, isAfterMidnight,
  fmtTimeEst, guildTimezone, getDisplayTimezone,
} from '../timeUtils';

// ── WHAT THIS PAGE IS ───────────────────────────────────────────────────────
// The week ahead, as an agenda: every night in order, every event under it, and
// the one button a member wants next to each — "I'm in".
//
// It is a VIEW, not a new feature. Marking attendance here writes through the
// same POST /api/signups/:id/join the Signups page and the Discord buttons use,
// so a member who clicks here shows up in the party builder, the reminder sweep
// and the Discord embed identically. Nothing on this page has its own storage.
//
// ── THE VOCABULARY, WHICH IS NOT SYMMETRIC ──────────────────────────────────
// Signups can only say "I'm coming". There is no "not coming" row — the
// database refuses one (see migrations/saas_002_event_signups.sql), because
// declaring an absence is the LOA system's job and two records that can
// disagree about the same member on the same night is worse than one record
// with a gap in it.
//
// So this page says yes and shows no. "Can't make it" links to /loa rather than
// growing a second, quieter way to file an absence — one that skipped the
// reason LOA requires, and that officers reading the LOA board would never see.
//
// ── A NIGHT NOBODY HAS OPENED YET IS STILL A NIGHT ──────────────────────────
// Most of the week is recurring events with no occurrence row behind them —
// nobody has "opened signups" for Saturday's field boss three weeks out. Those
// rows are answerable anyway: "I'm in" posts to /api/signups/for-event, which
// brings the occurrence into existence and joins the caller in one step. The
// schedule already says the night is happening, so signing up for it needs no
// second act of permission.
//
// It opens QUIETLY — no Discord post, no ping. The reasoning is in
// backend/eventSignups.js under openForSchedule; the short version is that one
// member tapping a row must not make forty phones buzz.
//
// ── WHY IT IS ASSEMBLED IN THE BROWSER ──────────────────────────────────────
// Three reads it already had: the open occurrences (/api/signups, which carries
// `mine` and the counts), the recurring schedule (/api/event-schedule), and the
// viewer's own LOA entries (/api/loa). No new endpoint, and — more to the point
// — no new place for one member's data to reach another's screen: every field
// here was already cleared for this viewer by the route that sent it.
//
// The guild-night rules the projection needs (daySlot, eventsForGuildDay,
// todayInGuildTz) are the frontend mirrors in timeUtils.js, which is what the
// LOA and Signups pages already project with.

const DAYS_AHEAD = 7;
const MINUTES_PER_DAY = 1440;

// How many weeks forward the arrows will go. Bounded by the server's own
// ceiling — openForSchedule refuses to bring a night into existence more than
// MEMBER_OPEN_HORIZON_DAYS (30) ahead — so the page can never show a week whose
// buttons the API would reject. Four pages of seven days ends on day 27.
const MAX_WEEKS = 3;

// Calendar arithmetic on YYYY-MM-DD in UTC, so a browser in any timezone lands
// on the same day and a DST boundary can't skip or repeat one.
const addDays = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const dowOf = (date) => new Date(`${date}T12:00:00`).getDay();

// An occurrence's wall-clock time in the GUILD's timezone, which is the only
// frame the schedule and the LOA windows are expressed in. Used for sorting and
// for LOA matching — never for display, where the member's own timezone wins.
function guildClock(when) {
  return new Date(when).toLocaleTimeString('en-GB', {
    timeZone: guildTimezone(), hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// "Now", as a slot within the guild night. Only meaningful against rows on
// tonight's date — every later night is ahead of it by construction — and it is
// what lets a scheduled event that has no instant of its own still know it has
// already begun. Compared as a slot rather than as clock text so the 12:30am
// event counts as later than the 9pm one rather than earlier.
const guildNowSlot = () => daySlot(guildClock(Date.now()));

// An opened occurrence has a real instant, so it can be shown in whatever
// timezone the member picked in Settings, zone label and all. A schedule entry
// that nobody has opened yet has only a recurring wall-clock time with no date
// attached, which is exactly the case fmtTimeEst exists for and deliberately
// does not convert. The two therefore read slightly differently, and that
// difference is honest: one is a scheduled moment, the other is a habit.
function timeLabel(row) {
  if (row.starts_at) {
    return new Date(row.starts_at).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: getDisplayTimezone(), timeZoneName: 'short',
    });
  }
  return row.time ? fmtTimeEst(row.time) : 'No time set';
}

// Mirror of withinLoaWindow in backend/loa.js — keep the two in step. No
// start_time means the absence isn't time-scoped at all; a start with no end is
// an open-ended cutoff; both is a window they're back after. Compared in
// guild-night slots so "out from 9pm" still covers the 12:30am event.
function loaWindowCovers(entry, eventTime) {
  if (!entry.start_time || !eventTime) return true;
  const at = daySlot(eventTime);
  const from = daySlot(entry.start_time);
  if (at < from) return false;
  if (!entry.end_time) return true;
  let to = daySlot(entry.end_time);
  if (to <= from) to += MINUTES_PER_DAY;
  return at < to;
}

// Which of the viewer's own LOA entries covers this occurrence, if any. The
// three projections are the same ones loa.unavailableOn applies server-side: a
// one-off on its date, a range across every day it spans, a recurring entry on
// each matching day-of-week. An entry scoped to a different event doesn't count.
function loaCovering(entries, { date, time, eventScheduleId }) {
  const dow = dowOf(date);
  const scoped = (e) => !e.event_schedule_id || !eventScheduleId || e.event_schedule_id === eventScheduleId;
  return entries.find((e) => {
    if (e.type === 'range') return e.start_date <= date && e.end_date >= date;
    if (e.type === 'event') return e.event_date === date && scoped(e) && loaWindowCovers(e, time);
    if (e.type === 'recurring') return e.day_of_week === dow && scoped(e) && loaWindowCovers(e, time);
    return false;
  }) || null;
}

const shortDate = (date) => new Date(`${date}T12:00:00`)
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// "Today", "Tomorrow", then the weekday. The two relative labels earn their
// place: they are the only rows most people are deciding about right now.
function dayHeading(date, today) {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
}

function Chip({ children, tone = 'text-ash border-line', title, as: Comp = 'span', ...rest }) {
  return (
    <Comp title={title} {...rest}
      className={`inline-flex items-center gap-1.5 text-xs border rounded-full px-2.5 py-1 ${tone}`}>
      {children}
    </Comp>
  );
}

export default function EventCalendar() {
  const [signups, setSignups] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [myLoa, setMyLoa] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [weeks, setWeeks] = useState(0); // whole weeks forward from today
  const [busy, setBusy] = useState('');
  const [msg, flash] = useFlash();

  const load = useCallback(() => {
    Promise.all([
      axios.get('/api/signups'),
      axios.get('/api/event-schedule'),
      axios.get('/api/loa'),
    ])
      .then(([s, sch, l]) => {
        setSignups(s.data.signups || []);
        setSchedule(sch.data.schedule || []);
        setMyLoa(l.data.entries || []);
        setError('');
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the calendar.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // The guild's today, not the browser's, and already shifted past the
  // guild-night rollover — at 12:30am the night in progress is still last night.
  const today = useMemo(() => todayInGuildTz(), []);

  const dates = useMemo(() => {
    const start = addDays(today, weeks * DAYS_AHEAD);
    return Array.from({ length: DAYS_AHEAD }, (_, i) => addDays(start, i));
  }, [today, weeks]);

  // Every mutation re-loads rather than patching state in place: the server is
  // the authority on waitlist order, and a withdrawal can promote somebody else.
  const act = async (key, fn, okText) => {
    setBusy(key);
    try {
      const res = await fn();
      flash(typeof okText === 'function' ? okText(res?.data) : okText);
      load();
    } catch (err) {
      flash(err.response?.data?.error || "That didn't work.", false);
      // Full, closed, or already handled elsewhere — whatever is on screen is
      // out of date either way.
      load();
    } finally {
      setBusy('');
    }
  };

  // Two ways in, one button. An occurrence that already exists is a plain join;
  // one that doesn't is opened and joined in a single request, because a client
  // that opened first and joined second would leave an empty night behind every
  // time the second call failed.
  const join = (row) => act(row.key,
    () => (row.signup
      ? axios.post(`/api/signups/${row.signup.id}/join`)
      : axios.post('/api/signups/for-event', { event_schedule_id: row.event_schedule_id, event_date: row.date })),
    (d) => {
      if (d?.status === 'waitlist') return `You're on the waitlist — #${d.position}.`;
      // Worth saying out loud: they didn't just answer for themselves, they
      // opened the night for everyone else too.
      return d?.opened ? "You're in — signups are now open for that night." : "You're in.";
    });

  const withdraw = (row) => act(row.key, () => axios.delete(`/api/signups/${row.signup.id}/join`),
    "Withdrawn — you're back to undecided.");

  const days = useMemo(() => {
    const nowSlot = guildNowSlot();
    const openByDate = {};
    signups.forEach((s) => {
      if (!s.event_date) return;
      (openByDate[s.event_date] = openByDate[s.event_date] || []).push(s);
    });

    return dates.map((date) => {
      const opened = openByDate[date] || [];
      // A recurrence whose signups are already open must not also appear as an
      // unopened schedule entry — that would show the same night's raid twice,
      // once with a button and once without.
      const openedScheduleIds = new Set(opened.map((s) => s.event_schedule_id).filter(Boolean));

      const rows = opened.map((s) => {
        const time = guildClock(s.starts_at);
        return {
          key: `signup:${s.id}`,
          signup: s,
          event_schedule_id: s.event_schedule_id || null,
          date,
          title: s.title,
          time,
          slot: daySlot(time),
          starts_at: s.starts_at,
          started: new Date(s.starts_at).getTime() <= Date.now(),
          closed: s.status !== 'open',
          loa: loaCovering(myLoa, { date, time, eventScheduleId: s.event_schedule_id || null }),
        };
      });

      eventsForGuildDay(schedule, dowOf(date))
        .filter((e) => !openedScheduleIds.has(e.id))
        .forEach((e) => {
          rows.push({
            key: `sched:${e.id}:${date}`,
            signup: null,
            // What POST /api/signups/for-event needs to open this night.
            event_schedule_id: e.id,
            date,
            title: e.name,
            time: e.event_time,
            // An event with no time on the schedule sorts to the top of the
            // night rather than being dropped — it is still on that night.
            slot: e.event_time ? daySlot(e.event_time) : -1,
            starts_at: null,
            // No instant to compare against, so tonight's rows are judged on
            // the guild clock instead. Later nights can't have started.
            started: date === today && Boolean(e.event_time) && daySlot(e.event_time) < nowSlot,
            closed: false,
            loa: loaCovering(myLoa, { date, time: e.event_time, eventScheduleId: e.id }),
          });
        });

      rows.sort((a, b) => a.slot - b.slot || String(a.title).localeCompare(String(b.title)));
      return { date, rows };
    });
  }, [dates, signups, schedule, myLoa, today]);

  const totals = useMemo(() => {
    const rows = days.flatMap((d) => d.rows);
    return {
      events: rows.length,
      in: rows.filter((r) => r.signup?.mine).length,
      away: rows.filter((r) => r.loa).length,
    };
  }, [days]);

  return (
    <PageShell maxWidth="max-w-4xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="font-display text-3xl text-bone tracking-[0.08em] flex items-center gap-3">
            <CalendarRange className="w-6 h-6 text-brass shrink-0" />
            Event Calendar
          </h1>
          <p className="text-sm text-ash mt-2 max-w-xl">
            The week ahead, night by night. Say you're coming straight from here —
            it's the same signup the Discord post and the party builder read.
          </p>
        </div>

        {/* Forward-only, and the disabled Prev says why rather than showing an
            empty past week: signups are only carried for 12 hours after they
            finish, so a backward step would render as "nothing happened". */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setWeeks((w) => Math.max(0, w - 1))}
            disabled={weeks === 0}
            title={weeks === 0 ? 'This page looks forward — past nights are on My Attendance' : 'Previous week'}
            className="p-2 rounded-lg border border-line text-ash hover:text-bone disabled:opacity-30 disabled:hover:text-ash transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="text-center min-w-[9.5rem]">
            <div className="text-sm text-bone">{shortDate(dates[0])} – {shortDate(dates[dates.length - 1])}</div>
            <div className="eyebrow text-[10px] text-ash/70 mt-0.5">
              {weeks === 0 ? 'Next 7 days' : `${weeks} week${weeks === 1 ? '' : 's'} ahead`}
            </div>
          </div>
          <button
            onClick={() => setWeeks((w) => Math.min(MAX_WEEKS, w + 1))}
            disabled={weeks >= MAX_WEEKS}
            title={weeks >= MAX_WEEKS ? 'Signups only open about a month ahead' : 'Next week'}
            className="p-2 rounded-lg border border-line text-ash hover:text-bone disabled:opacity-30 disabled:hover:text-ash transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="rule-fade my-6" />

      <Toast msg={msg} />
      {error && (
        <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>
      )}

      {!loading && totals.events > 0 && (
        <div className="flex items-center gap-4 text-xs text-ash mb-6 flex-wrap">
          <span>{totals.events} event{totals.events === 1 ? '' : 's'} this week</span>
          {/* Both counts vanish at zero rather than reading "You're in for 0",
              which is a sentence about nothing. */}
          {totals.in > 0 && <span className="text-emerald-400">You're in for {totals.in}</span>}
          {totals.away > 0 && <span className="text-brass">Away for {totals.away}</span>}
          <span className="flex-1" />
          {/* Both directions out of this page, stated once rather than on every
              row: what already happened, and how to say you can't make it. */}
          <Link to="/attendance" className="inline-flex items-center gap-1.5 text-ash hover:text-brass transition-colors">
            <ClipboardCheck className="w-3.5 h-3.5" /> My attendance
          </Link>
          <Link to="/loa" className="inline-flex items-center gap-1.5 text-ash hover:text-brass transition-colors">
            <CalendarOff className="w-3.5 h-3.5" /> Can't make one?
          </Link>
        </div>
      )}

      {loading ? (
        <EmptyState>Reading the calendar…</EmptyState>
      ) : totals.events === 0 ? (
        <EmptyState>
          Nothing is scheduled between {shortDate(dates[0])} and {shortDate(dates[dates.length - 1])}.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <section key={day.date}>
              <div className="flex items-baseline gap-3 mb-2 px-1">
                <h2 className={`font-display tracking-[0.08em] ${day.date === today ? 'text-brassbright' : 'text-bone'}`}>
                  {dayHeading(day.date, today)}
                </h2>
                <span className="text-xs text-ash">{shortDate(day.date)}</span>
              </div>

              {day.rows.length === 0 ? (
                <div className="panel rounded-lg px-5 py-3 text-sm text-ash/40">Nothing on the schedule.</div>
              ) : (
                <div className="panel rounded-lg divide-y divide-line">
                  {day.rows.map((row) => (
                    <EventRow
                      key={row.key} row={row} busy={busy === row.key}
                      onJoin={() => join(row)} onWithdraw={() => withdraw(row)}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}

function EventRow({ row, busy, onJoin, onWithdraw }) {
  const s = row.signup;
  const mine = s?.mine || null;
  const full = s && s.capacity !== null && s.counts.going >= s.capacity;
  // A row with no occurrence behind it is still answerable — signing up opens
  // the night. The two things that genuinely close the door are an officer
  // closing signups and the event having already begun; the third, a schedule
  // entry with no start time on it, can't be turned into an occurrence at all
  // because there is no instant to open it for.
  const canAct = !row.started && (s ? !row.closed : Boolean(row.event_schedule_id && row.time));

  return (
    <div className="px-5 py-3.5 flex items-center gap-4 flex-wrap">
      <div className="w-32 shrink-0">
        <div className="text-sm text-bone inline-flex items-center gap-1.5">
          <Clock className="w-3 h-3 text-ash shrink-0" />
          {timeLabel(row)}
        </div>
        {isAfterMidnight(row.time) && (
          <div className="text-[10px] text-ash/60 mt-0.5 inline-flex items-center gap-1" title="Runs after midnight — still this night">
            <Moon className="w-2.5 h-2.5" /> after midnight
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-bone truncate">{row.title}</div>
        <div className="flex items-center gap-3 text-xs text-ash mt-1 flex-wrap">
          {s ? (
            <>
              <span className="inline-flex items-center gap-1">
                <Users className="w-3 h-3" /> {s.counts.going}{s.capacity ? `/${s.capacity}` : ''} in
              </span>
              {s.counts.waitlist > 0 && <span className="text-brass">{s.counts.waitlist} waitlisted</span>}
            </>
          ) : (
            // Not "signups not open" — that describes the plumbing, and the
            // member can open it by answering. What they actually want to know
            // is that nobody has said yes yet.
            <span className="text-ash/50">{canAct ? 'Nobody in yet' : 'Not open'}</span>
          )}
          {row.loa && (
            <Chip as={Link} to="/loa" tone="text-brass border-brass/40 hover:bg-panelup"
              title={row.loa.reason ? `Your LOA: ${row.loa.reason}` : 'You have an LOA covering this'}>
              <CalendarOff className="w-3 h-3" /> You're away
            </Chip>
          )}
          {/* Surfaced, never resolved — both records are real statements the
              member made, and which one is right is theirs to say. Officers see
              the same conflict on the Signups page. */}
          {row.loa && mine && (
            <span className="inline-flex items-center gap-1 text-oxblood" title="You're signed up and on LOA for the same night — cancel whichever is wrong">
              <AlertTriangle className="w-3 h-3" /> and signed up
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {mine && (
          <span className={`text-xs ${mine.status === 'waitlist' ? 'text-brass' : 'text-emerald-400'}`}>
            {mine.status === 'waitlist' ? `Waitlist #${mine.position}` : "You're in"}
          </span>
        )}

        {row.closed && !mine && <Chip>Closed</Chip>}
        {!row.closed && row.started && !mine && <Chip>Started</Chip>}

        {mine ? (
          <Button variant="neutral" size="none" disabled={busy}
            className="px-3 py-1.5 text-xs border border-line rounded-lg"
            onClick={onWithdraw}
            title="Back to undecided — this does not file an absence">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Withdraw'}
          </Button>
        ) : canAct ? (
          <Button size="none" className="px-4 py-1.5 text-sm" disabled={busy} onClick={onJoin}
            title={full
              ? "Full — you'll join the waitlist"
              : s ? undefined : "Nobody has opened this night yet — signing up opens it, without pinging Discord"}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {full ? 'Join waitlist' : "I'm in"}
          </Button>
        ) : (
          // Nothing to offer and nothing to explain — a schedule entry with no
          // start time. The dash keeps the column aligned rather than leaving a
          // hole that reads as a missing button.
          <span className="text-xs text-ash/40">—</span>
        )}
      </div>
    </div>
  );
}
