import { describe, it, expect } from 'vitest';
import { configSchema } from '../src/config/schema.js';

describe('config schema', () => {
  const minimalConfig = {
    provider: { type: 'openrouter', model: 'anthropic/claude-sonnet-4-20250514', api_key_env: 'OPENROUTER_API_KEY' },
  };

  it('parses minimal config with defaults', () => {
    const result = configSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.gateway.port).toBe(8000);
    expect(result.data.gateway.api_key).toBe('llmeld-local');
    expect(result.data.gateway.model_alias).toBe('llmeld/agent');
    expect(result.data.agent.max_iterations).toBe(15);
    expect(result.data.agent.parallel_tools).toBe(true);
    expect(result.data.logging.level).toBe('info');
  });

  it('rejects config missing provider', () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects config with invalid provider type', () => {
    const result = configSchema.safeParse({
      provider: { type: 'invalid', model: 'test' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts full config with all fields', () => {
    const full = {
      gateway: {
        port: 9000,
        api_key: 'custom-key',
        model_alias: 'my-model',
        debug_traces: true,
      },
      provider: {
        type: 'anthropic',
        model: 'claude-opus-4-6',
        api_key_env: 'ANTHROPIC_API_KEY',
      },
      agent: {
        max_iterations: 20,
        parallel_tools: false,
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

    expect(result.data.gateway.port).toBe(9000);
    expect(result.data.agent.max_iterations).toBe(20);
    expect(result.data.agent.parallel_tools).toBe(false);
  });
});
