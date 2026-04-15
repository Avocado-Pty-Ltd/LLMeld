import type { FastifyInstance } from 'fastify';
import type { LLMeldConfig } from '../types/config.js';
import type { CloudProvider } from '../providers/base.js';
import type { OrchestrationLoop } from '../orchestrator/loop.js';
import type { TraceLogger } from '../logger/trace.js';
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
}

export function registerAnthropicSurface(app: FastifyInstance, deps: AnthropicSurfaceDeps) {
  const { config, plannerProvider, executorProvider, orchestrator, logger } = deps;

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
