import type { NormalisedLLMRequest, NormalisedMessage, NormalisedTool } from '../types/normalised.js';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicRequestBody {
  model: string;
  messages: Array<{
    role: string;
    content: string | AnthropicContentBlock[];
  }>;
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  tool_choice?: unknown;
}

export function fromAnthropic(body: AnthropicRequestBody): NormalisedLLMRequest {
  const messages: NormalisedMessage[] = [];

  // Anthropic uses a top-level system field
  if (body.system) {
    messages.push({ role: 'system', content: body.system });
  }

  for (const msg of body.messages) {
    if (typeof msg.content === 'string') {
      messages.push({
        role: msg.role as NormalisedMessage['role'],
        content: msg.content,
      });
      continue;
    }

    // Content is an array of blocks
    const textParts: string[] = [];
    const toolCalls: NormalisedMessage['tool_calls'] = [];
    let toolResultId: string | undefined;
    let toolResultContent = '';

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? '',
          type: 'function',
          function: {
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === 'tool_result') {
        toolResultId = block.tool_use_id;
        toolResultContent = block.content ?? '';
      }
    }

    if (toolResultId) {
      messages.push({
        role: 'tool',
        content: toolResultContent,
        tool_call_id: toolResultId,
      });
    } else {
      messages.push({
        role: msg.role as NormalisedMessage['role'],
        content: textParts.join(''),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }
  }

  const tools: NormalisedTool[] | undefined = body.tools?.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  return {
    messages,
    model: body.model,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: body.stream,
    tools,
  };
}
