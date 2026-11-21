import type { ChatCompletionsProbe } from './chat-completions.ts'

/** Groq on the generic chat probe (issue #717). */
export const probe: ChatCompletionsProbe = {
  provider: 'groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  route: 'openai/v1/chat/completions',
  keyEnv: 'GROQ_API_KEY',
  models: ['openai/gpt-oss-20b', 'openai/gpt-oss-safeguard-20b'],
}
