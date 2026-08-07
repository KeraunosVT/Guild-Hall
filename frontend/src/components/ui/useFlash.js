import { useState, useCallback, useRef, useEffect } from 'react';

// The `msg`/`flash`/setTimeout-auto-clear trio duplicated verbatim across
// Classes, GearLevel, Names, Parties, Attendance, LOA, and LootTally.
export function useFlash(duration = 4000) {
  const [msg, setMsg] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const flash = useCallback((text, ok = true) => {
    setMsg({ text, ok });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setMsg(null), duration);
  }, [duration]);

  return [msg, flash];
}
