import type {
  NormalisedLLMRequest,
  NormalisedLLMResponse,
  NormalisedStreamEvent,
  ProviderModel,
} from '../types/normalised.js';

export interface CloudProvider {
  name: string;
  createChatCompletion(req: NormalisedLLMRequest): Promise<NormalisedLLMResponse>;
  createStreamingCompletion?(req: NormalisedLLMRequest): AsyncIterable<NormalisedStreamEvent>;
  listModels?(): Promise<ProviderModel[]>;
}
