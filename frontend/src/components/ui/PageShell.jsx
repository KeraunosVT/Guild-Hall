// The max-w-Nxl mx-auto px-6 py-12 wrapper repeated at the top of nearly
// every page. Width genuinely varies by page density (2xl forms up to
// [1600px] for the Parties board), so it's a prop, not a fixed value.
export function PageShell({ maxWidth = 'max-w-6xl', paddingX = 'px-6', className = '', children }) {
  return <div className={`${maxWidth} mx-auto ${paddingX} py-12 ${className}`}>{children}</div>;
}
