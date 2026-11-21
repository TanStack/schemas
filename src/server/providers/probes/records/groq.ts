// Written by `pnpm run probe -- groq --write`. Do not edit by hand.
import type { ProbedFactRecord } from '../types.ts'

export const records: Array<ProbedFactRecord> = [
  {
    id: 'openai/gpt-oss-20b:maxOutput',
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    fact: 'maxOutput',
    value: 65536,
    route: 'openai/v1/chat/completions',
    verifiedAt: '2026-11-21',
    ranBy: 'tom',
    request: {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      body: {
        model: 'openai/gpt-oss-20b',
        stream: true,
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
        max_tokens: 10000000,
      },
    },
    evidence: {
      status: 400,
      message:
        '`max_tokens` must be less than or equal to `65536`, the maximum value for `max_tokens` is less than the `context_window` for this model',
    },
  },
  {
    id: 'openai/gpt-oss-20b:reasoning.mandatory',
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    fact: 'reasoning.mandatory',
    value: true,
    route: 'openai/v1/chat/completions',
    verifiedAt: '2026-11-21',
    ranBy: 'tom',
    request: {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      body: {
        model: 'openai/gpt-oss-20b',
        stream: true,
        max_tokens: 1,
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
        reasoning_effort: 'none',
      },
    },
    evidence: {
      status: 400,
      message: '`reasoning_effort` must be one of `low`, `medium`, or `high`',
    },
  },
  {
    id: 'openai/gpt-oss-20b:replayReasoningContent',
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    fact: 'replayReasoningContent',
    value: false,
    route: 'openai/v1/chat/completions',
    verifiedAt: '2026-11-21',
    ranBy: 'tom',
    request: {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      body: {
        model: 'openai/gpt-oss-20b',
        stream: true,
        max_tokens: 1,
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
          {
            role: 'assistant',
            content: 'ok',
            reasoning_content: 'x',
          },
          {
            role: 'user',
            content: 'hi',
          },
        ],
      },
    },
    evidence: {
      status: 400,
      message:
        "'messages.1' : for 'role:assistant' the following must be satisfied[('messages.1' : property 'reasoning_content' is unsupported)]",
    },
  },
  {
    id: 'openai/gpt-oss-safeguard-20b:maxOutput',
    provider: 'groq',
    model: 'openai/gpt-oss-safeguard-20b',
    fact: 'maxOutput',
    value: 65536,
    route: 'openai/v1/chat/completions',
    verifiedAt: '2026-11-21',
    ranBy: 'tom',
    request: {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      body: {
        model: 'openai/gpt-oss-safeguard-20b',
        stream: true,
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
        max_tokens: 10000000,
      },
    },
    evidence: {
      status: 400,
      message:
        '`max_tokens` must be less than or equal to `65536`, the maximum value for `max_tokens` is less than the `context_window` for this model',
    },
  },
  {
    id: 'openai/gpt-oss-safeguard-20b:reasoning.mandatory',
    provider: 'groq',
    model: 'openai/gpt-oss-safeguard-20b',
    fact: 'reasoning.mandatory',
    value: true,
    route: 'openai/v1/chat/completions',
    verifiedAt: '2026-11-21',
    ranBy: 'tom',
    request: {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      body: {
        model: 'openai/gpt-oss-safeguard-20b',
        stream: true,
        max_tokens: 1,
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
        ],
        reasoning_effort: 'none',
      },
    },
    evidence: {
      status: 400,
      message: '`reasoning_effort` must be one of `low`, `medium`, or `high`',
    },
  },
  {
    id: 'openai/gpt-oss-safeguard-20b:replayReasoningContent',
    provider: 'groq',
    model: 'openai/gpt-oss-safeguard-20b',
    fact: 'replayReasoningContent',
    value: false,
    route: 'openai/v1/chat/completions',
    verifiedAt: '2026-11-21',
    ranBy: 'tom',
    request: {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      body: {
        model: 'openai/gpt-oss-safeguard-20b',
        stream: true,
        max_tokens: 1,
        messages: [
          {
            role: 'user',
            content: 'hi',
          },
          {
            role: 'assistant',
            content: 'ok',
            reasoning_content: 'x',
          },
          {
            role: 'user',
            content: 'hi',
          },
        ],
      },
    },
    evidence: {
      status: 400,
      message:
        "'messages.1' : for 'role:assistant' the following must be satisfied[('messages.1' : property 'reasoning_content' is unsupported)]",
    },
  },
]
