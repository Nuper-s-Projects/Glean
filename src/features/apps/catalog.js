export const APP_CATALOG = [
  {
    id: 'whiteboard',
    name: 'Whiteboard',
    tagline: 'Draw, write, and drop images on a shared canvas.',
    accent: '#249cff',
  },
  {
    id: 'gartic',
    name: 'Gartic Phone',
    tagline: 'Write a prompt, draw it badly, guess what happened.',
    accent: '#f0a202',
  },
];

export function appById(id) {
  return APP_CATALOG.find((item) => item.id === id) || null;
}

export function channelAppScope(serverId, channelId) {
  if (!serverId || !channelId) return null;
  return { kind: 'channel', serverId: Number(serverId), channelId: Number(channelId), key: `c:${Number(serverId)}:${Number(channelId)}` };
}

export function dmAppScope(conversationId) {
  if (!conversationId) return null;
  return { kind: 'dm', conversationId: Number(conversationId), key: `d:${Number(conversationId)}` };
}

export const GARTIC_MODES = [
  { id: 'normal', label: 'Normal', hint: 'Write a prompt, draw the prompt, guess the drawing.' },
  { id: 'secret', label: 'Secret', hint: 'Same chain, but you cannot see what you are drawing.' },
  { id: 'knockoff', label: 'Knock-Off', hint: 'Copy the drawing you receive. The clock keeps shrinking.' },
  { id: 'complement', label: 'Complement', hint: 'Start with a scribble, then finish someone else’s.' },
];

export const GARTIC_TIMERS = [30, 45, 60, 90, 120];
