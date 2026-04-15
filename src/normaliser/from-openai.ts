import type { NormalisedLLMRequest, NormalisedMessage, NormalisedTool } from '../types/normalised.js';

interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface OpenAIRequestBody {
  model: string;
  messages: Array<{
    role: string;
    content: string | null | OpenAIContentPart[];
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  tool_choice?: unknown;
  response_format?: { type: string };
}

function extractTextContent(content: string | null | OpenAIContentPart[]): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text!)
      .join('');
  }
  return String(content);
}

export function fromOpenAI(body: OpenAIRequestBody): NormalisedLLMRequest {
  const messages: NormalisedMessage[] = body.messages.map((msg) => ({
    role: msg.role as NormalisedMessage['role'],
    content: extractTextContent(msg.content),
    name: msg.name,
    tool_call_id: msg.tool_call_id,
    tool_calls: msg.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    })),
  }));

  const tools: NormalisedTool[] | undefined = body.tools?.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));

  return {
    messages,
    model: body.model,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: typeof body.stop === 'string' ? [body.stop] : body.stop,
    stream: body.stream,
    tools,
    tool_choice: body.tool_choice as NormalisedLLMRequest['tool_choice'],
    response_format: body.response_format as NormalisedLLMRequest['response_format'],
  };
}
