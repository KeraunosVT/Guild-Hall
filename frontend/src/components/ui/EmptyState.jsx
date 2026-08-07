// Loading and empty-result messaging share the same look everywhere on the
// site — only the wording differs ("Reading the roll…" vs "No members on
// record yet."), so one component covers both.
export default function EmptyState({ children }) {
  return <div className="py-20 text-center text-ash">{children}</div>;
}
