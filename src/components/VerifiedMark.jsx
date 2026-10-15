export default function VerifiedMark({ className = '', reason = 'Verified by Nuper.', interactive = false }) {
  const mark = <svg className={`verified-mark${className ? ` ${className}` : ''}`} viewBox="0 0 20 20" role={interactive ? 'img' : 'img'} tabIndex={interactive ? 0 : undefined} aria-label={interactive ? 'Show verification reason on hover' : 'Verified account'}>
    <circle cx="10" cy="10" r="10" fill="currentColor"/>
    <path d="m5.5 10.2 2.8 2.8 6.2-6.2" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"/>
  </svg>;
  return interactive ? <span className="verified-mark-wrap">{mark}<span className="verified-mark-reason" role="status">{reason}</span></span> : mark;
}
