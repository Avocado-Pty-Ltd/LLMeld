#!/usr/bin/env node
import 'dotenv/config';
import Fastify from 'fastify';
import { loadConfig, printStartupSummary } from './config/loader.js';
import { createProvider } from './providers/factory.js';
import { OrchestrationLoop } from './orchestrator/loop.js';
import { TraceLogger } from './logger/trace.js';
import { MemoryManager } from './memory/manager.js';
import { registerOpenAISurface } from './surfaces/openai.js';
import { registerAnthropicSurface } from './surfaces/anthropic.js';
import { OllamaProvider } from './providers/ollama.js';
import { StatsCollector } from './dashboard/stats.js';
import { DashboardManager } from './dashboard/index.js';
import { installCapture, uninstallCapture } from './dashboard/console-capture.js';

async function main() {
  const useDashboard = process.stdout.isTTY === true && !process.argv.includes('--no-dashboard');

  console.log('[llmeld] Starting...');

  // Load and validate config (may trigger onboarding wizard — before dashboard)
  const config = await loadConfig();
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

  // Create memory manager if enabled
  let memoryManager: MemoryManager | undefined;
  if (config.memory.enabled) {
    const extractionProviderMap = {
      executor: executorProvider,
      planner: plannerProvider,
      fallback: fallbackProvider,
    };
    const extractionProvider = extractionProviderMap[config.memory.extraction_provider] ?? executorProvider;
    memoryManager = new MemoryManager(config.memory, extractionProvider);
    memoryManager.load();
    console.log(`[llmeld] Shared memory enabled (${config.memory.file_path})`);
  }

  // Create orchestrator
  const orchestrator = new OrchestrationLoop(
    plannerProvider,
    executorProvider,
    config.routing,
    fallbackProvider,
    memoryManager,
  );

  // Create stats collector and logger
  const stats = new StatsCollector();
  const logger = new TraceLogger(config.logging, stats);

  // Shared dependencies
  const deps = {
    config,
    plannerProvider,
    executorProvider,
    fallbackProvider,
    orchestrator,
    logger,
    memoryManager,
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

  // Start dashboard (after servers are up, after onboarding)
  let dashboard: DashboardManager | undefined;
  if (useDashboard) {
    installCapture();
    dashboard = new DashboardManager(stats, config);
    dashboard.start();
  }

  // Graceful shutdown
  const shutdown = async () => {
    if (dashboard) {
      dashboard.stop();
      uninstallCapture();
    }
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
