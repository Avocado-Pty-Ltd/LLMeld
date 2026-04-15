import { describe, it, expect } from 'vitest';
import { configSchema } from '../src/config/schema.js';

describe('config schema', () => {
  const minimalConfig = {
    providers: {
      planner: { type: 'openrouter', model: 'anthropic/claude-sonnet-4-20250514', api_key_env: 'OPENROUTER_API_KEY' },
      executor: { type: 'ollama', model: 'gemma3:4b', base_url: 'http://localhost:11434/v1', api_key: 'ollama' },
    },
  };

  it('parses minimal config with defaults', () => {
    const result = configSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.gateway.openai_port).toBe(8000);
    expect(result.data.gateway.anthropic_port).toBe(8001);
    expect(result.data.gateway.api_key).toBe('llmeld-local');
    expect(result.data.gateway.model_alias).toBe('llmeld/planner-executor');
    expect(result.data.routing.default_mode).toBe('balanced');
    expect(result.data.logging.level).toBe('info');
  });

  it('rejects config missing providers', () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects config with invalid provider type', () => {
    const result = configSchema.safeParse({
      providers: {
        planner: { type: 'invalid', model: 'test' },
        executor: { type: 'ollama', model: 'test' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts full config with all fields', () => {
    const full = {
      gateway: {
        openai_port: 9000,
        anthropic_port: 9001,
        api_key: 'custom-key',
        model_alias: 'my-model',
        debug_traces: true,
      },
      providers: {
        planner: {
          type: 'anthropic',
          model: 'claude-opus-4-6',
          api_key_env: 'ANTHROPIC_API_KEY',
        },
        executor: {
          type: 'ollama',
          model: 'gemma3:4b',
          base_url: 'http://localhost:11434/v1',
          api_key: 'ollama',
          max_tokens: 2048,
          temperature: 0.1,
          timeout_ms: 30000,
        },
        fallback: {
          type: 'openrouter',
          model: 'anthropic/claude-haiku-4',
          api_key_env: 'OPENROUTER_API_KEY',
          base_url: 'https://openrouter.ai/api/v1',
        },
      },
      routing: {
        default_mode: 'best',
        simple_threshold: 300,
        complex_threshold: 2000,
        max_retries: 3,
        enable_task_classifier: false,
        privacy_mode: true,
        complex_keywords: ['build'],
        simple_keywords: ['what'],
      },
      logging: {
        level: 'debug',
        format: 'jsonl',
        trace_file: '/tmp/traces.jsonl',
        emit_token_costs: false,
      },
    };

    const result = configSchema.safeParse(full);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.gateway.openai_port).toBe(9000);
    expect(result.data.routing.default_mode).toBe('best');
    expect(result.data.providers.fallback?.type).toBe('openrouter');
  });
});
