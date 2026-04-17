import type { CloudProvider } from './base.js';
import type {
  NormalisedLLMRequest,
  NormalisedLLMResponse,
  NormalisedStreamEvent,
  NormalisedToolCall,
  NormalisedTokenUsage,
} from '../types/normalised.js';
import { v4 as uuidv4 } from 'uuid';

export interface OpenAICompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class OpenAICompatibleProvider implements CloudProvider {
  name: string;
  protected baseUrl: string;
  protected apiKey: string;
  protected model: string;
  protected maxTokens?: number;
  protected temperature?: number;
  protected timeoutMs: number;
  protected extraHeaders: Record<string, string>;

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
    this.timeoutMs = config.timeoutMs ?? 60000;
    this.extraHeaders = config.extraHeaders ?? {};
  }

  async createChatCompletion(req: NormalisedLLMRequest): Promise<NormalisedLLMResponse> {
    const messages = this.buildMessages(req);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: req.max_tokens ?? this.maxTokens ?? 4096,
      temperature: req.temperature ?? this.temperature,
      stream: false,
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      if (req.tool_choice) body.tool_choice = req.tool_choice;
    }
    if (req.stop) body.stop = req.stop;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.response_format) body.response_format = req.response_format;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `${this.name} API error ${response.status}: ${errorBody}`,
        );
      }

      const data = (await response.json()) as OpenAIResponse;
      return this.parseResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }

  async *createStreamingCompletion(req: NormalisedLLMRequest): AsyncIterable<NormalisedStreamEvent> {
    const messages = this.buildMessages(req);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: req.max_tokens ?? this.maxTokens ?? 4096,
      temperature: req.temperature ?? this.temperature,
      stream: true,
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      if (req.tool_choice) body.tool_choice = req.tool_choice;
    }
    if (req.stop) body.stop = req.stop;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.response_format) body.response_format = req.response_format;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`${this.name} API error ${response.status}: ${errorBody}`);
      }

      if (!response.body) {
        throw new Error(`${this.name}: no response body for streaming`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (delta?.content) {
                yield { type: 'content_delta', content: delta.content };
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  yield {
                    type: 'tool_call_delta',
                    tool_call: {
                      id: tc.id,
                      type: 'function',
                      function: {
                        name: tc.function?.name,
                        arguments: tc.function?.arguments,
                      },
                    },
                  };
                }
              }

              if (choice.finish_reason) {
                yield {
                  type: 'done',
                  finish_reason: this.mapFinishReason(choice.finish_reason),
                  usage: parsed.usage ? {
                    prompt_tokens: parsed.usage.prompt_tokens,
                    completion_tokens: parsed.usage.completion_tokens,
                    total_tokens: parsed.usage.total_tokens,
                  } : undefined,
                };
              }
            } catch {
              // Skip unparseable lines
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  protected buildMessages(req: NormalisedLLMRequest): OpenAIMessage[] {
    return req.messages.map((msg) => {
      const out: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };
      if (msg.name) out.name = msg.name;
      if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        out.tool_calls = msg.tool_calls;
      }
      return out;
    });
  }

  protected parseResponse(data: OpenAIResponse): NormalisedLLMResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new Error(`${this.name}: no choices in response`);
    }

    const toolCalls: NormalisedToolCall[] | undefined =
      choice.message.tool_calls?.map((tc) => ({
        id: tc.id || uuidv4(),
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));

    const usage: NormalisedTokenUsage | undefined = data.usage
      ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        }
      : undefined;

    return {
      id: data.id || uuidv4(),
      model: data.model,
      content: choice.message.content ?? '',
      role: 'assistant',
      finish_reason: this.mapFinishReason(choice.finish_reason),
      tool_calls: toolCalls,
      usage,
    };
  }

  protected mapFinishReason(
    reason: string | null,
  ): NormalisedLLMResponse['finish_reason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'tool_calls':
        return 'tool_calls';
      case 'content_filter':
        return 'content_filter';
      default:
        return null;
    }
  }
}
