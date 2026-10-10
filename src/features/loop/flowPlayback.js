export function playbackTime(seconds) {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

export function mergeFlowPosts(current, incoming) {
  const seen = new Set(current.map(post => post.id));
  return [...current, ...incoming.filter(post => {
    if (seen.has(post.id)) return false;
    seen.add(post.id);
    return true;
  })];
}

export function appendFlowPage(current, incoming, round, active, maximum = 60) {
  const seen = new Set(current.map(post => post.flowKey));
  const entries = incoming.map(post => ({ ...post, flowKey:`${round}:${post.id}` })).filter(post => {
    if (seen.has(post.flowKey)) return false;
    seen.add(post.flowKey); return true;
  });
  const combined = [...current,...entries];
  // Keep the reader and a little back-scroll history when discarding older rounds.
  const removed = Math.min(Math.max(0,active-12),Math.max(0,combined.length-maximum));
  // A slow request or manual retry can finish after the reader has scrolled back.
  // Leave its cursor untouched until there is room, rather than dropping unseen posts.
  if (combined.length-removed > maximum) return { posts:current, removed:0, deferred:true };
  return { posts:combined.slice(removed), removed };
}
