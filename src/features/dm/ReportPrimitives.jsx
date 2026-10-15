export function ReportIcon({ type = 'shield' }) {
  const paths = {
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="M12 8v5m0 3h.01" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
    flag: <><path d="M5 21V3m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0" /></>,
  };
  return <svg className="report-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[type] || paths.shield}</svg>;
}

export function ReportMessagePreview({ name, body, source }) {
  return <section className="report-message-preview" aria-label="Reported message">
    <div className="report-preview-heading"><span className="report-person-initial" aria-hidden="true">{name?.slice(0, 1).toUpperCase() || '?'}</span><strong>{name || 'Selected message'}</strong><span>{source === 'channel' ? 'Server message' : 'Private message'}</span></div>
    <blockquote>{body || 'Attachment-only message. Describe the attachment in Additional details.'}</blockquote>
  </section>;
}
