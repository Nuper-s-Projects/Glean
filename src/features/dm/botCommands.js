const COMMANDS = {
  nura: [
    { name: 'chat', description: 'Chat with Nura', usage: 'message' },
    { name: 'activate', description: 'Let Nura reply automatically in this channel' },
    { name: 'deactivate', description: 'Stop automatic replies in this channel' },
  ],
};

export function matchingBotCommands(bots, text, caret = text.length) {
  if (!/^\/[a-z]*$/i.test(text) || caret !== text.length) return [];
  const query = text.slice(1).toLowerCase();
  return bots.flatMap((bot) => (COMMANDS[bot.id] || []).filter((command) => command.name.startsWith(query))
    .map((command) => ({ ...command, bot, key: `${bot.id}:${command.name}` })));
}
