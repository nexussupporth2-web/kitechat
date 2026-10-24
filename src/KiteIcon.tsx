/** A small kite, used as the "send" icon. Draws with the current text colour. */
export default function KiteIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2 19 9 12 17 5 9Z" />
      <path d="M12 2v15M5 9h14" />
      <path d="M12 17c-2 1.2 1.6 2.4-.2 4.2" />
    </svg>
  );
}
