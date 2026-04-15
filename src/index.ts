import 'dotenv/config';
import Fastify from 'fastify';
import { loadConfig, printStartupSummary } from './config/loader.js';
import { createProvider } from './providers/factory.js';
import { OrchestrationLoop } from './orchestrator/loop.js';
import { TraceLogger } from './logger/trace.js';
import { registerOpenAISurface } from './surfaces/openai.js';
import { registerAnthropicSurface } from './surfaces/anthropic.js';
import { OllamaProvider } from './providers/ollama.js';

async function main() {
  console.log('[llmeld] Starting...');

  // Load and validate config
  const config = loadConfig();
  printStartupSummary(config);

  // Create providers
  const plannerProvider = createProvider(config.providers.planner, 'planner');
  const executorProvider = createProvider(config.providers.executor, 'executor');
  const fallbackProvider = config.providers.fallback
    ? createProvider(config.providers.fallback, 'fallback')
    : undefined;

  // Check Ollama connectivity if executor is Ollama
  if (executorProvider instanceof OllamaProvider) {
    const available = await executorProvider.isAvailable();
    if (!available) {
      console.warn(
        `[llmeld] ! Ollama is not reachable at ${config.providers.executor.base_url ?? 'localhost:11434'}. ` +
          'Local execution will fail until Ollama is started.',
      );
    }
  }

  // Create orchestrator
  const orchestrator = new OrchestrationLoop(
    plannerProvider,
    executorProvider,
    config.routing,
    fallbackProvider,
  );

  // Create logger
  const logger = new TraceLogger(config.logging);

  // Shared dependencies
  const deps = {
    config,
    plannerProvider,
    executorProvider,
    fallbackProvider,
    orchestrator,
    logger,
  };

  // Create OpenAI surface
  const openaiApp = Fastify({ logger: false });
  openaiApp.addContentTypeParser(
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
  registerOpenAISurface(openaiApp, deps);

  // Create Anthropic surface
  const anthropicApp = Fastify({ logger: false });
  anthropicApp.addContentTypeParser(
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
  registerAnthropicSurface(anthropicApp, deps);

  // Start servers
  try {
    await openaiApp.listen({ port: config.gateway.openai_port, host: '0.0.0.0' });
    console.log(`[llmeld] OpenAI surface listening on :${config.gateway.openai_port}`);

    await anthropicApp.listen({ port: config.gateway.anthropic_port, host: '0.0.0.0' });
    console.log(`[llmeld] Anthropic surface listening on :${config.gateway.anthropic_port}`);

    console.log('[llmeld] Ready.');
  } catch (err) {
    console.error('[llmeld] Failed to start:', err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[llmeld] Shutting down...');
    await Promise.all([openaiApp.close(), anthropicApp.close()]);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[llmeld] Fatal error:', err);
  process.exit(1);
});
