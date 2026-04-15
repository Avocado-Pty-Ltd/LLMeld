export interface GatewayConfig {
  openai_port: number;
  anthropic_port: number;
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

export interface RoutingConfig {
  default_mode: 'fast' | 'balanced' | 'best' | 'cloud' | 'local';
  simple_threshold: number;
  complex_threshold: number;
  max_retries: number;
  enable_task_classifier: boolean;
  privacy_mode: boolean;
  complex_keywords: string[];
  simple_keywords: string[];
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'jsonl' | 'pretty';
  trace_file: string;
  emit_token_costs: boolean;
}

export interface LLMeldConfig {
  gateway: GatewayConfig;
  providers: {
    planner: ProviderConfig;
    executor: ProviderConfig;
    fallback?: ProviderConfig;
  };
  routing: RoutingConfig;
  logging: LoggingConfig;
}
