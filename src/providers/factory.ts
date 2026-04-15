import type { CloudProvider } from './base.js';
import type { ProviderConfig } from '../types/config.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { OllamaProvider } from './ollama.js';
import { OpenRouterProvider } from './openrouter.js';
import { AnthropicDirectProvider } from './anthropic-direct.js';
import { resolveProviderApiKey } from '../config/loader.js';

export function createProvider(config: ProviderConfig, role: string): CloudProvider {
  const apiKey = resolveProviderApiKey(config);

  switch (config.type) {
    case 'ollama':
      return new OllamaProvider({
        baseUrl: config.base_url ?? 'http://localhost:11434/v1',
        apiKey: apiKey || 'ollama',
        model: config.model,
        maxTokens: config.max_tokens,
        temperature: config.temperature,
        timeoutMs: config.timeout_ms,
      });

    case 'openrouter':
      if (!apiKey) {
        throw new Error(`[llmeld] ${role}: OPENROUTER_API_KEY is required for openrouter provider`);
      }
      return new OpenRouterProvider({
        baseUrl: config.base_url ?? 'https://openrouter.ai/api/v1',
        apiKey,
        model: config.model,
        maxTokens: config.max_tokens,
        temperature: config.temperature,
        timeoutMs: config.timeout_ms,
        attribution: config.attribution,
      });

    case 'anthropic':
      if (!apiKey) {
        throw new Error(`[llmeld] ${role}: ANTHROPIC_API_KEY is required for anthropic provider`);
      }
      return new AnthropicDirectProvider({
        apiKey,
        model: config.model,
        baseUrl: config.base_url ?? undefined,
        maxTokens: config.max_tokens,
        timeoutMs: config.timeout_ms,
      });

    case 'openai-compatible':
      if (!config.base_url) {
        throw new Error(`[llmeld] ${role}: base_url is required for openai-compatible provider`);
      }
      return new OpenAICompatibleProvider({
        name: `openai-compatible-${role}`,
        baseUrl: config.base_url,
        apiKey: apiKey || '',
        model: config.model,
        maxTokens: config.max_tokens,
        temperature: config.temperature,
        timeoutMs: config.timeout_ms,
      });

    default:
      throw new Error(`[llmeld] Unknown provider type: ${config.type}`);
  }
}
