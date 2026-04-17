export interface GatewayConfig {
  port: number;
  api_key: string;
  model_alias: string;
  debug_traces: boolean;
}

export interface ProviderAttribution {
  enabled: boolean;
  http_referer?: string;
  x_title?: string;
}

export interface ProviderConfig {
  type: 'anthropic' | 'openrouter' | 'openai-compatible' | 'ollama';
  model: string;
  api_key_env?: string;
  api_key?: string;
  base_url?: string | null;
  max_tokens?: number;
  temperature?: number;
  timeout_ms?: number;
  use_responses_api?: boolean;
  attribution?: ProviderAttribution;
}

export interface AgentConfig {
  max_iterations: number;
  parallel_tools: boolean;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'jsonl' | 'pretty';
  trace_file: string;
  emit_token_costs: boolean;
}

export interface LLMeldConfig {
  gateway: GatewayConfig;
  provider: ProviderConfig;
  agent: AgentConfig;
  logging: LoggingConfig;
}
