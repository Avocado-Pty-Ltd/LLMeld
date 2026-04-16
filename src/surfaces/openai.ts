import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'http';
import type { LLMeldConfig } from '../types/config.js';
import type { CloudProvider } from '../providers/base.js';
import type { OrchestrationLoop } from '../orchestrator/loop.js';
import type { TraceLogger } from '../logger/trace.js';
import type { MemoryManager } from '../memory/manager.js';
import type { NormalisedLLMRequest, NormalisedLLMResponse } from '../types/normalised.js';
import type { ProgressEvent } from '../types/plan.js';
import { TOOL_DEFINITIONS, executeTool } from '../orchestrator/tools.js';
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

/** Run a direct request through the executor with an agentic tool-calling loop. */
async function runAgenticDirect(
  provider: CloudProvider,
  req: NormalisedLLMRequest,
): Promise<NormalisedLLMResponse> {
  const MAX_ITERATIONS = 10;
  const messages = [...req.messages];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await provider.createChatCompletion({
      ...req,
      messages: [...messages],
    });

    if (response.finish_reason !== 'tool_calls' || !response.tool_calls?.length) {
      return response;
    }

    // Model wants tools — execute and loop
    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.tool_calls,
    });

    for (const tc of response.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      const result = await executeTool(tc.function.name, args);
      messages.push({
        role: 'tool',
        content: result.output,
        tool_call_id: tc.id,
      });
    }
  }

  // Fallback: return last response content
  return provider.createChatCompletion({ ...req, messages, tools: undefined, tool_choice: undefined });
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
  const { config, plannerProvider, executorProvider, orchestrator, logger, memoryManager } = deps;

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

        try {
          const onProgress = (event: ProgressEvent) => {
            const line = formatProgressLine(event);
            if (line && !raw.writableEnded) {
              writeSSEChunk(raw, sseId, modelAlias, line);
            }
          };

          const result = await orchestrator.execute(normalised, onProgress);

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

          logger.logRequest({
            trace_id: traceId,
            timestamp: new Date().toISOString(),
            surface: 'openai',
            route_decision: routeDecision,
            orchestration: result.trace,
            latency_ms: Date.now() - start,
          });
        } catch (streamErr) {
          // Headers already sent — stream the error as an SSE event and close
          const errMsg = streamErr instanceof Error ? streamErr.message : 'Internal server error';
          if (!raw.writableEnded) {
            writeSSEChunk(raw, sseId, modelAlias, `\n\n[Error: ${errMsg}]`);
            writeSSEFinish(raw, sseId, modelAlias);
          }

          logger.logRequest({
            trace_id: traceId,
            timestamp: new Date().toISOString(),
            surface: 'openai',
            route_decision: routeDecision,
            latency_ms: Date.now() - start,
            error: errMsg,
          });
        }

        if (!raw.writableEnded) raw.end();
        return reply;
      }

      // Non-streaming or direct path
      let response;
      let orchestrationTrace;

      if (routeDecision.path === 'planner-executor') {
        const result = await orchestrator.execute(normalised);
        response = result.response;
        orchestrationTrace = result.trace;
      } else if (routeDecision.provider === 'executor') {
        // Direct executor path — agentic loop with tool support
        if (memoryManager && config.memory.inject_on_direct) {
          injectMemoryIntoMessages(normalised, memoryManager.getDirectInjection());
        }
        normalised.tools = TOOL_DEFINITIONS;
        normalised.tool_choice = 'auto';
        response = await runAgenticDirect(executorProvider, normalised);
      } else {
        if (memoryManager && config.memory.inject_on_direct) {
          injectMemoryIntoMessages(normalised, memoryManager.getDirectInjection());
        }
        const provider = plannerProvider;
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
