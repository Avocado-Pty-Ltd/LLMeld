import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'http';
import type { LLMeldConfig } from '../types/config.js';
import type { CloudProvider } from '../providers/base.js';
import type { TraceLogger } from '../logger/trace.js';
import type { NormalisedLLMResponse, NormalisedStreamEvent } from '../types/normalised.js';
import type { MemoryCache } from '../cache/memory-cache.js';
import { TOOL_DEFINITIONS } from '../orchestrator/tools.js';
import { runAgenticLoop, runAgenticLoopStreaming } from '../orchestrator/agent.js';
import {
  MEMORY_SYSTEM_INSTRUCTION,
  getSessionMemory,
  saveSessionMemory,
  compactMessages,
  stripMemoryBlock,
  stripMemoryFromHistory,
} from '../orchestrator/memory.js';
import { fromOpenAI } from '../normaliser/from-openai.js';
import { toOpenAIChatCompletion, toOpenAIModelList } from '../normaliser/to-openai.js';
import { v4 as uuidv4 } from 'uuid';

export interface OpenAISurfaceDeps {
  config: LLMeldConfig;
  provider: CloudProvider;
  logger: TraceLogger;
  memoryCache: MemoryCache;
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

/** Write tool call SSE chunks. */
function writeSSEToolCalls(raw: ServerResponse, id: string, model: string, event: NormalisedStreamEvent): void {
  if (event.type !== 'tool_call_delta' || !event.tool_call) return;
  const tc = event.tool_call;
  const chunk = `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: tc.id,
              type: 'function',
              function: { name: tc.function?.name, arguments: tc.function?.arguments },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  })}\n\n`;
  raw.write(chunk);
}

/** Write the SSE finish chunk and [DONE] marker. */
function writeSSEFinish(raw: ServerResponse, id: string, model: string, event: NormalisedStreamEvent): void {
  const finishChunk = `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: event.finish_reason ?? 'stop',
      },
    ],
    ...(event.usage
      ? {
          usage: {
            prompt_tokens: event.usage.prompt_tokens,
            completion_tokens: event.usage.completion_tokens,
            total_tokens: event.usage.total_tokens,
          },
        }
      : {}),
  })}\n\n`;
  raw.write(finishChunk);
  raw.write('data: [DONE]\n\n');
}

export function registerOpenAISurface(app: FastifyInstance, deps: OpenAISurfaceDeps) {
  const { config, provider, logger, memoryCache } = deps;
  const agentOpts = {
    maxIterations: config.agent.max_iterations,
    parallelTools: config.agent.parallel_tools,
  };

  // Auth hook
  app.addHook('onRequest', async (request, reply) => {
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

      // Inject LLMeld tools (merged with any client tools in the agentic loop)
      req.tools = req.tools ?? [];

      if (isStreaming) {
        const raw = reply.raw;
        const sseId = `chatcmpl-${uuidv4()}`;
        const modelAlias = config.gateway.model_alias;

        raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const stream = runAgenticLoopStreaming(provider, req, agentOpts);
        let result;
        let accumulatedContent = '';

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
                  accumulatedContent += event.content;
                  writeSSEChunk(raw, sseId, modelAlias, event.content);
                }
                break;
              case 'tool_call_delta':
                writeSSEToolCalls(raw, sseId, modelAlias, event);
                break;
              case 'done':
                writeSSEFinish(raw, sseId, modelAlias, event);
                break;
              case 'error':
                writeSSEChunk(raw, sseId, modelAlias, `\n\n[Error: ${event.error}]`);
                raw.write('data: [DONE]\n\n');
                break;
            }
          }
        } catch (streamErr) {
          const msg = streamErr instanceof Error ? streamErr.message : 'Stream error';
          writeSSEChunk(raw, sseId, modelAlias, `\n\n[Error: ${msg}]`);
          raw.write('data: [DONE]\n\n');
        }

        raw.end();

        // Extract and cache memory from accumulated content
        if (accumulatedContent) {
          const { memory } = stripMemoryBlock(accumulatedContent);
          if (memory) {
            saveSessionMemory(memoryCache, normalised.messages, memory);
          }
        }

        logger.logRequest({
          trace_id: traceId,
          timestamp: new Date().toISOString(),
          surface: 'openai',
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
        surface: 'openai',
        iterations: result.iterations,
        tool_calls: result.toolCalls,
        latency_ms: Date.now() - start,
      });

      const openaiResponse = toOpenAIChatCompletion(result.response, config.gateway.model_alias);
      return reply.send(openaiResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      logger.logRequest({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        surface: 'openai',
        iterations: 0,
        tool_calls: [],
        latency_ms: Date.now() - start,
        error: message,
      });

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
