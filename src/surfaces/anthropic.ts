import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'http';
import type { LLMeldConfig } from '../types/config.js';
import type { CloudProvider } from '../providers/base.js';
import type { OrchestrationLoop } from '../orchestrator/loop.js';
import type { TraceLogger } from '../logger/trace.js';
import type { NormalisedLLMResponse } from '../types/normalised.js';
import type { ProgressEvent } from '../types/plan.js';
import type { MemoryCache } from '../cache/memory-cache.js';
import { TOOL_DEFINITIONS } from '../orchestrator/tools.js';
import { runAgenticDirect } from '../orchestrator/agent.js';
import { getOrBuildMemory, compactMessages } from '../orchestrator/memory.js';
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
  memoryCache: MemoryCache;
}

// ---------------------------------------------------------------------------
// Anthropic SSE helpers
// ---------------------------------------------------------------------------

function writeAnthropicSSE(raw: ServerResponse, event: string, data: object): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function mapFinishReason(
  reason: NormalisedLLMResponse['finish_reason'],
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    default: return 'end_turn';
  }
}

/** Stream a complete NormalisedLLMResponse as Anthropic SSE events. */
function streamAnthropicResponse(
  raw: ServerResponse,
  response: NormalisedLLMResponse,
  modelAlias: string,
): void {
  const msgId = response.id || `msg_${uuidv4()}`;
  const stopReason = mapFinishReason(response.finish_reason);

  // 1. message_start
  writeAnthropicSSE(raw, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: modelAlias,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: 1,
      },
    },
  });

  let blockIndex = 0;

  // 2. Text content block
  if (response.content) {
    writeAnthropicSSE(raw, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' },
    });

    // Chunk text into ~80 char pieces for perceived streaming
    const text = response.content;
    const chunkSize = 80;
    for (let i = 0; i < text.length; i += chunkSize) {
      writeAnthropicSSE(raw, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: text.slice(i, i + chunkSize) },
      });
    }

    writeAnthropicSSE(raw, 'content_block_stop', {
      type: 'content_block_stop',
      index: blockIndex,
    });
    blockIndex++;
  }

  // 3. Tool use content blocks
  if (response.tool_calls) {
    for (const tc of response.tool_calls) {
      const toolId = tc.id.replace('call_', 'toolu_');
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch { /* empty */ }

      writeAnthropicSSE(raw, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: toolId, name: tc.function.name, input: {} },
      });

      // Stream the JSON input as partial chunks
      const jsonStr = JSON.stringify(input);
      const chunkSize = 100;
      for (let i = 0; i < jsonStr.length; i += chunkSize) {
        writeAnthropicSSE(raw, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: jsonStr.slice(i, i + chunkSize) },
        });
      }

      writeAnthropicSSE(raw, 'content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
    }
  }

  // If no content at all, send an empty text block
  if (blockIndex === 0) {
    writeAnthropicSSE(raw, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    writeAnthropicSSE(raw, 'content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    });
    blockIndex = 1;
  }

  // 4. message_delta
  writeAnthropicSSE(raw, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: response.usage?.completion_tokens ?? 0 },
  });

  // 5. message_stop
  writeAnthropicSSE(raw, 'message_stop', { type: 'message_stop' });
}

/** Convert a progress event into a human-readable line. */
function formatProgressLine(event: ProgressEvent): string {
  switch (event.stage) {
    case 'planning':
      return `${event.message}\n`;
    case 'plan_ready':
      return `Plan ready: ${event.plan.steps.length} step${event.plan.steps.length === 1 ? '' : 's'}\n\n`;
    case 'step_start':
      return `Step ${event.stepIndex + 1}/${event.totalSteps}: ${event.step.title}\n`;
    case 'step_complete':
      return event.passed
        ? `Complete (${event.tokens} tokens, ${(event.elapsed_ms / 1000).toFixed(1)}s)\n\n`
        : `Failed verification\n`;
    case 'step_retry':
      return `Retrying (attempt ${event.attempt})...\n`;
    case 'step_escalated':
      return `Escalated to cloud fallback\n`;
    case 'tool_call':
      return `Tool: ${event.tool}(${event.args})\n`;
    case 'tool_result':
      return event.truncated ? `Got result (truncated)\n` : '';
    case 'synthesizing':
      return `${event.message}\n\n`;
    case 'done':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Surface registration
// ---------------------------------------------------------------------------

export function registerAnthropicSurface(app: FastifyInstance, deps: AnthropicSurfaceDeps) {
  const { config, plannerProvider, executorProvider, orchestrator, logger, memoryCache } = deps;

  // Log all incoming requests for debugging
  app.addHook('onRequest', async (request) => {
    console.log(`[llmeld] anthropic ← ${request.method} ${request.url}`);
  });

  // Auth hook — accept x-api-key OR Authorization: Bearer
  app.addHook('onRequest', async (request, reply) => {
    const xApiKey = request.headers['x-api-key'];
    const authHeader = request.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    const providedKey = xApiKey || bearerToken;
    if (!providedKey || providedKey !== config.gateway.api_key) {
      return reply.status(401).send({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid API key' },
      });
    }
  });

  // POST /v1/messages
  app.post('/v1/messages', async (request, reply) => {
    const start = Date.now();
    const traceId = uuidv4();

    try {
      const body = request.body as unknown;
      const isStreaming = (body as Record<string, unknown>).stream === true;
      const normalised = fromAnthropic(body as Parameters<typeof fromAnthropic>[0]);

      // Always request non-streaming from providers
      normalised.stream = false;

      // Build working memory from conversation history (with session-level caching)
      const { memory, sessionKey, messageCount } = await getOrBuildMemory(normalised, executorProvider, memoryCache);

      const routeDecision = decideRoute(normalised, config.routing);
      const modelAlias = config.gateway.model_alias;

      // --- Streaming planner-executor path ---
      if (isStreaming && routeDecision.path === 'planner-executor') {
        const raw = reply.raw;
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const msgId = `msg_${uuidv4()}`;

        // Start message
        writeAnthropicSSE(raw, 'message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: modelAlias,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 1 },
          },
        });

        // Open a text block for progress
        writeAnthropicSSE(raw, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });

        const onProgress = (event: ProgressEvent) => {
          const line = formatProgressLine(event);
          if (line) {
            writeAnthropicSSE(raw, 'content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: line },
            });
          }
        };

        const result = await orchestrator.execute(normalised, memory, onProgress);

        // Stream synthesized content into the same text block
        if (result.response.content) {
          const text = result.response.content;
          const chunkSize = 80;
          for (let i = 0; i < text.length; i += chunkSize) {
            writeAnthropicSSE(raw, 'content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: text.slice(i, i + chunkSize) },
            });
          }
        }

        // Close text block
        writeAnthropicSSE(raw, 'content_block_stop', {
          type: 'content_block_stop',
          index: 0,
        });

        // Tool use blocks if any
        if (result.response.tool_calls) {
          let blockIndex = 1;
          for (const tc of result.response.tool_calls) {
            const toolId = tc.id.replace('call_', 'toolu_');
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* empty */ }

            writeAnthropicSSE(raw, 'content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'tool_use', id: toolId, name: tc.function.name, input: {} },
            });

            const jsonStr = JSON.stringify(input);
            writeAnthropicSSE(raw, 'content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: jsonStr },
            });

            writeAnthropicSSE(raw, 'content_block_stop', {
              type: 'content_block_stop',
              index: blockIndex,
            });
            blockIndex++;
          }
        }

        // Finish
        writeAnthropicSSE(raw, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: mapFinishReason(result.response.finish_reason), stop_sequence: null },
          usage: { output_tokens: result.response.usage?.completion_tokens ?? 0 },
        });
        writeAnthropicSSE(raw, 'message_stop', { type: 'message_stop' });
        raw.end();

        logger.logRequest({
          trace_id: traceId,
          timestamp: new Date().toISOString(),
          surface: 'anthropic',
          route_decision: routeDecision,
          orchestration: result.trace,
          latency_ms: Date.now() - start,
        });

        // Write mutated memory back to cache
        memoryCache.update(sessionKey, memory, messageCount);

        return reply;
      }

      // --- Non-streaming or direct path ---
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
        surface: 'anthropic',
        route_decision: routeDecision,
        orchestration: orchestrationTrace,
        latency_ms: Date.now() - start,
      });

      // Write mutated memory back to cache
      memoryCache.update(sessionKey, memory, messageCount);

      if (isStreaming) {
        const raw = reply.raw;
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        streamAnthropicResponse(raw, response, modelAlias);
        raw.end();
        return reply;
      }

      const anthropicResponse = toAnthropicMessages(response, modelAlias);
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
