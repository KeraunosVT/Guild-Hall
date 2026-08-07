// Both modals on the site (Shards' weapon wishlist, LootTally's award
// confirm) share this exact backdrop/panel shell and mount/unmount rather
// than toggle visibility — only the content and max-width differ.
export default function Modal({ onClose, maxWidth = 'max-w-md', scrollable = false, children }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-ink/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`panel rounded-lg p-6 w-full ${maxWidth} ${scrollable ? 'max-h-[85vh] overflow-auto' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
