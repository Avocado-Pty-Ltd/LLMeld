import type { NormalisedLLMResponse } from '../types/normalised.js';

export function toOpenAIChatCompletion(res: NormalisedLLMResponse, modelAlias: string) {
  return {
    id: res.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelAlias,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: res.content || null,
          ...(res.tool_calls && res.tool_calls.length > 0
            ? { tool_calls: res.tool_calls }
            : {}),
        },
        finish_reason: res.finish_reason ?? 'stop',
      },
    ],
    usage: res.usage
      ? {
          prompt_tokens: res.usage.prompt_tokens,
          completion_tokens: res.usage.completion_tokens,
          total_tokens: res.usage.total_tokens,
        }
      : undefined,
  };
}

export function toOpenAIModelList(aliases: string[]) {
  return {
    object: 'list',
    data: aliases.map((id) => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'llmeld',
    })),
  };
}
