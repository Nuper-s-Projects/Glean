import { ModerationService } from './moderation-service.js';
import { BackupProvider } from './providers/backup.js';
import { GroqProvider } from './providers/groq.js';
import { LocalRulesProvider } from './providers/local-rules.js';
import { requestId } from './lib/utils.js';

const timeoutMs = Math.max(500, Math.min(10_000, Number(process.env.GLEAN_MODERATION_TIMEOUT_MS) || 4_000));

const groq = new GroqProvider({
  name: 'groq',
  apiKey: String(process.env.GROQ_API_KEY || '').trim(),
  model: String(process.env.GROQ_MODEL || 'openai/gpt-oss-20b').trim(),
  url: 'https://api.groq.com/openai/v1/chat/completions',
  timeoutMs,
  retries: 0,
  retryBaseMs: 150,
  maxCompletionTokens: 256,
  responseFormat: 'json_object',
});

const moderation = new ModerationService({
  primary: groq,
  backup: new BackupProvider(),
  local: new LocalRulesProvider(),
});

export function moderateServerMessage(text, conversation = []) {
  return moderation.moderate(String(text || ''), { requestId: requestId(), conversation });
}
