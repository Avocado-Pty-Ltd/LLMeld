import type { FastifyInstance } from 'fastify';
import type { LLMeldConfig } from '../types/config.js';
import type { CloudProvider } from '../providers/base.js';
import type { OrchestrationLoop } from '../orchestrator/loop.js';
import type { TraceLogger } from '../logger/trace.js';
import type { NormalisedLLMResponse } from '../types/normalised.js';
import { fromOpenAI } from '../normaliser/from-openai.js';
import { toOpenAIChatCompletion, toOpenAIModelList } from '../normaliser/to-openai.js';
import { decideRoute } from '../router/policy.js';
import { v4 as uuidv4 } from 'uuid';

export interface OpenAISurfaceDeps {
  config: LLMeldConfig;
  plannerProvider: CloudProvider;
  executorProvider: CloudProvider;
  fallbackProvider?: CloudProvider;
  orchestrator: OrchestrationLoop;
  logger: TraceLogger;
}

function toSSEStream(response: NormalisedLLMResponse, modelAlias: string): string {
  const id = response.id || `chatcmpl-${uuidv4()}`;
  const chunks: string[] = [];

  // Send content as a single chunk (simulate streaming for non-streaming providers)
  if (response.content) {
    chunks.push(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelAlias,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: response.content },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
  }

  // Send tool calls if present
  if (response.tool_calls) {
    for (const tc of response.tool_calls) {
      chunks.push(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelAlias,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    }
  }

  // Send finish chunk
  chunks.push(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelAlias,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: response.finish_reason ?? 'stop',
        },
      ],
      ...(response.usage
        ? {
            usage: {
              prompt_tokens: response.usage.prompt_tokens,
              completion_tokens: response.usage.completion_tokens,
              total_tokens: response.usage.total_tokens,
            },
          }
        : {}),
    })}\n\n`,
  );

  chunks.push('data: [DONE]\n\n');

  return chunks.join('');
}

export function registerOpenAISurface(app: FastifyInstance, deps: OpenAISurfaceDeps) {
  const { config, plannerProvider, executorProvider, orchestrator, logger } = deps;

  // Auth hook
  app.addHook('onRequest', async (request, reply) => {
    // Skip auth for models endpoint
    if (request.url === '/v1/models' && request.method === 'GET') return;

    const authHeader = request.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${config.gateway.api_key}`) {
      return reply.status(401).send({ error: { message: 'Invalid API key', type: 'auth_error' } });
    }
  });

  // GET /v1/models
  app.get('/v1/models', async (_request, reply) => {
    return reply.send(toOpenAIModelList([config.gateway.model_alias]));
  });

  // POST /v1/chat/completions
  app.post('/v1/chat/completions', async (request, reply) => {
    const start = Date.now();
    const traceId = uuidv4();

    try {
      const body = request.body as unknown;
      const normalised = fromOpenAI(body as Parameters<typeof fromOpenAI>[0]);
      const isStreaming = normalised.stream === true;

      // Always request non-streaming from providers (we simulate SSE from the result)
      normalised.stream = false;

      const routeDecision = decideRoute(normalised, config.routing);

      let response;
      let orchestrationTrace;

      if (routeDecision.path === 'planner-executor') {
        const result = await orchestrator.execute(normalised);
        response = result.response;
        orchestrationTrace = result.trace;
      } else {
        // Direct path
        const provider = routeDecision.provider === 'executor' ? executorProvider : plannerProvider;
        response = await provider.createChatCompletion(normalised);
      }

      logger.logRequest({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        surface: 'openai',
        route_decision: routeDecision,
        orchestration: orchestrationTrace,
        latency_ms: Date.now() - start,
      });

      if (isStreaming) {
        const ssePayload = toSSEStream(response, config.gateway.model_alias);
        return reply
          .header('Content-Type', 'text/event-stream')
          .header('Cache-Control', 'no-cache')
          .header('Connection', 'keep-alive')
          .send(ssePayload);
      }

      const openaiResponse = toOpenAIChatCompletion(response, config.gateway.model_alias);
      return reply.send(openaiResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      logger.logRequest({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        surface: 'openai',
        route_decision: { path: 'direct', provider: 'executor', reason: 'error' },
        latency_ms: Date.now() - start,
        error: message,
      });

      const status = message.includes('not reachable') ? 503 : 500;
      return reply.status(status).send({
        error: { message, type: 'server_error' },
      });
    }
  });
}
