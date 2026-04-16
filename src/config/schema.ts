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
  openai_port: z.number().int().positive().default(8000),
  anthropic_port: z.number().int().positive().default(8001),
  api_key: z.string().default('llmeld-local'),
  model_alias: z.string().default('llmeld/planner-executor'),
  debug_traces: z.boolean().default(false),
});

const routingSchema = z.object({
  default_mode: z.enum(['fast', 'balanced', 'best', 'cloud', 'local']).default('balanced'),
  simple_threshold: z.number().positive().default(500),
  complex_threshold: z.number().positive().default(1500),
  max_retries: z.number().int().min(0).default(2),
  enable_task_classifier: z.boolean().default(true),
  privacy_mode: z.boolean().default(false),
  complex_keywords: z.array(z.string()).default([
    'create', 'build', 'implement', 'architect', 'refactor', 'design',
  ]),
  simple_keywords: z.array(z.string()).default([
    'what is', 'define', 'explain briefly',
  ]),
});

const loggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['jsonl', 'pretty']).default('pretty'),
  trace_file: z.string().default('./logs/traces.jsonl'),
  emit_token_costs: z.boolean().default(true),
});

const memorySchema = z.object({
  enabled: z.boolean().default(false),
  file_path: z.string().default('./.llmeld/memory.md'),
  max_inject_tokens: z.number().positive().default(2000),
  extraction_provider: z.enum(['executor', 'planner', 'fallback']).default('executor'),
  max_entries: z.number().positive().default(100),
  staleness_days: z.number().positive().default(30),
  inject_on_direct: z.boolean().default(true),
  auto_extract: z.boolean().default(true),
});

export const configSchema = z.object({
  gateway: gatewaySchema.optional().transform((v) => gatewaySchema.parse(v ?? {})),
  providers: z.object({
    planner: providerConfigSchema,
    executor: providerConfigSchema,
    fallback: providerConfigSchema.optional(),
  }),
  routing: routingSchema.optional().transform((v) => routingSchema.parse(v ?? {})),
  logging: loggingSchema.optional().transform((v) => loggingSchema.parse(v ?? {})),
  memory: memorySchema.optional().transform((v) => memorySchema.parse(v ?? {})),
});

export type ValidatedConfig = z.infer<typeof configSchema>;
