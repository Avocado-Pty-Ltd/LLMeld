export interface NormalisedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: NormalisedToolCall[];
}

export interface NormalisedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface NormalisedToolResult {
  tool_call_id: string;
  content: string;
}

export interface NormalisedTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface NormalisedLLMRequest {
  messages: NormalisedMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  tools?: NormalisedTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'text' | 'json_object' };
  metadata?: Record<string, unknown>;
}

export interface NormalisedTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface NormalisedLLMResponse {
  id: string;
  model: string;
  content: string;
  role: 'assistant';
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  tool_calls?: NormalisedToolCall[];
  usage?: NormalisedTokenUsage;
}

export interface NormalisedStreamEvent {
  type: 'content_delta' | 'tool_call_delta' | 'done' | 'error';
  content?: string;
  tool_call?: Partial<NormalisedToolCall>;
  finish_reason?: NormalisedLLMResponse['finish_reason'];
  usage?: NormalisedTokenUsage;
  error?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  provider: string;
}
