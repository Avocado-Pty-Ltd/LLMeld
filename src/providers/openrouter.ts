import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
import type { NormalisedLLMRequest, NormalisedLLMResponse, NormalisedToolCall } from '../types/normalised.js';
import { v4 as uuidv4 } from 'uuid';

export interface OpenRouterConfig extends Omit<OpenAICompatibleConfig, 'name'> {
  attribution?: {
    enabled: boolean;
    http_referer?: string;
    x_title?: string;
  };
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(config: OpenRouterConfig) {
    const extraHeaders: Record<string, string> = { ...config.extraHeaders };

    if (config.attribution?.enabled) {
      if (config.attribution.http_referer) {
        extraHeaders['HTTP-Referer'] = config.attribution.http_referer;
      }
      if (config.attribution.x_title) {
        extraHeaders['X-Title'] = config.attribution.x_title;
      }
    }

    super({
      ...config,
      name: 'openrouter',
      extraHeaders,
    });
  }

  async createChatCompletion(req: NormalisedLLMRequest): Promise<NormalisedLLMResponse> {
    const response = await super.createChatCompletion(req);
    // Normalize tool call IDs — OpenRouter + Anthropic models can produce
    // non-standard tool call IDs that break downstream clients
    if (response.tool_calls) {
      response.tool_calls = response.tool_calls.map((tc): NormalisedToolCall => ({
        ...tc,
        id: this.normalizeToolCallId(tc.id),
      }));
    }
    return response;
  }

  private normalizeToolCallId(id: string): string {
    // OpenAI expects tool call IDs like "call_abc123"
    // Anthropic via OpenRouter may return different formats
    if (id.startsWith('call_')) return id;
    if (id.startsWith('toolu_')) return `call_${id.slice(6)}`;
    if (!id.includes('_')) return `call_${id}`;
    return `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  }
}
