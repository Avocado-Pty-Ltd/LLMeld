import type { CloudProvider } from './base.js';
import type {
  NormalisedLLMRequest,
  NormalisedLLMResponse,
  NormalisedMessage,
  NormalisedToolCall,
  NormalisedTokenUsage,
} from '../types/normalised.js';
import { v4 as uuidv4 } from 'uuid';

export interface AnthropicDirectConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicDirectProvider implements CloudProvider {
  name = 'anthropic';
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private maxTokens: number;
  private timeoutMs: number;

  constructor(config: AnthropicDirectConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.maxTokens = config.maxTokens ?? 4096;
    this.timeoutMs = config.timeoutMs ?? 120000;
  }

  async createChatCompletion(req: NormalisedLLMRequest): Promise<NormalisedLLMResponse> {
    const { system, messages } = this.buildMessages(req);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.max_tokens ?? this.maxTokens,
      messages,
      stream: false,
    };

    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop) body.stop_sequences = req.stop;

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t): AnthropicTool => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: (t.function.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
      }));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      return this.parseResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildMessages(req: NormalisedLLMRequest): {
    system: string | undefined;
    messages: AnthropicMessage[];
  } {
    let system: string | undefined;
    const messages: AnthropicMessage[] = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') {
        system = (system ? system + '\n' : '') + msg.content;
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results in Anthropic format go into a user message
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result' as 'text',
              tool_use_id: msg.tool_call_id,
              content: msg.content,
            } as unknown as AnthropicContentBlock,
          ],
        });
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const content: AnthropicContentBlock[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          });
        }
        messages.push({ role: 'assistant', content });
        continue;
      }

      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    return { system, messages };
  }

  private parseResponse(data: AnthropicResponse): NormalisedLLMResponse {
    let textContent = '';
    const toolCalls: NormalisedToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: `call_${(block.id ?? uuidv4()).replace('toolu_', '')}`,
          type: 'function',
          function: {
            name: block.name!,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const usage: NormalisedTokenUsage = {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    };

    return {
      id: data.id,
      model: data.model,
      content: textContent,
      role: 'assistant',
      finish_reason: this.mapStopReason(data.stop_reason),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }

  private mapStopReason(
    reason: AnthropicResponse['stop_reason'],
  ): NormalisedLLMResponse['finish_reason'] {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      default:
        return null;
    }
  }
}
