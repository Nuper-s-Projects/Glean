export default function CommentIcon({ name, size = 20 }) {
  const paths = {
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    send: <><path d="m4 4 17 8-17 8 4-8Z"/><path d="M8 12h13"/></>,
    down: <path d="m6 9 6 6 6-6"/>,
    comment: <path d="M21 11.5a8 8 0 0 1-8 8 9 9 0 0 1-4-.9L3 21l1.5-5A8.5 8.5 0 1 1 21 11.5Z"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
