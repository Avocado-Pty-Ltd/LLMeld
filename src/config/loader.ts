import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { config as loadDotenv } from 'dotenv';
import { configSchema } from './schema.js';
import type { LLMeldConfig, ProviderConfig } from '../types/config.js';
import { runOnboardingWizard } from '../onboarding.js';

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

export async function loadConfig(configPath?: string): Promise<LLMeldConfig> {
  const filePath = resolve(configPath ?? process.env.LLMELD_CONFIG ?? 'config.yaml');

  if (!existsSync(filePath)) {
    await runOnboardingWizard();
    // Re-load .env since the wizard may have just created it
    loadDotenv({ override: true });
    if (!existsSync(filePath)) {
      console.error('[llmeld] Config error: onboarding did not create a config file');
      process.exit(1);
    }
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
  const pm = config.routing.planner_models;

  let plannerDesc: string;
  if (pm?.coding && pm?.general && pm.coding !== pm.general) {
    plannerDesc = `coding: ${pm.coding}, general: ${pm.general}`;
  } else if (pm?.coding || pm?.general) {
    plannerDesc = `${config.providers.planner.type} (${pm.coding || pm.general})`;
  } else {
    plannerDesc = `${config.providers.planner.type} (${config.providers.planner.model})`;
  }

  // Dynamically size the table to fit content
  const rows: [string, string][] = [
    ['OpenAI', `:${config.gateway.openai_port}`],
    ['Anthropic', `:${config.gateway.anthropic_port}`],
    ['Planner', plannerDesc],
    ['Executor', `${config.providers.executor.type} (${config.providers.executor.model})`],
    ['Fallback', fallback ? `${fallback.type} (${fallback.model})` : 'none'],
    ['Mode', config.routing.default_mode],
  ];

  const labelWidth = 13;
  const valueWidth = Math.max(38, ...rows.map(([, v]) => v.length + 2));
  const lines = [
    `\u250c${'\u2500'.repeat(labelWidth)}\u252c${'\u2500'.repeat(valueWidth)}\u2510`,
    ...rows.map(
      ([label, value]) =>
        `\u2502 ${label.padEnd(labelWidth - 2)} \u2502 ${value.padEnd(valueWidth - 2)} \u2502`,
    ),
    `\u2514${'\u2500'.repeat(labelWidth)}\u2534${'\u2500'.repeat(valueWidth)}\u2518`,
  ];

  for (const line of lines) {
    console.log(`[llmeld] ${line}`);
  }
}
