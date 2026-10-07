export function EyeIcon({ hidden = false }) {
  return hidden ? (
    <svg viewBox="0 0 28 28" aria-hidden="true">
      <path d="M4.1 4.1 23.9 23.9" />
      <path d="M11.7 6.9A12.3 12.3 0 0 1 14 6.7c6.1 0 10.3 5.3 11.4 7.3-.5.9-1.5 2.3-3.1 3.9M7.4 9.3C4.8 11.1 3 13.6 2.6 14c1.1 2 5.3 7.3 11.4 7.3 1.6 0 3-.4 4.3-1" />
      <path d="M12.5 12.5a2.2 2.2 0 0 0 3 3" />
    </svg>
  ) : (
    <svg viewBox="0 0 28 28" aria-hidden="true">
      <path d="M2.6 14c1.1-2 5.3-7.3 11.4-7.3S24.3 12 25.4 14c-1.1 2-5.3 7.3-11.4 7.3S3.7 16 2.6 14Z" />
      <circle cx="14" cy="14" r="3.1" />
    </svg>
  );
}
