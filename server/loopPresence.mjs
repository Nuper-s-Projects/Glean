// Loop activity belongs to a socket, not an account: tabs can leave independently.
export function createLoopPresence({ canJoin, visibleUsers, notify }) {
  const sockets = new Map();
  let pending = null;
  const invalidate = userId => {
    if (userId != null && ![...sockets.values()].includes(Number(userId))) return;
    if (pending || !sockets.size) return;
    pending = setTimeout(() => {
      pending = null;
      notify(new Set(sockets.values()), 'loop-online-changed', {});
    }, 250);
    pending.unref?.();
  };
  const leave = socket => {
    if (!sockets.delete(socket)) return;
    invalidate();
  };
  return {
    handle(user, message, socket) {
      if (message?.event !== 'loop-presence') return false;
      if (message.payload?.active === false) leave(socket);
      else if (message.payload?.active === true && canJoin(user.id) && !socket.destroyed) {
        if (!sockets.has(socket)) {
          sockets.set(socket, Number(user.id));
          invalidate();
        }
      }
      return true;
    },
    leave,
    invalidate,
    list(viewerId) {
      const ids = [...new Set([...sockets].filter(([socket]) => !socket.destroyed).map(([, id]) => id))];
      return ids.length ? visibleUsers(ids, Number(viewerId)) : [];
    },
    close() { clearTimeout(pending); pending = null; sockets.clear(); },
  };
}
