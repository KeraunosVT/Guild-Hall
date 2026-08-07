// Pairs with useFlash() — same banner className string duplicated across
// every page that has one of these inline flash messages.
export default function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div
      className={`mb-6 px-5 py-3 rounded-lg border text-sm ${
        msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'
      }`}
    >
      {msg.text}
    </div>
  );
}
