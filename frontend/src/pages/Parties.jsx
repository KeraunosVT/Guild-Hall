import { useState, useEffect, useMemo, useRef, forwardRef } from 'react';
import axios from 'axios';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, closestCorners,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy, rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAuth } from '../auth';
import RestrictedGate from '../components/ui/RestrictedGate';
import Button from '../components/ui/Button';
import { PageShell } from '../components/ui/PageShell';
import { todayInGuildTz, fmtTimeEst, eventsForGuildDay, isAfterMidnight } from '../timeUtils';
import { Save, Trash2, Send, Plus, Copy, RefreshCw, Users, CalendarOff, CalendarDays, CalendarCheck, X } from 'lucide-react';

const ROLES = ['Tank', 'DPS', 'Healer'];
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ROLE_STYLE = {
  Tank:   { dot: 'bg-sky-400',     ring: 'border-l-sky-400' },
  DPS:    { dot: 'bg-oxblood',     ring: 'border-l-oxblood' },
  Healer: { dot: 'bg-emerald-400', ring: 'border-l-emerald-400' },
};
const PARTY_SIZE = 6;
const PARTY_IDS = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);

// Members sit in a role-specific pool (or "unassigned" if no role is set yet).
const POOL_ROLE_KEY = { Tank: 'pool_tank', DPS: 'pool_dps', Healer: 'pool_healer' };
const POOL_KEYS = ['pool_unassigned', 'pool_tank', 'pool_dps', 'pool_healer'];
const poolForRole = (role) => POOL_ROLE_KEY[role] || 'pool_unassigned';
const POOL_META = [
  { key: 'pool_tank', label: 'Tank', dot: 'bg-sky-400' },
  { key: 'pool_dps', label: 'DPS', dot: 'bg-oxblood' },
  { key: 'pool_healer', label: 'Healer', dot: 'bg-emerald-400' },
  { key: 'pool_unassigned', label: 'Unassigned', dot: 'bg-ash' },
];

const initItems = () => ({
  ...Object.fromEntries(POOL_KEYS.map((k) => [k, []])),
  absent: [],
  ...Object.fromEntries(PARTY_IDS.map((id) => [id, []])),
});
// The last slot is the overflow/standby group rather than a numbered party, so
// it's named for what it's used for. Still renameable like any other.
const FILL_PARTY_ID = 'p12';
const initNames = () => Object.fromEntries(
  PARTY_IDS.map((id, i) => [id, id === FILL_PARTY_ID ? 'Fill' : `Party ${i + 1}`]),
);
const findContainer = (id, src) => (id in src ? id : Object.keys(src).find((k) => src[k].includes(id)));

const ROLE_COLOR = { Tank: '#38bdf8', DPS: '#b0423a', Healer: '#4ade80' };
const ROLE_SYMBOL = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };

// Whether an absence is definite enough to act on. A `partial` entry from
// /loa/unavailable is time-scoped and couldn't be checked against an event time
// (because no single event was picked), so it's a prompt to look at the window
// rather than grounds for benching — someone out after 8pm is fine for the 6pm.
// Those stay on the board flagged; only definite absences are moved.
const isFullyOut = (loa, id) => {
  const entry = loa.get(id);
  return Boolean(entry) && !entry.partial;
};

const LOA_TYPE_LABEL = { event: 'Out this event', range: 'Away (date range)', recurring: 'Out weekly' };

// Compact time for the inline card label, where a full "7:00 PM ET – 8:00 PM ET"
// is far too wide. The tooltip carries the fully qualified version.
const shortTime = (t) => fmtTimeEst(t).replace(' ET', '').replace(':00', '');

// Human summary of an absence for a card tooltip: the window if there is one,
// otherwise what kind of absence it is, plus the reason.
function loaSummary(loa) {
  if (!loa) return null;
  const when = loa.start_time
    ? (loa.end_time
      ? `Out ${fmtTimeEst(loa.start_time)} – ${fmtTimeEst(loa.end_time)}`
      : `Out from ${fmtTimeEst(loa.start_time)} on`)
    : LOA_TYPE_LABEL[loa.type] || 'On leave of absence';
  return loa.reason ? `${when} — ${loa.reason}` : when;
}

// Greedy wrap of a comma-separated name list to a pixel width.
function wrapNames(names, ctx, maxW) {
  const lines = [];
  let line = '';
  names.forEach((name, i) => {
    const piece = name + (i < names.length - 1 ? ',' : '');
    const candidate = line ? `${line} ${piece}` : piece;
    if (line && ctx.measureText(candidate).width > maxW) { lines.push(line); line = piece; }
    else line = candidate;
  });
  if (line) lines.push(line);
  return lines;
}

function renderRosterImage(partyIds, items, partyNames, roles, byId, classMode, classAssignments, absentWhy) {
  const parties = partyIds.filter((pid) => items[pid].length > 0);
  if (parties.length === 0) return null;

  const cols = Math.min(parties.length, 4);
  const rows = Math.ceil(parties.length / cols);
  const colW = 260;
  const rowH = 32;
  const headerH = 36;
  const padX = 20;
  const padY = 20;
  const gapX = 16;
  const gapY = 16;
  const titleH = 48;

  const maxMembers = Math.max(...parties.map((pid) => items[pid].length));
  const cardH = headerH + maxMembers * rowH + 12;
  const w = padX * 2 + cols * colW + (cols - 1) * gapX;

  // Members an LOA is holding out, posted so they can see they were accounted
  // for and so anyone who forgot to file notices they were expected. Members an
  // officer benched are deliberately left off: that's a roster decision, not an
  // availability fact, and publishing it reads as a callout.
  const onLeave = (items.absent || [])
    .filter((id) => (absentWhy || {})[id] === 'loa')
    .map((id) => byId[id]?.name || 'Unknown');
  // Wrapping needs text metrics before the real canvas can be sized, so measure
  // on a throwaway context using the same font the footer renders with.
  const leaveLineH = 16;
  let leaveLines = [];
  if (onLeave.length) {
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = '12px sans-serif';
    leaveLines = wrapNames(onLeave, measure, w - padX * 2 - 24);
  }
  const leaveH = leaveLines.length ? 34 + leaveLines.length * leaveLineH : 0;

  const h = padY + titleH + rows * cardH + (rows - 1) * gapY
    + (leaveH ? gapY + leaveH : 0) + padY;

  const canvas = document.createElement('canvas');
  canvas.width = w * 2;
  canvas.height = h * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  // Background
  ctx.fillStyle = '#121214';
  ctx.fillRect(0, 0, w, h);

  // Title
  ctx.fillStyle = '#d64545';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ROSTER', w / 2, padY + 14);
  ctx.fillStyle = '#ececeb';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(partyNames[parties[0]]?.replace(/Party \d+/, '').trim() ? '' : 'Parties', w / 2, padY + 36);

  parties.forEach((pid, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = padX + col * (colW + gapX);
    const y = padY + titleH + row * (cardH + gapY);

    // Card background
    ctx.fillStyle = '#1b1b1e';
    ctx.strokeStyle = '#2c2c30';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, colW, cardH, 4);
    ctx.fill();
    ctx.stroke();

    // Party name header
    ctx.fillStyle = '#d64545';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(partyNames[pid] || `Party ${idx + 1}`, x + 10, y + 22);

    // Count
    ctx.fillStyle = '#8a8a8d';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${items[pid].length}/${PARTY_SIZE}`, x + colW - 10, y + 22);

    // Members
    items[pid].forEach((memberId, mi) => {
      const member = byId[memberId] || { name: 'Unknown' };
      const role = roles[memberId] || '';
      const my = y + headerH + mi * rowH;

      const classes = ((classMode === 'pve' ? member.pve_classes : member.pvp_classes) || []).filter(Boolean);
      const cls = classAssignments?.[classMode]?.[memberId] || classes[0] || '';

      // Role color bar
      if (ROLE_COLOR[role]) {
        ctx.fillStyle = ROLE_COLOR[role];
        ctx.fillRect(x + 8, my + 2, 3, rowH - 6);
      }

      // Role symbol
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#8a8a8d';
      if (ROLE_SYMBOL[role]) {
        ctx.fillText(ROLE_SYMBOL[role], x + 16, my + 20);
      }

      // Class (right-aligned)
      const classW = 78;
      if (cls) {
        ctx.fillStyle = '#d64545';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(cls, x + colW - 10, my + 20, classW);
      }

      // Name
      ctx.fillStyle = '#ececeb';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'left';
      const nameX = x + (role ? 36 : 16);
      const maxW = colW - nameX + x - 10 - (cls ? classW + 6 : 0);
      ctx.fillText(member.name || 'Unknown', nameX, my + 20, maxW);
    });
  });

  if (leaveLines.length) {
    const fy = padY + titleH + rows * cardH + (rows - 1) * gapY + gapY;
    ctx.fillStyle = '#1b1b1e';
    ctx.strokeStyle = '#2c2c30';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(padX, fy, w - padX * 2, leaveH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#d64545';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`ON LEAVE (${onLeave.length})`, padX + 12, fy + 20);

    ctx.fillStyle = '#8a8a8d';
    ctx.font = '12px sans-serif';
    leaveLines.forEach((line, i) => ctx.fillText(line, padX + 12, fy + 40 + i * leaveLineH));
  }

  return canvas;
}

export default function Parties() {
  const { user, can } = useAuth();

  const [members, setMembers] = useState([]);
  const [extra, setExtra] = useState({});
  const [items, setItems] = useState(initItems);
  const [partyNames, setPartyNames] = useState(initNames);
  // Role (Tank/DPS/Healer) is tracked separately per PvP/PvE mode, same as
  // classAssignments — someone can be a Tank for one and a Healer for the other.
  const [rolesByMode, setRolesByMode] = useState({ pvp: {}, pve: {} });
  const [saved, setSaved] = useState([]);
  const [rosterId, setRosterId] = useState(null);
  const [rosterName, setRosterName] = useState('');
  const [filter, setFilter] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [membersError, setMembersError] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loaDate, setLoaDate] = useState(todayInGuildTz);
  const [loaEvent, setLoaEvent] = useState('');
  // discord_id → the absence that applies to the current occasion (type, time
  // window, reason, and whether it's `partial`). A Map rather than a set of ids
  // so cards can explain *how* someone is out, not just that they are.
  const [loaById, setLoaById] = useState(new Map());
  // What changed in the LOA picture between when a roster was saved and now.
  // Set by load(), cleared once the officer acts on it or moves the occasion.
  const [loaDiff, setLoaDiff] = useState(null);
  // discord_id → why they're in the Absent box: 'loa' if an absence put them
  // there, 'benched' if an officer did. Kept live (not derived at save time) so
  // a bench can be reconsidered when the occasion moves — a member parked for
  // Tuesday's LOA shouldn't stay parked once you switch to Saturday.
  const [absentWhy, setAbsentWhy] = useState({});
  const [schedule, setSchedule] = useState([]);
  const [classMode, setClassMode] = useState('pvp');
  const [classAssignments, setClassAssignments] = useState({ pvp: {}, pve: {} });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const loaRef = useRef(loaById);
  useEffect(() => { loaRef.current = loaById; }, [loaById]);

  const rolesByModeRef = useRef(rolesByMode);
  useEffect(() => { rolesByModeRef.current = rolesByMode; }, [rolesByMode]);

  // The role map for whichever mode is currently active — most of the
  // component just reads/writes this and doesn't need to know about modes.
  const roles = rolesByMode[classMode];

  const byId = useMemo(() => {
    const m = {};
    members.forEach((x) => { m[x.id] = x; });
    Object.values(extra).forEach((x) => { if (!m[x.id]) m[x.id] = x; });
    return m;
  }, [members, extra]);

  const poolViews = useMemo(() => {
    const f = filter.toLowerCase();
    const views = {};
    POOL_KEYS.forEach((k) => { views[k] = items[k].filter((id) => (byId[id]?.name || '').toLowerCase().includes(f)); });
    return views;
  }, [items, byId, filter]);

  const loadMembers = () => {
    setLoadingMembers(true); setMembersError('');
    axios.get('/api/admin/members')
      .then((res) => {
        const ms = res.data.members || [];
        setMembers(ms);
        const seededPvp = {}; const seededPve = {};
        ms.forEach((m) => {
          if (m.pvp_role) seededPvp[m.id] = m.pvp_role;
          if (m.pve_role) seededPve[m.id] = m.pve_role;
        });
        const merged = {
          pvp: { ...seededPvp, ...rolesByModeRef.current.pvp },
          pve: { ...seededPve, ...rolesByModeRef.current.pve },
        };
        setRolesByMode(merged);
        // Put any members not already placed into the pool matching their role
        // in the currently active mode, or the absent box if they're on LOA.
        setItems((prev) => {
          const placed = new Set([...PARTY_IDS, 'absent'].flatMap((k) => prev[k]));
          const unplaced = ms.map((m) => m.id).filter((id) => !placed.has(id));
          const loa = loaRef.current;
          const currentRoles = merged[classMode];
          const next = { ...prev };
          POOL_KEYS.forEach((k) => { next[k] = []; });
          unplaced.forEach((id) => {
            if (!isFullyOut(loa, id)) next[poolForRole(currentRoles[id])].push(id);
          });
          next.absent = [...prev.absent, ...unplaced.filter((id) => isFullyOut(loa, id))];
          return next;
        });
      })
      .catch((err) => setMembersError(err.response?.data?.error || 'Could not load members.'))
      .finally(() => setLoadingMembers(false));
  };
  const loadSaved = () => {
    axios.get('/api/admin/rosters').then((res) => setSaved(res.data.rosters || [])).catch(() => {});
  };

  const loadSchedule = () => {
    axios.get('/api/event-schedule')
      .then((res) => setSchedule(res.data.schedule || []))
      .catch(() => {});
  };

  // Resolves to who's out for a date/event instead of setting state itself —
  // load() needs the roster's own LOA picture in hand to diff it against what
  // was saved, before any of it reaches the board.
  const fetchLoa = (date, event) => {
    const params = `date=${date}${event ? `&event=${event}` : ''}`;
    return axios.get(`/api/admin/loa/unavailable?${params}`)
      .then((res) => new Map((res.data.unavailable || []).map((u) => [u.discord_id, u])))
      .catch(() => new Map());
  };

  const eventsForDate = useMemo(() => {
    if (!loaDate) return [];
    return eventsForGuildDay(schedule, new Date(loaDate + 'T12:00:00').getDay());
  }, [loaDate, schedule]);

  // Which date+event the LOA set in state was fetched for. Keeps load() — which
  // fetches its roster's occasion itself — from triggering a duplicate round
  // trip when it then sets loaDate/loaEvent.
  const loaFetchedFor = useRef(null);

  // LOA is fetched before members on purpose: loadMembers() routes anyone
  // already known to be out straight into the Absent box as it buckets the
  // pool, which is the only place absence is applied automatically.
  useEffect(() => {
    loadSaved(); loadSchedule();
    loaFetchedFor.current = `${loaDate}|${loaEvent}`;
    fetchLoa(loaDate, loaEvent).then((s) => { setLoaById(s); loaRef.current = s; loadMembers(); });
  }, []);

  useEffect(() => {
    const key = `${loaDate}|${loaEvent}`;
    if (loaFetchedFor.current === key) return;
    loaFetchedFor.current = key;
    fetchLoa(loaDate, loaEvent).then(setLoaById);
  }, [loaDate, loaEvent]);

  // Moving the occasion changes who's flagged, but never moves anyone: the
  // picker is a view onto a different night, and silently yanking people out of
  // parties an officer just built (with no way back) loses real work. Conflicts
  // surface in a prompt instead — see loaConflicts.
  const changeLoaDate = (date) => {
    // Events are tied to one weekday, so a previously picked one may not exist
    // on the new date. Both setters land in the same React batch, so the fetch
    // effect fires once with the new pair rather than once with a stale event
    // id and again with the cleared one.
    setLoaDate(date); setLoaEvent(''); setLoaDiff(null);
  };
  const changeLoaEvent = (event) => { setLoaEvent(event); setLoaDiff(null); };

  // Anyone on LOA for the current occasion who's still sitting on the board,
  // split by how definite the absence is (see isFullyOut). Only `full` is ever
  // bulk-moved; `partial` is surfaced so an officer can check the window and
  // decide, since it may not collide with this event at all.
  const loaConflicts = useMemo(() => {
    const onBoard = [...PARTY_IDS, ...POOL_KEYS].flatMap((k) => items[k].filter((id) => loaById.has(id)));
    const inParties = PARTY_IDS.flatMap((pid) => items[pid].filter((id) => loaById.has(id)));
    return {
      full: onBoard.filter((id) => isFullyOut(loaById, id)),
      partial: onBoard.filter((id) => !isFullyOut(loaById, id)),
      // Definite absences sitting in a party — the case that breaks a roster,
      // as opposed to one just cluttering the pool.
      fullInParties: inParties.filter((id) => isFullyOut(loaById, id)),
    };
  }, [items, loaById]);

  // Keep absentWhy in step with the Absent box. Anyone arriving without an
  // already-recorded reason is classified once, on arrival: a definite absence
  // covering them means the absence put them there, otherwise an officer
  // dragged them in. The reason then sticks — it records why they were benched,
  // which doesn't change retroactively when the occasion moves. Reading LOA off
  // the ref keeps this firing on Absent-box changes only.
  useEffect(() => {
    setAbsentWhy((prev) => {
      const next = {};
      let changed = items.absent.length !== Object.keys(prev).length;
      items.absent.forEach((id) => {
        next[id] = prev[id] || (isFullyOut(loaRef.current, id) ? 'loa' : 'benched');
        if (prev[id] !== next[id]) changed = true;
      });
      return changed ? next : prev;
    });
  }, [items.absent]);

  // Benched by an absence that no longer applies to the current occasion —
  // the mirror of loaConflicts, and what stops the Absent box accumulating
  // people as an officer moves between dates. Deliberate benches never appear
  // here; the officer meant those.
  const staleBenches = useMemo(
    () => items.absent.filter((id) => absentWhy[id] === 'loa' && !isFullyOut(loaById, id)),
    [items.absent, absentWhy, loaById],
  );

  // Re-bucket anyone sitting in an unassigned pool column (never an actual
  // party or the absent box — those are deliberate placements) to match their
  // role in whichever mode was just switched to.
  useEffect(() => {
    setItems((prev) => {
      const next = { ...prev };
      POOL_KEYS.forEach((k) => { next[k] = []; });
      POOL_KEYS.forEach((k) => {
        prev[k].forEach((id) => { next[poolForRole(roles[id])].push(id); });
      });
      return next;
    });
  }, [classMode]);

  if (!can('parties')) {
    return <RestrictedGate />;
  }

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  // Names for a list of ids, truncated — the conflict bar names who's affected
  // without growing unbounded when a whole night's worth of people are out.
  const namesFor = (ids, max = 3) => {
    const names = ids.slice(0, max).map((id) => byId[id]?.name || 'Unknown');
    return ids.length > max ? `${names.join(', ')} +${ids.length - max} more` : names.join(', ');
  };

  const onDragOver = ({ active, over }) => {
    if (!over) return;
    const activeId = active.id;
    const overId = over.id;
    setItems((prev) => {
      const ac = findContainer(activeId, prev);
      const oc = findContainer(overId, prev);
      if (!ac || !oc || ac === oc) return prev;
      if (!POOL_KEYS.includes(oc) && oc !== 'absent' && prev[oc].length >= PARTY_SIZE) return prev; // party full
      const activeItems = prev[ac];
      const overItems = prev[oc];
      const overIndex = overItems.indexOf(overId);
      let newIndex;
      if (overId in prev) {
        newIndex = overItems.length;
      } else {
        const below = active.rect.current.translated && over.rect &&
          active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
        newIndex = overIndex >= 0 ? overIndex + (below ? 1 : 0) : overItems.length;
      }
      return {
        ...prev,
        [ac]: activeItems.filter((id) => id !== activeId),
        [oc]: [...overItems.slice(0, newIndex), activeId, ...overItems.slice(newIndex)],
      };
    });
  };

  const onDragEnd = ({ active, over }) => {
    setActiveId(null);
    if (!over) return;
    const activeId = active.id;
    const overId = over.id;
    setItems((prev) => {
      const ac = findContainer(activeId, prev);
      const oc = findContainer(overId, prev);
      if (!ac || !oc || ac !== oc) return prev;
      const list = prev[ac];
      const oldIndex = list.indexOf(activeId);
      const newIndex = overId in prev ? list.length - 1 : list.indexOf(overId);
      if (newIndex < 0 || oldIndex === newIndex) return prev;
      return { ...prev, [ac]: arrayMove(list, oldIndex, newIndex) };
    });
  };

  const setRole = (id, role) => {
    const next = roles[id] === role ? '' : role;
    setRolesByMode((prev) => ({ ...prev, [classMode]: { ...prev[classMode], [id]: next } }));
    axios.put('/api/admin/member-roles', { id, mode: classMode, role: next }).catch(() => {});
    // If they're sitting in a pool (not a party or absent), move them to the pool matching their new role.
    setItems((prev) => {
      const container = findContainer(id, prev);
      if (!POOL_KEYS.includes(container)) return prev;
      const dest = poolForRole(next);
      if (dest === container) return prev;
      return {
        ...prev,
        [container]: prev[container].filter((x) => x !== id),
        [dest]: [...prev[dest], id],
      };
    });
  };

  const renameParty = (id, name) => setPartyNames((n) => ({ ...n, [id]: name }));

  const setMemberClass = (mode, id, cls) =>
    setClassAssignments((prev) => ({ ...prev, [mode]: { ...prev[mode], [id]: cls } }));

  const buildPayloadParties = () =>
    PARTY_IDS.map((pid) => ({
      id: pid,
      name: partyNames[pid],
      members: items[pid].map((id) => ({ id, name: byId[id]?.name || 'Unknown' })),
    }));

  // `why` separates an LOA-driven bench from a deliberate one, so loading this
  // roster later can tell "their LOA was cancelled, want them back?" from "the
  // officer sat them out on purpose" and only ask about the former.
  const buildPayloadAbsent = () =>
    items.absent.map((id) => ({
      id, name: byId[id]?.name || 'Unknown', why: absentWhy[id] || 'benched',
    }));

  const resetBoard = () => {
    const next = initItems();
    members.forEach((m) => {
      if (isFullyOut(loaById, m.id)) next.absent.push(m.id);
      else next[poolForRole(roles[m.id])].push(m.id);
    });
    setItems(next);
    setPartyNames(initNames()); setRosterId(null); setRosterName(''); setExtra({});
    setClassAssignments({ pvp: {}, pve: {} }); setLoaDiff(null); setAbsentWhy({});
  };

  // Move everyone definitely out off the board in one go — the explicit version
  // of what used to happen silently on every date change. Partial absences are
  // deliberately left alone; the officer resolves those per-person.
  const benchLoaConflicts = () => {
    const moving = loaConflicts.full;
    if (moving.length === 0) return;
    const movingSet = new Set(moving);
    setItems((prev) => {
      const next = { ...prev, absent: [...prev.absent, ...moving] };
      [...POOL_KEYS, ...PARTY_IDS].forEach((key) => { next[key] = prev[key].filter((id) => !movingSet.has(id)); });
      return next;
    });
    setLoaDiff(null);
    flash(`Moved ${moving.length} member${moving.length === 1 ? '' : 's'} to Absent.`);
  };

  // Click a party member to send them back to the pool for their role — the
  // reverse of dragging them in, without the drag. Fired only for pointer
  // travel under the sensor's own activation threshold (see MemberCardBase),
  // so it can never land at the end of a real drag.
  const returnToPool = (id) => {
    setItems((prev) => {
      const container = findContainer(id, prev);
      if (!PARTY_IDS.includes(container)) return prev;
      const dest = poolForRole(roles[id]);
      return {
        ...prev,
        [container]: prev[container].filter((x) => x !== id),
        [dest]: [...prev[dest], id],
      };
    });
  };

  // Put members whose LOA no longer applies back into the pool for their role,
  // out of the Absent box they were parked in when the roster was saved.
  const returnFromAbsent = (ids) => {
    const returning = new Set(ids.filter((id) => items.absent.includes(id)));
    if (returning.size === 0) return;
    setItems((prev) => {
      const next = { ...prev, absent: prev.absent.filter((id) => !returning.has(id)) };
      POOL_KEYS.forEach((k) => { next[k] = [...prev[k]]; });
      returning.forEach((id) => { next[poolForRole(roles[id])].push(id); });
      return next;
    });
  };

  // The board as a savable roster. Shared by save and duplicate, so a copy is
  // always of what's on screen — including edits not yet written back.
  const buildBody = (name) => ({
    name,
    layout: { parties: buildPayloadParties(), absent: buildPayloadAbsent(), classAssignments, rolesByMode },
    // The occasion the board is currently set to is the occasion the roster is
    // for — that's what makes re-checking LOA on load possible.
    event_date: loaDate || null,
    event_schedule_id: loaEvent || null,
  });

  const save = async () => {
    if (!rosterName.trim()) return flash('Name the roster first.', false);
    setBusy(true);
    const body = buildBody(rosterName);
    try {
      if (rosterId) await axios.put(`/api/admin/rosters/${rosterId}`, body);
      else { const res = await axios.post('/api/admin/rosters', body); setRosterId(res.data.id); }
      loadSaved(); flash('Roster saved.');
    } catch (err) { flash(err.response?.data?.error || 'Save failed.', false); }
    finally { setBusy(false); }
  };

  // "Siege" → "Siege (copy)" → "Siege (copy 2)" … an existing suffix is stripped
  // first so repeated duplication doesn't pile them up, and taken names are
  // skipped so the dropdown never shows two entries reading the same.
  const copyName = (name) => {
    const base = name.replace(/ \(copy(?: \d+)?\)$/, '').trim() || 'Roster';
    const taken = new Set(saved.map((r) => r.name));
    let candidate = `${base} (copy)`;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${base} (copy ${n})`;
    return candidate.slice(0, 120);
  };

  // Save the board as a new roster, leaving the loaded one untouched, and switch
  // to editing the copy. This is how a roster gets reused for another night:
  // duplicate it, move the date, and the LOA bars re-check the new occasion
  // against the copy — where load-change-date-Update overwrites last week's.
  const duplicate = async () => {
    if (!rosterId) return;
    setBusy(true);
    const name = copyName(rosterName);
    try {
      const res = await axios.post('/api/admin/rosters', buildBody(name));
      setRosterId(res.data.id); setRosterName(name);
      // The diff banner is about the roster that was loaded; the copy is
      // freshly saved, so there's nothing to have changed since.
      setLoaDiff(null);
      loadSaved(); flash(`Duplicated as "${name}".`);
    } catch (err) { flash(err.response?.data?.error || 'Duplicate failed.', false); }
    finally { setBusy(false); }
  };

  const load = async (id) => {
    if (!id) return;
    try {
      const res = await axios.get(`/api/admin/rosters/${id}`);
      const r = res.data.roster;
      // Re-check LOA against the occasion this roster was built for, not
      // whatever the picker happens to be showing. Rosters saved before the
      // occasion was recorded have none — leave the picker alone and skip the
      // diff, since there's no date to say "since you saved this" about.
      const date = r.event_date || null;
      const event = r.event_schedule_id || '';
      const loa = date ? await fetchLoa(date, event) : loaById;

      const nextItems = initItems();
      const nextNames = initNames();
      // Rosters saved before roles were split by mode only have a flat m.role —
      // fall back to applying it to both, same as it behaved before the split.
      const legacyRoles = {};
      const nextExtra = {};
      (r.layout?.parties || []).forEach((lp) => {
        if (!(lp.id in nextItems)) return;
        nextNames[lp.id] = lp.name || nextNames[lp.id];
        (lp.members || []).forEach((m) => {
          nextItems[lp.id].push(m.id);
          if (m.role) legacyRoles[m.id] = m.role;
          if (!members.find((x) => x.id === m.id)) nextExtra[m.id] = { id: m.id, name: m.name, missing: true };
        });
      });
      // Absent membership is whatever was saved with the roster, not the current LOA status.
      (r.layout?.absent || []).forEach((m) => {
        nextItems.absent.push(m.id);
        if (m.role) legacyRoles[m.id] = m.role;
        if (!members.find((x) => x.id === m.id)) nextExtra[m.id] = { id: m.id, name: m.name, missing: true };
      });
      const savedRolesByMode = r.layout?.rolesByMode || { pvp: legacyRoles, pve: legacyRoles };
      const mergedRolesByMode = {
        pvp: { ...rolesByMode.pvp, ...savedRolesByMode.pvp },
        pve: { ...rolesByMode.pve, ...savedRolesByMode.pve },
      };
      const assigned = new Set([...PARTY_IDS, 'absent'].flatMap((p) => nextItems[p]));
      const unassigned = members.map((m) => m.id).filter((mid) => !assigned.has(mid));
      unassigned.forEach((id) => {
        if (isFullyOut(loa, id)) nextItems.absent.push(id);
        else nextItems[poolForRole(mergedRolesByMode[classMode][id])].push(id);
      });

      // Assigned members who have filed since this was saved. Only this half of
      // the comparison lives here, because it names which party each one is in
      // — something nothing else can say. The reverse case (benched for an
      // absence that no longer applies) is covered live by staleBenches, which
      // reads the restored `why` markers below and stays correct as the
      // occasion moves, so repeating it here would say the same thing twice.
      // Names come from byId where possible — the layout's copy is whatever it
      // was when saved, which goes stale when someone changes their name.
      const nameNow = (m) => byId[m.id]?.name || m.name || 'Unknown';
      const nowOut = (r.layout?.parties || []).flatMap((lp) =>
        (lp.members || []).filter((m) => isFullyOut(loa, m.id))
          .map((m) => ({ id: m.id, name: nameNow(m), party: lp.name || lp.id })));
      const savedWhy = {};
      (r.layout?.absent || []).forEach((m) => { savedWhy[m.id] = m.why || 'benched'; });

      setItems(nextItems); setPartyNames(nextNames); setAbsentWhy(savedWhy);
      setRolesByMode(mergedRolesByMode); setExtra(nextExtra);
      setClassAssignments(r.layout?.classAssignments || { pvp: {}, pve: {} });
      setRosterId(r.id); setRosterName(r.name);
      if (date) {
        loaFetchedFor.current = `${date}|${event}`;
        setLoaDate(date); setLoaEvent(event); setLoaById(loa);
      }
      setLoaDiff(date && nowOut.length ? { nowOut } : null);
      flash(`Loaded "${r.name}".`);
    } catch (err) { flash(err.response?.data?.error || 'Load failed.', false); }
  };

  const del = async () => {
    if (!rosterId) return resetBoard();
    if (!window.confirm(`Delete roster "${rosterName}"?`)) return;
    try { await axios.delete(`/api/admin/rosters/${rosterId}`); loadSaved(); resetBoard(); flash('Roster deleted.'); }
    catch (err) { flash(err.response?.data?.error || 'Delete failed.', false); }
  };

  const post = async () => {
    // Last check before it's public: posting a roster that has people in it who
    // are known to be out is the failure this whole flow exists to prevent.
    if (loaConflicts.fullInParties.length > 0
      && !window.confirm(`${namesFor(loaConflicts.fullInParties)} ${loaConflicts.fullInParties.length === 1 ? 'is' : 'are'} on LOA but still in a party. Post anyway?`)) return;
    setBusy(true);
    try {
      const canvas = renderRosterImage(PARTY_IDS, items, partyNames, roles, byId, classMode, classAssignments, absentWhy);
      if (!canvas) { flash('No parties to post.', false); setBusy(false); return; }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const form = new FormData();
      form.append('image', blob, 'roster.png');
      form.append('name', rosterName || 'Roster');
      await axios.post('/api/admin/rosters/post', form);
      flash('Posted to Discord.');
    } catch (err) { flash(err.response?.data?.error || 'Post failed.', false); }
    finally { setBusy(false); }
  };

  const activeMember = activeId ? byId[activeId] : null;

  return (
    <PageShell maxWidth="max-w-none" paddingX="px-2">
      <div className="panel rounded-lg p-4 mb-6 flex flex-wrap items-center gap-3">
        <input value={rosterName} onChange={(e) => setRosterName(e.target.value)} placeholder="Roster name"
          className="bg-hall border border-line rounded px-3 py-2 text-bone focus:outline-none focus:border-brass w-52" />
        <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
          <Save className="w-4 h-4" /> {rosterId ? 'Update' : 'Save'}
        </button>
        <select value={rosterId || ''} onChange={(e) => load(e.target.value)}
          className="bg-hall border border-line rounded px-3 py-2 text-bone focus:outline-none focus:border-brass">
          <option value="">Load roster…</option>
          {saved.map((r) => <option key={r.id} value={r.id}>{r.name}{r.event_date ? ` — ${r.event_date}` : ''}</option>)}
        </select>
        <button onClick={resetBoard} className="inline-flex items-center gap-2 px-3 py-2 text-ash hover:text-bone transition-colors"><Plus className="w-4 h-4" /> New</button>
        <button onClick={duplicate} disabled={!rosterId || busy}
          title={rosterId ? 'Save this board as a new roster, leaving the original untouched' : 'Load a roster first'}
          className="inline-flex items-center gap-2 px-3 py-2 text-ash hover:text-bone transition-colors disabled:opacity-40 disabled:hover:text-ash">
          <Copy className="w-4 h-4" /> Duplicate
        </button>
        <Button variant="destructive" size="none" className="px-3 py-2" onClick={del}><Trash2 className="w-4 h-4" /> Delete</Button>
        <div className="flex items-center gap-2 text-sm text-ash">
          <CalendarDays className="w-4 h-4" />
          <span className="eyebrow text-[10px]">For</span>
          <input type="date" value={loaDate} onChange={(e) => changeLoaDate(e.target.value)}
            className="bg-hall border border-line rounded px-2 py-1.5 text-bone text-sm focus:outline-none focus:border-brass"
            title="The occasion this roster is for — LOAs are checked against it, and it's saved with the roster" />
          <select value={loaEvent} onChange={(e) => changeLoaEvent(e.target.value)}
            className="bg-hall border border-line rounded px-2 py-1.5 text-bone text-sm focus:outline-none focus:border-brass">
            <option value="">All events</option>
            {/* After-midnight events belong to this night but land on the next
                calendar day, so the day is shown to head off "why is the 12:30
                AM one under Saturday?". */}
            {eventsForDate.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.event_time ? ` — ${fmtTimeEst(s.event_time)}` : ''}
                {isAfterMidnight(s.event_time) ? ` ${DAY_ABBR[s.day_of_week]}` : ''}
              </option>
            ))}
          </select>
          {loaById.size > 0 && <span className="text-oxblood font-mono">{loaById.size} out</span>}
        </div>
        <button onClick={() => setClassMode((m) => m === 'pvp' ? 'pve' : 'pvp')}
          className="inline-flex items-center gap-0 rounded-full border border-line bg-hall p-0.5 cursor-pointer shrink-0" title="Toggle PvP / PvE classes and roles">
          <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${classMode === 'pvp' ? 'bg-oxblood text-bone' : 'text-ash'}`}>PVP</span>
          <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${classMode === 'pve' ? 'bg-emerald-500 text-ink' : 'text-ash'}`}>PVE</span>
        </button>
        <div className="flex-1" />
        <Button variant="secondary" size="none" className="px-5 py-2" disabled={busy} onClick={post}><Send className="w-4 h-4" /> Post to Discord</Button>
      </div>

      {msg && (
        <div className={`mb-6 px-5 py-3 rounded-lg border text-sm ${msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'}`}>{msg.text}</div>
      )}

      {/* Which parties lost someone since this roster was saved. Informational
          — every change is applied by the officer, never automatically. */}
      {loaDiff && (
        <div className="mb-3 px-5 py-3 rounded-lg border border-brass/40 bg-panel text-sm flex items-start justify-between gap-4">
          <div>
            <div className="eyebrow text-[10px] text-brass mb-1">LOA changed since this roster was saved</div>
            <div className="text-bone">
              <span className="text-oxblood font-semibold">Now on LOA:</span>{' '}
              {loaDiff.nowOut.map((m) => `${m.name} (${m.party})`).join(', ')}
            </div>
          </div>
          <button onClick={() => setLoaDiff(null)} className="p-1 text-ash hover:text-bone shrink-0" title="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Benched for an absence that no longer applies — the counterpart to the
          conflict bar below, and what keeps the Absent box from silting up as
          an officer moves between dates. */}
      {staleBenches.length > 0 && (
        <div className="mb-3 px-5 py-3 rounded-lg border border-emerald-500/40 bg-panel text-sm flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-bone">
            <CalendarCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              <span className="font-semibold">{namesFor(staleBenches)}</span>
              {staleBenches.length === 1 ? ' is' : ' are'} in Absent for an LOA that doesn&apos;t apply to this occasion.
            </span>
          </div>
          <Button variant="secondary" size="none" className="px-3 py-1.5 text-xs shrink-0" onClick={() => returnFromAbsent(staleBenches)}>
            Return {staleBenches.length} to pool
          </Button>
        </div>
      )}

      {/* Live conflict prompt: members definitely out, still on the board. */}
      {loaConflicts.full.length > 0 && (
        <div className="mb-3 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-sm flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-bone">
            <CalendarOff className="w-4 h-4 text-oxblood shrink-0" />
            {loaConflicts.fullInParties.length > 0 ? (
              <span>
                <span className="font-semibold">{namesFor(loaConflicts.fullInParties)}</span>
                {loaConflicts.fullInParties.length === 1 ? ' is' : ' are'} on LOA for this occasion but still in a party.
                {loaConflicts.full.length > loaConflicts.fullInParties.length
                  && ` ${loaConflicts.full.length - loaConflicts.fullInParties.length} more in the pool.`}
              </span>
            ) : (
              <span>
                {loaConflicts.full.length} member{loaConflicts.full.length === 1 ? '' : 's'} in the pool
                {loaConflicts.full.length === 1 ? ' is' : ' are'} on LOA for this occasion.
              </span>
            )}
          </div>
          <Button variant="secondary" size="none" className="px-3 py-1.5 text-xs shrink-0" onClick={benchLoaConflicts}>
            Move {loaConflicts.full.length} to Absent
          </Button>
        </div>
      )}

      {/* Time-scoped absences that may or may not collide with what's being
          built. No bulk action — picking a specific event above resolves them
          into a definite yes/no, and the card tooltips show each window. */}
      {loaConflicts.partial.length > 0 && (
        <div className="mb-6 px-5 py-2.5 rounded-lg border border-brass/30 bg-panel text-sm text-ash flex items-center gap-2">
          <CalendarOff className="w-4 h-4 text-brass shrink-0" />
          <span>
            <span className="text-bone font-semibold">{namesFor(loaConflicts.partial)}</span>
            {loaConflicts.partial.length === 1 ? ' has' : ' have'} an LOA for part of this day — hover for the window
            {!loaEvent && ', or pick an event above to check it exactly'}.
          </span>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCorners}
        onDragStart={({ active }) => setActiveId(active.id)} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
          {/* Role pools */}
          <div className="flex flex-col gap-3 lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto pr-0.5">
            <div className="panel rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow text-[10px] text-brass flex items-center gap-2"><Users className="w-3.5 h-3.5" /> Pool</div>
                <button onClick={loadMembers} className="text-ash hover:text-brass" title="Reload members"><RefreshCw className="w-3.5 h-3.5" /></button>
              </div>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search…"
                className="w-full bg-hall border border-line rounded px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass" />
            </div>

            {loadingMembers ? (
              <div className="panel rounded-lg p-6 text-ash text-sm text-center">Loading members…</div>
            ) : membersError ? (
              <div className="panel rounded-lg p-4 text-sm text-bone border border-oxblood/40 bg-oxblooddeep/20">
                {membersError}<button onClick={loadMembers} className="block mt-2 text-brass hover:text-brassbright">Retry</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {POOL_META.filter(({ key }) => activeId || items[key].length > 0).map(({ key, label, dot }) => (
                  <DroppableColumn key={key} id={key} itemIds={poolViews[key]} className="panel rounded-lg p-3">
                    <div className="eyebrow text-[10px] text-ash flex items-center gap-2 mb-2">
                      <span className={`w-2 h-2 rounded-full ${dot}`} /> {label} ({items[key].length})
                    </div>
                    <div className="space-y-1 max-h-[340px] overflow-auto pr-1 min-h-[50px]">
                      {poolViews[key].length === 0
                        ? <div className="text-ash/50 text-xs py-4 text-center">Empty</div>
                        : poolViews[key].map((id) => <SortableMember key={id} member={byId[id] || { id, name: 'Unknown' }} role={roles[id]} onRole={setRole} loa={loaById.get(id)} classMode={classMode} assignedClass={classAssignments[classMode][id]} onClassChange={(cls) => setMemberClass(classMode, id, cls)} />)}
                    </div>
                  </DroppableColumn>
                ))}
              </div>
            )}
          </div>

          {/* Parties + Absent */}
          <div className="flex flex-col gap-1.5">
            {[PARTY_IDS.slice(0, 6), PARTY_IDS.slice(6, 12)].map((row, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3 items-start">
                {row.map((pid) => (
                  <DroppableColumn key={pid} id={pid} itemIds={items[pid]} className={`rounded-lg border bg-panel p-2 ${items[pid].length >= PARTY_SIZE ? 'border-line' : 'border-line'}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <input value={partyNames[pid]} onChange={(e) => renameParty(pid, e.target.value)}
                        className="bg-transparent font-display text-bone text-sm tracking-[0.06em] focus:outline-none focus:text-brassbright w-24" />
                      <span className={`font-mono text-xs ${items[pid].length >= PARTY_SIZE ? 'text-oxblood' : 'text-ash'}`}>{items[pid].length}/{PARTY_SIZE}</span>
                    </div>
                    <div className="space-y-1">
                      {items[pid].length === 0
                        ? <div className="text-ash/50 text-xs text-center py-3 border border-dashed border-line rounded">Drop members here</div>
                        : items[pid].map((id) => <SortableMember key={id} member={byId[id] || { id, name: 'Unknown' }} role={roles[id]} onRole={setRole} inParty loa={loaById.get(id)} classMode={classMode} assignedClass={classAssignments[classMode][id]} onClassChange={(cls) => setMemberClass(classMode, id, cls)} onQuickMove={returnToPool} />)}
                    </div>
                  </DroppableColumn>
                ))}
              </div>
            ))}

            {/* Absent sits under the parties rather than in the left rail: it's
                full-width here, so members lay out in a wrapping grid instead of
                one tall column, and it stays out of the way until needed. */}
            <DroppableColumn id="absent" itemIds={items.absent} strategy={rectSortingStrategy}
              className="panel rounded-lg p-3 mt-1.5">
              <div className="eyebrow text-[10px] text-oxblood flex items-center gap-2 mb-2">
                <CalendarOff className="w-3.5 h-3.5" /> Absent ({items.absent.length})
              </div>
              {items.absent.length === 0 ? (
                <div className="text-ash/50 text-xs text-center py-4 border border-dashed border-line rounded">Drop absent members here</div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2 max-h-[320px] overflow-auto pr-1">
                  {items.absent.map((id) => <SortableMember key={id} member={byId[id] || { id, name: 'Unknown' }} role={roles[id]} onRole={setRole} loa={loaById.get(id)} classMode={classMode} assignedClass={classAssignments[classMode][id]} onClassChange={(cls) => setMemberClass(classMode, id, cls)} />)}
                </div>
              )}
            </DroppableColumn>
          </div>
        </div>

        <DragOverlay>{activeMember ? <MemberCardBase member={activeMember} role={roles[activeMember.id]} loa={loaById.get(activeMember.id)} overlay /> : null}</DragOverlay>
      </DndContext>
    </PageShell>
  );
}

// Droppable container that also provides a SortableContext for its items.
// Pools and parties are single columns; Absent lays out as a wrapping grid and
// passes rectSortingStrategy so drag previews shift correctly in two dimensions
// instead of assuming a vertical list.
function DroppableColumn({ id, itemIds, className, children, strategy = verticalListSortingStrategy }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <SortableContext id={id} items={itemIds} strategy={strategy}>
      <div ref={setNodeRef} className={`${className} transition-colors ${isOver ? 'border-brass/70 ring-1 ring-brass/40' : ''}`}>
        {children}
      </div>
    </SortableContext>
  );
}

function SortableMember(props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.member.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return <MemberCardBase ref={setNodeRef} style={style} handle={{ ...attributes, ...listeners }} isDragging={isDragging} {...props} />;
}

// Pointer travel below this counts as a click rather than a drag. It matches
// the PointerSensor's activationConstraint exactly: under it, the sensor never
// activated, so a click handler here cannot collide with a drag.
const CLICK_SLOP_PX = 5;

const MemberCardBase = forwardRef(function MemberCardBase({ member, role, onRole, inParty, overlay, style, handle, isDragging, loa, classMode, assignedClass, onClassChange, onQuickMove }, ref) {
  const rs = ROLE_STYLE[role];
  const classes = ((classMode === 'pve' ? member.pve_classes : member.pvp_classes) || []).filter(Boolean);
  const current = assignedClass || classes[0];
  // A definite absence is dimmed and reddened; a partial one stays at full
  // strength in brass, because the member may well still be usable — the
  // difference is the whole point of showing the window.
  const partial = Boolean(loa?.partial);
  const loaTitle = loaSummary(loa);
  const hint = onQuickMove ? 'Click to send back to the pool' : null;
  const title = [loaTitle, hint].filter(Boolean).join(' · ') || undefined;

  // Where the pointer went down, to measure travel on release. Nested controls
  // (role buttons, the class select) stop pointerdown from reaching here, so
  // this stays null for those and their release is ignored below.
  const downAt = useRef(null);
  const onPointerDown = (e) => {
    handle?.onPointerDown?.(e); // dnd-kit's own listener — compose, don't replace
    downAt.current = onQuickMove ? { x: e.clientX, y: e.clientY } : null;
  };
  const onPointerUp = (e) => {
    const from = downAt.current;
    downAt.current = null;
    if (!from) return;
    if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < CLICK_SLOP_PX) onQuickMove(member.id);
  };

  return (
    <div
      ref={ref} style={style} {...handle}
      onPointerDown={onPointerDown} onPointerUp={onPointerUp}
      title={title}
      className={`group relative flex items-center gap-1 bg-hall border border-line ${rs ? `border-l-2 ${rs.ring}` : ''} rounded px-1.5 py-1 cursor-grab active:cursor-grabbing select-none ${isDragging ? 'opacity-30' : ''} ${overlay ? 'shadow-xl ring-1 ring-brass/40' : ''} ${loa && !partial ? 'opacity-50' : ''} ${partial ? 'ring-1 ring-brass/40' : ''}`}
    >
      {member.avatar
        ? <img src={member.avatar} alt="" className="w-5 h-5 rounded-full border border-line shrink-0" />
        : <span className="w-5 h-5 rounded-full bg-panelup border border-line shrink-0 flex items-center justify-center text-[9px] text-brass">{(member.name || '?').slice(0, 1).toUpperCase()}</span>}
      <div className="min-w-0 flex-1">
        <span className={`text-sm leading-tight truncate block ${member.missing ? 'text-ash italic' : loa && !partial ? 'text-oxblood' : partial ? 'text-brass' : 'text-bone'}`}
          title={loaTitle || (member.missing ? 'No longer in the server' : member.name)}>{member.name}</span>
        {loa?.start_time && (
          <span className={`text-[10px] leading-tight truncate block ${partial ? 'text-brass' : 'text-oxblood'}`}>
            {loa.end_time ? `out ${shortTime(loa.start_time)}–${shortTime(loa.end_time)}` : `out from ${shortTime(loa.start_time)}`}
          </span>
        )}
        {classes.length === 1 && (
          <span className="text-[10px] leading-tight text-brass truncate block">{classes[0]}</span>
        )}
        {classes.length > 1 && onClassChange && (
          <select
            value={current} onChange={(e) => onClassChange(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
            className="text-[10px] bg-transparent text-brass border-none focus:outline-none cursor-pointer truncate w-full -ml-px"
          >
            {classes.map((c, i) => <option key={c} value={c} className="bg-panelup text-bone">{c}{i === 0 ? ' ★' : ''}</option>)}
          </select>
        )}
      </div>
      {loa && <CalendarOff className={`w-3.5 h-3.5 shrink-0 ${partial ? 'text-brass' : 'text-oxblood'}`} />}
      {onRole && (
        <div className="flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity" onPointerDown={(e) => e.stopPropagation()}>
          {ROLES.map((r) => (
            <button key={r} onClick={() => onRole(member.id, r)} title={r}
              className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center border transition-colors ${role === r ? `${ROLE_STYLE[r].dot} text-ink border-transparent` : 'border-line text-ash hover:text-bone'}`}>
              {r[0]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
