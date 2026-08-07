import { ArrowDown, ArrowUp } from 'lucide-react';

// The panel-wrapped, sortable table shape duplicated identically between
// Roster and GearLevels (single header row, sort-icon wiring, row hover).

export function Table({ maxHeight, minWidth, children }) {
  return (
    <div className={`panel rounded-lg overflow-auto ${maxHeight || ''}`}>
      <table className={`w-full text-sm ${minWidth || ''}`}>{children}</table>
    </div>
  );
}

export function Thead({ sticky, children }) {
  return (
    <thead className={`border-b border-line ${sticky ? 'sticky top-0 bg-panelup' : ''}`}>
      <tr className="eyebrow text-[10px] text-ash whitespace-nowrap">{children}</tr>
    </thead>
  );
}

export function SortableTh({ label, sortKey, activeKey, dir, onSort, align = 'left', dense = false, className = '' }) {
  const active = activeKey === sortKey;
  return (
    <th
      className={`${dense ? 'p-2.5' : 'p-4'} font-normal cursor-pointer hover:text-bone select-none ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (dir === 'desc' ? <ArrowDown className="w-3 h-3 text-brass" /> : <ArrowUp className="w-3 h-3 text-brass" />)}
      </span>
    </th>
  );
}

export function Tr({ children, className = '' }) {
  return <tr className={`border-b border-line/60 hover:bg-panelup transition-colors ${className}`}>{children}</tr>;
}
