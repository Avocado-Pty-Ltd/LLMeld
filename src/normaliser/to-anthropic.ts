import type { NormalisedLLMResponse } from '../types/normalised.js';

interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export function toAnthropicMessages(res: NormalisedLLMResponse, modelAlias: string) {
  const content: AnthropicContentBlock[] = [];

  if (res.content) {
    content.push({ type: 'text', text: res.content });
  }

  if (res.tool_calls) {
    for (const tc of res.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id.replace('call_', 'toolu_'),
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  // If no content blocks at all, add an empty text block
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const stopReason = mapFinishReasonToAnthropic(res.finish_reason);

  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: modelAlias,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

function mapFinishReasonToAnthropic(
  reason: NormalisedLLMResponse['finish_reason'],
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}
