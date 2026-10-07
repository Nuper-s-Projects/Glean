export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
export const requestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function safeLog(level, message, meta = {}) {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  console[level](`[moderation] ${message}`, clean);
}
