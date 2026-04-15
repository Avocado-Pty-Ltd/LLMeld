import { OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
import type { NormalisedLLMRequest, NormalisedLLMResponse } from '../types/normalised.js';

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(config: Omit<OpenAICompatibleConfig, 'name'>) {
    super({ ...config, name: 'ollama' });
  }

  async createChatCompletion(req: NormalisedLLMRequest): Promise<NormalisedLLMResponse> {
    try {
      return await super.createChatCompletion(req);
    } catch (err) {
      if (err instanceof TypeError && 'cause' in err) {
        throw new Error(
          `Ollama is not reachable at ${this.baseUrl}. Is it running? (ollama serve)`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${this.baseUrl.replace('/v1', '')}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }
}
