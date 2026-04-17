import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'http';
import type { LLMeldConfig } from '../types/config.js';
import type { CloudProvider } from '../providers/base.js';
import type { TraceLogger } from '../logger/trace.js';
import type { NormalisedLLMResponse, NormalisedStreamEvent } from '../types/normalised.js';
import type { MemoryCache } from '../cache/memory-cache.js';
import { runAgenticLoop, runAgenticLoopStreaming } from '../orchestrator/agent.js';
import {
  MEMORY_SYSTEM_INSTRUCTION,
  getSessionMemory,
  saveSessionMemory,
  compactMessages,
  stripMemoryBlock,
  stripMemoryFromHistory,
} from '../orchestrator/memory.js';
import { fromAnthropic } from '../normaliser/from-anthropic.js';
import { toAnthropicMessages } from '../normaliser/to-anthropic.js';
import { v4 as uuidv4 } from 'uuid';

export interface AnthropicSurfaceDeps {
  config: LLMeldConfig;
  provider: CloudProvider;
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

// ---------------------------------------------------------------------------
// Surface registration
// ---------------------------------------------------------------------------

export function registerAnthropicSurface(app: FastifyInstance, deps: AnthropicSurfaceDeps) {
  const { config, provider, logger, memoryCache } = deps;
  const agentOpts = {
    maxIterations: config.agent.max_iterations,
    parallelTools: config.agent.parallel_tools,
  };

  // Debug logging
  if (config.gateway.debug_traces) {
    app.addHook('onRequest', async (request) => {
      logger.log('debug', `anthropic <- ${request.method} ${request.url}`);
    });
  }

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
      normalised.stream = false;

      // Strip <memory> blocks from assistant messages in history
      normalised.messages = stripMemoryFromHistory(normalised.messages);

      // Inline memory: check cache for existing memory
      const cached = getSessionMemory(memoryCache, normalised.messages);
      const req = cached ? compactMessages(normalised, cached.memory) : normalised;

      // Append memory system instruction to system prompt
      const systemIdx = req.messages.findIndex(m => m.role === 'system');
      if (systemIdx >= 0) {
        req.messages[systemIdx] = {
          ...req.messages[systemIdx],
          content: req.messages[systemIdx].content + MEMORY_SYSTEM_INSTRUCTION,
        };
      } else {
        req.messages.unshift({ role: 'system', content: MEMORY_SYSTEM_INSTRUCTION.trimStart() });
      }

      req.tools = req.tools ?? [];

      const modelAlias = config.gateway.model_alias;

      if (isStreaming) {
        const raw = reply.raw;
        const msgId = `msg_${uuidv4()}`;

        raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        // message_start
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

        // Open a text block
        let blockIndex = 0;
        writeAnthropicSSE(raw, 'content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' },
        });

        const stream = runAgenticLoopStreaming(provider, req, agentOpts);
        let result;
        const contentChunks: string[] = [];
        let lastFinishReason: NormalisedLLMResponse['finish_reason'] = 'stop';
        let lastUsage: NormalisedStreamEvent['usage'];

        try {
          while (true) {
            const { value, done } = await stream.next();
            if (done) {
              result = value;
              break;
            }

            const event = value as NormalisedStreamEvent;
            switch (event.type) {
              case 'content_delta':
                if (event.content) {
                  contentChunks.push(event.content);
                  writeAnthropicSSE(raw, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: event.content },
                  });
                }
                break;

              case 'tool_call_delta':
                if (event.tool_call) {
                  // Close text block first
                  writeAnthropicSSE(raw, 'content_block_stop', {
                    type: 'content_block_stop',
                    index: blockIndex,
                  });
                  blockIndex++;

                  const tc = event.tool_call;
                  const toolId = (tc.id ?? '').replace('call_', 'toolu_');
                  let input: Record<string, unknown> = {};
                  try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* empty */ }

                  writeAnthropicSSE(raw, 'content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'tool_use', id: toolId, name: tc.function?.name, input: {} },
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

                  // Re-open a new text block for potential further content
                  writeAnthropicSSE(raw, 'content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'text', text: '' },
                  });
                }
                break;

              case 'done':
                lastFinishReason = event.finish_reason ?? 'stop';
                lastUsage = event.usage;
                break;

              case 'error':
                writeAnthropicSSE(raw, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: `\n\n[Error: ${event.error}]` },
                });
                break;
            }
          }
        } catch (streamErr) {
          const msg = streamErr instanceof Error ? streamErr.message : 'Stream error';
          writeAnthropicSSE(raw, 'content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: `\n\n[Error: ${msg}]` },
          });
        }

        // Close last text block
        writeAnthropicSSE(raw, 'content_block_stop', {
          type: 'content_block_stop',
          index: blockIndex,
        });

        // message_delta + message_stop
        writeAnthropicSSE(raw, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: mapFinishReason(lastFinishReason), stop_sequence: null },
          usage: { output_tokens: lastUsage?.completion_tokens ?? 0 },
        });
        writeAnthropicSSE(raw, 'message_stop', { type: 'message_stop' });
        raw.end();

        // Extract and cache memory from accumulated content
        const accumulatedContent = contentChunks.join('');
        if (accumulatedContent) {
          const { memory } = stripMemoryBlock(accumulatedContent);
          if (memory) {
            saveSessionMemory(memoryCache, normalised.messages, memory);
          }
        }

        logger.logRequest({
          trace_id: traceId,
          timestamp: new Date().toISOString(),
          surface: 'anthropic',
          iterations: result?.iterations ?? 0,
          tool_calls: result?.toolCalls ?? [],
          latency_ms: Date.now() - start,
        });

        return reply;
      }

      // Non-streaming path
      const result = await runAgenticLoop(provider, req, agentOpts);

      // Strip memory block from response, cache it
      const { content: strippedContent, memory } = stripMemoryBlock(result.response.content);
      if (memory) {
        saveSessionMemory(memoryCache, normalised.messages, memory);
      }
      result.response.content = strippedContent;

      logger.logRequest({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        surface: 'anthropic',
        iterations: result.iterations,
        tool_calls: result.toolCalls,
        latency_ms: Date.now() - start,
      });

      const anthropicResponse = toAnthropicMessages(result.response, modelAlias);
      return reply.send(anthropicResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      logger.logRequest({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        surface: 'anthropic',
        iterations: 0,
        tool_calls: [],
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
