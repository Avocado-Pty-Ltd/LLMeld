import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'http';
import type { LLMeldConfig } from '../types/config.js';
import type { CloudProvider } from '../providers/base.js';
import type { OrchestrationLoop } from '../orchestrator/loop.js';
import type { TraceLogger } from '../logger/trace.js';
import type { NormalisedLLMRequest, NormalisedLLMResponse } from '../types/normalised.js';
import type { ProgressEvent } from '../types/plan.js';
import type { MemoryCache } from '../cache/memory-cache.js';
import { TOOL_DEFINITIONS } from '../orchestrator/tools.js';
import { runAgenticDirect } from '../orchestrator/agent.js';
import { getOrBuildMemory, compactMessages } from '../orchestrator/memory.js';
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
  memoryCache: MemoryCache;
}

/** Strip progress markers from assistant messages that were sent in previous turns. */
function stripProgressMarkers(content: string): string {
  // Remove everything before the "---" separator that marks the start of actual content
  const separatorIndex = content.indexOf('\n---\n');
  if (separatorIndex !== -1) {
    const afterSeparator = content.slice(separatorIndex + 5).trim();
    if (afterSeparator) return afterSeparator;
  }
  // Also strip individual progress lines if no separator found
  return content
    .replace(/^[⏳📋▸✓✗↻↗].*\n/gm, '')
    .replace(/^\s{2}[⏳📋▸✓✗↻↗].*\n/gm, '')
    .trim();
}

/** Convert a progress event into a human-readable line for the chat. */
function formatProgressLine(event: ProgressEvent): string {
  switch (event.stage) {
    case 'planning':
      return `⏳ ${event.message}\n`;
    case 'plan_ready':
      return `📋 Plan ready: ${event.plan.steps.length} step${event.plan.steps.length === 1 ? '' : 's'} (${event.plan.estimated_complexity} complexity)\n\n`;
    case 'step_start':
      return `▸ Step ${event.stepIndex + 1}/${event.totalSteps}: ${event.step.title}\n`;
    case 'step_complete':
      if (event.passed) {
        return `  ✓ Complete (${event.tokens} tokens, ${(event.elapsed_ms / 1000).toFixed(1)}s)\n\n`;
      }
      return `  ✗ Failed verification\n`;
    case 'step_retry':
      return `  ↻ Retrying (attempt ${event.attempt})...\n`;
    case 'step_escalated':
      return `  ↗ Escalated to cloud fallback\n`;
    case 'tool_call':
      return `  🔧 ${event.tool}(${event.args})\n`;
    case 'tool_result':
      return event.truncated ? `  📄 Got result (truncated)\n` : '';
    case 'synthesizing':
      return `⏳ ${event.message}\n\n---\n\n`;
    case 'done':
      return '';
  }
}

/** Write a single SSE content delta chunk to a raw HTTP response. */
function writeSSEChunk(raw: ServerResponse, id: string, model: string, content: string): void {
  const chunk = `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content },
        finish_reason: null,
      },
    ],
  })}\n\n`;
  raw.write(chunk);
}

/** Write the SSE finish chunk and [DONE] marker. */
function writeSSEFinish(raw: ServerResponse, id: string, model: string, usage?: NormalisedLLMResponse['usage']): void {
  const finishChunk = `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
          },
        }
      : {}),
  })}\n\n`;
  raw.write(finishChunk);
  raw.write('data: [DONE]\n\n');
}

/** Build a complete SSE payload string from a finished response (used for direct/non-orchestrated paths). */
function toSSEStream(response: NormalisedLLMResponse, modelAlias: string): string {
  const id = response.id || `chatcmpl-${uuidv4()}`;
  const chunks: string[] = [];

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
  const { config, plannerProvider, executorProvider, orchestrator, logger, memoryCache } = deps;

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

      // Strip progress markers from prior assistant messages so they don't
      // inflate token counts or confuse the planner/executor
      for (const msg of normalised.messages) {
        if (msg.role === 'assistant' && msg.content) {
          msg.content = stripProgressMarkers(msg.content);
        }
      }

      // Always request non-streaming from providers (we simulate SSE from the result)
      normalised.stream = false;

      // Build working memory from conversation history (with session-level caching)
      const { memory, sessionKey, messageCount } = await getOrBuildMemory(normalised, executorProvider, memoryCache);

      const routeDecision = decideRoute(normalised, config.routing);

      // Streaming planner-executor path: stream progress + final content incrementally
      if (isStreaming && routeDecision.path === 'planner-executor') {
        const raw = reply.raw;
        const sseId = `chatcmpl-${uuidv4()}`;
        const modelAlias = config.gateway.model_alias;

        raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const onProgress = (event: ProgressEvent) => {
          const line = formatProgressLine(event);
          if (line) {
            writeSSEChunk(raw, sseId, modelAlias, line);
          }
        };

        const result = await orchestrator.execute(normalised, memory, onProgress);

        // Send the synthesized content
        if (result.response.content) {
          writeSSEChunk(raw, sseId, modelAlias, result.response.content);
        }

        // Send tool calls if present
        if (result.response.tool_calls) {
          for (const tc of result.response.tool_calls) {
            const toolChunk = `data: ${JSON.stringify({
              id: sseId,
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
            })}\n\n`;
            raw.write(toolChunk);
          }
        }

        writeSSEFinish(raw, sseId, modelAlias, result.response.usage);
        raw.end();

        logger.logRequest({
          trace_id: traceId,
          timestamp: new Date().toISOString(),
          surface: 'openai',
          route_decision: routeDecision,
          orchestration: result.trace,
          latency_ms: Date.now() - start,
        });

        // Write mutated memory back to cache
        memoryCache.update(sessionKey, memory, messageCount);

        return reply;
      }

      // Non-streaming or direct path
      let response;
      let orchestrationTrace;

      if (routeDecision.path === 'planner-executor') {
        const result = await orchestrator.execute(normalised, memory);
        response = result.response;
        orchestrationTrace = result.trace;
      } else if (routeDecision.provider === 'executor') {
        // Direct executor path — compact messages with working memory
        const compacted = compactMessages(normalised, memory);
        compacted.tools = TOOL_DEFINITIONS;
        compacted.tool_choice = 'auto';
        response = await runAgenticDirect(executorProvider, compacted);
      } else {
        // Direct cloud path — compact messages with working memory
        const compacted = compactMessages(normalised, memory);
        response = await plannerProvider.createChatCompletion(compacted);
      }

      logger.logRequest({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        surface: 'openai',
        route_decision: routeDecision,
        orchestration: orchestrationTrace,
        latency_ms: Date.now() - start,
      });

      // Write mutated memory back to cache
      memoryCache.update(sessionKey, memory, messageCount);

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

      // If SSE headers were already sent (streaming planner-executor path),
      // we cannot send a new HTTP response — close the stream gracefully instead.
      if (reply.raw.headersSent) {
        const errorChunk = `data: ${JSON.stringify({
          id: `chatcmpl-error`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: config.gateway.model_alias,
          choices: [{ index: 0, delta: { content: `\n\n[Error: ${message}]` }, finish_reason: null }],
        })}\n\ndata: [DONE]\n\n`;
        reply.raw.write(errorChunk);
        reply.raw.end();
        return reply;
      }

      const status = message.includes('not reachable') ? 503 : 500;
      return reply.status(status).send({
        error: { message, type: 'server_error' },
      });
    }
  });
}
