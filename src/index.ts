#!/usr/bin/env node
import 'dotenv/config';
import Fastify from 'fastify';
import { loadConfig, printStartupSummary } from './config/loader.js';
import { createProvider } from './providers/factory.js';
import { TraceLogger } from './logger/trace.js';
import { registerOpenAISurface } from './surfaces/openai.js';
import { registerAnthropicSurface } from './surfaces/anthropic.js';
import { OllamaProvider } from './providers/ollama.js';
import { MemoryCache } from './cache/memory-cache.js';

async function main() {
  console.log('[llmeld] Starting...');

  // Load and validate config (may trigger onboarding wizard)
  const config = await loadConfig();
  printStartupSummary(config);

  // Create single provider
  const provider = createProvider(config.provider, 'provider');

  // Check Ollama connectivity if provider is Ollama
  if (provider instanceof OllamaProvider) {
    const available = await provider.isAvailable();
    if (!available) {
      console.warn(
        `[llmeld] ! Ollama is not reachable at ${config.provider.base_url ?? 'localhost:11434'}. ` +
          'Requests will fail until Ollama is started.',
      );
    }
  }

  // Create logger and memory cache
  const logger = new TraceLogger(config.logging);
  const memoryCache = new MemoryCache();

  // Shared dependencies
  const deps = { config, provider, logger, memoryCache };

  // Single Fastify server serving both surfaces
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // OpenAI surface at /v1/...
  registerOpenAISurface(app, deps);

  // Anthropic surface at /v1/messages (shares /v1 prefix but distinct routes)
  registerAnthropicSurface(app, deps);

  // Start server
  try {
    await app.listen({ port: config.gateway.port, host: '0.0.0.0' });
    console.log(`[llmeld] Listening on :${config.gateway.port}`);
    console.log('[llmeld] Ready.');
  } catch (err) {
    console.error('[llmeld] Failed to start:', err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[llmeld] Shutting down...');
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[llmeld] Fatal error:', err);
  process.exit(1);
});
