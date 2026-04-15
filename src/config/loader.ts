import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { configSchema, type ValidatedConfig } from './schema.js';
import type { LLMeldConfig, ProviderConfig } from '../types/config.js';

function resolveApiKey(provider: ProviderConfig): string | undefined {
  if (provider.api_key) return provider.api_key;
  if (provider.api_key_env) {
    const value = process.env[provider.api_key_env];
    if (!value) {
      console.warn(
        `[llmeld] Warning: env var ${provider.api_key_env} is not set (needed by ${provider.type} provider)`,
      );
    }
    return value;
  }
  return undefined;
}

export function loadConfig(configPath?: string): LLMeldConfig {
  const filePath = resolve(configPath ?? process.env.LLMELD_CONFIG ?? 'config.yaml');

  if (!existsSync(filePath)) {
    console.error(`[llmeld] Config error: file not found at ${filePath}`);
    console.error('[llmeld] Run: cp config.example.yaml config.yaml');
    process.exit(1);
  }

  let raw: unknown;
  try {
    const content = readFileSync(filePath, 'utf-8');
    raw = parseYaml(content);
  } catch (err) {
    console.error(`[llmeld] Config error: failed to parse YAML at ${filePath}`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    console.error('[llmeld] Config validation errors:');
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      console.error(`  - ${path}: ${issue.message}`);
    }
    console.error('[llmeld] See config.example.yaml for reference');
    process.exit(1);
  }

  const validated = result.data as unknown as LLMeldConfig;

  // Resolve API keys from env vars
  resolveApiKey(validated.providers.planner);
  resolveApiKey(validated.providers.executor);
  if (validated.providers.fallback) {
    resolveApiKey(validated.providers.fallback);
  }

  // Override routing mode from env if set
  const envMode = process.env.LLMELD_ROUTING_MODE;
  if (envMode && ['fast', 'balanced', 'best', 'cloud', 'local'].includes(envMode)) {
    validated.routing.default_mode = envMode as LLMeldConfig['routing']['default_mode'];
  }

  return Object.freeze(validated) as LLMeldConfig;
}

export function resolveProviderApiKey(provider: ProviderConfig): string {
  if (provider.api_key) return provider.api_key;
  if (provider.api_key_env) {
    return process.env[provider.api_key_env] ?? '';
  }
  return '';
}

export function printStartupSummary(config: LLMeldConfig): void {
  const fallback = config.providers.fallback;
  const lines = [
    `┌─────────────┬──────────────────────────────────────┐`,
    `│ OpenAI      │ :${String(config.gateway.openai_port).padEnd(37)}│`,
    `│ Anthropic   │ :${String(config.gateway.anthropic_port).padEnd(37)}│`,
    `│ Planner     │ ${`${config.providers.planner.type} (${config.providers.planner.model})`.padEnd(37)}│`,
    `│ Executor    │ ${`${config.providers.executor.type} (${config.providers.executor.model})`.padEnd(37)}│`,
    `│ Fallback    │ ${(fallback ? `${fallback.type} (${fallback.model})` : 'none').padEnd(37)}│`,
    `│ Mode        │ ${config.routing.default_mode.padEnd(37)}│`,
    `└─────────────┴──────────────────────────────────────┘`,
  ];

  for (const line of lines) {
    console.log(`[llmeld] ${line}`);
  }
}
