import { z } from 'zod/v4';

const providerAttributionSchema = z.object({
  enabled: z.boolean().default(false),
  http_referer: z.string().optional(),
  x_title: z.string().optional(),
});

const providerConfigSchema = z.object({
  type: z.enum(['anthropic', 'openrouter', 'openai-compatible', 'ollama']),
  model: z.string().min(1),
  api_key_env: z.string().optional(),
  api_key: z.string().optional(),
  base_url: z.string().nullable().optional(),
  max_tokens: z.number().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeout_ms: z.number().positive().optional(),
  use_responses_api: z.boolean().optional(),
  attribution: providerAttributionSchema.optional(),
});

const gatewaySchema = z.object({
  port: z.number().int().positive().default(8000),
  api_key: z.string().default('llmeld-local'),
  model_alias: z.string().default('llmeld/agent'),
  debug_traces: z.boolean().default(false),
});

const agentSchema = z.object({
  max_iterations: z.number().int().positive().default(15),
  parallel_tools: z.boolean().default(true),
});

const loggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['jsonl', 'pretty']).default('pretty'),
  trace_file: z.string().default('./logs/traces.jsonl'),
  emit_token_costs: z.boolean().default(true),
});

export const configSchema = z.object({
  gateway: gatewaySchema.optional().transform((v) => gatewaySchema.parse(v ?? {})),
  provider: providerConfigSchema,
  agent: agentSchema.optional().transform((v) => agentSchema.parse(v ?? {})),
  logging: loggingSchema.optional().transform((v) => loggingSchema.parse(v ?? {})),
});

export type ValidatedConfig = z.infer<typeof configSchema>;
