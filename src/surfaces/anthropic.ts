import type { FastifyInstance } from 'fastify';
import type { LLMeldConfig } from '../types/config.js';
import type { CloudProvider } from '../providers/base.js';
import type { OrchestrationLoop } from '../orchestrator/loop.js';
import type { TraceLogger } from '../logger/trace.js';
import type { MemoryManager } from '../memory/manager.js';
import type { NormalisedLLMRequest } from '../types/normalised.js';
import { fromAnthropic } from '../normaliser/from-anthropic.js';
import { toAnthropicMessages } from '../normaliser/to-anthropic.js';
import { decideRoute } from '../router/policy.js';
import { v4 as uuidv4 } from 'uuid';

export interface AnthropicSurfaceDeps {
  config: LLMeldConfig;
  plannerProvider: CloudProvider;
  executorProvider: CloudProvider;
  fallbackProvider?: CloudProvider;
  orchestrator: OrchestrationLoop;
  logger: TraceLogger;
  memoryManager?: MemoryManager;
}

/** Inject a memory block into the system message of a normalised request. */
function injectMemoryIntoMessages(req: NormalisedLLMRequest, memoryBlock: string): void {
  if (!memoryBlock) return;
  const systemMsg = req.messages.find((m) => m.role === 'system');
  if (systemMsg) {
    systemMsg.content += '\n\n' + memoryBlock;
  } else {
    req.messages.unshift({ role: 'system', content: memoryBlock });
  }
}

export function registerAnthropicSurface(app: FastifyInstance, deps: AnthropicSurfaceDeps) {
  const { config, plannerProvider, executorProvider, orchestrator, logger, memoryManager } = deps;

  // Auth hook
  app.addHook('onRequest', async (request, reply) => {
    const apiKey = request.headers['x-api-key'];
    if (!apiKey || apiKey !== config.gateway.api_key) {
      return reply.status(401).send({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid API key' },
      });
    }

    // Validate anthropic-version header is present (accept any value for forward-compat)
    const version = request.headers['anthropic-version'];
    if (!version) {
      return reply.status(400).send({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Missing anthropic-version header' },
      });
    }
  });

  // POST /v1/messages
  app.post('/v1/messages', async (request, reply) => {
    const start = Date.now();
    const traceId = uuidv4();

    try {
      const body = request.body as unknown;
      const normalised = fromAnthropic(body as Parameters<typeof fromAnthropic>[0]);

      const routeDecision = decideRoute(normalised, config.routing);

      let response;
      let orchestrationTrace;

      if (routeDecision.path === 'planner-executor') {
        const result = await orchestrator.execute(normalised);
        response = result.response;
        orchestrationTrace = result.trace;
      } else {
        if (memoryManager && config.memory.inject_on_direct) {
          injectMemoryIntoMessages(normalised, memoryManager.getDirectInjection());
        }
        const provider = routeDecision.provider === 'executor' ? executorProvider : plannerProvider;
        response = await provider.createChatCompletion(normalised);
      }

      const anthropicResponse = toAnthropicMessages(response, config.gateway.model_alias);

      logger.logRequest({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        surface: 'anthropic',
        route_decision: routeDecision,
        orchestration: orchestrationTrace,
        latency_ms: Date.now() - start,
      });

      // Fire-and-forget memory extraction for direct paths
      if (memoryManager && routeDecision.path === 'direct') {
        const lastUserMsg = [...normalised.messages].reverse().find((m) => m.role === 'user');
        if (lastUserMsg && response.content) {
          memoryManager.extractAndSave({
            userMessage: lastUserMsg.content,
            assistantResponse: response.content,
          }).catch(() => { /* non-fatal */ });
        }
      }

      return reply.send(anthropicResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      logger.logRequest({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        surface: 'anthropic',
        route_decision: { path: 'direct', provider: 'executor', reason: 'error' },
        latency_ms: Date.now() - start,
        error: message,
      });

      const status = message.includes('not reachable') ? 503 : 500;
      return reply.status(status).send({
        type: 'error',
        error: { type: 'api_error', message },
      });
    }
  });
}
