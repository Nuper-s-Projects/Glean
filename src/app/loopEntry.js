// Only this local destination is allowed. Never follow arbitrary redirect URLs.
export function loopReturnPath(location) {
  if (!location) return null;
  const query = new URLSearchParams(location.search || '');
  const post = query.get('post');
  const target = location.pathname.replace(/\/+$/, '') === '/loop'
    ? (post && /^\d+$/.test(post) ? `/loop?post=${post}` : '/loop')
    : query.get('next');
  if (!target || !/^\/loop(?:\?post=\d+)?$/.test(target)) return null;
  return target;
}

export function loopSignInPath(returnPath) {
  return `/signin?${new URLSearchParams({next:returnPath || '/loop'})}`;
}
