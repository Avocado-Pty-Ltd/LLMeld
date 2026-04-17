import type { CloudProvider } from '../providers/base.js';
import type {
  NormalisedLLMRequest,
  NormalisedLLMResponse,
  NormalisedStreamEvent,
  NormalisedToolCall,
  NormalisedMessage,
} from '../types/normalised.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

/** Names of tools that LLMeld executes locally. */
const LLMELD_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));

export interface AgenticLoopOptions {
  maxIterations: number;
  parallelTools: boolean;
}

export interface AgenticLoopResult {
  response: NormalisedLLMResponse;
  iterations: number;
  toolCalls: Array<{ name: string; truncated: boolean }>;
}

/**
 * Non-streaming agentic loop: call provider with tools, execute tool calls,
 * loop until model stops or max iterations reached.
 */
export async function runAgenticLoop(
  provider: CloudProvider,
  req: NormalisedLLMRequest,
  opts: AgenticLoopOptions,
): Promise<AgenticLoopResult> {
  const messages = [...req.messages];
  const toolLog: AgenticLoopResult['toolCalls'] = [];
  let iterations = 0;

  // Merge LLMeld tools with any client-provided tools
  const allTools = [...TOOL_DEFINITIONS, ...(req.tools ?? [])];

  for (let i = 0; i < opts.maxIterations; i++) {
    iterations++;
    const response = await provider.createChatCompletion({
      ...req,
      messages: [...messages],
      tools: allTools.length > 0 ? allTools : undefined,
      tool_choice: allTools.length > 0 ? 'auto' : undefined,
    });

    if (response.finish_reason !== 'tool_calls' || !response.tool_calls?.length) {
      return { response, iterations, toolCalls: toolLog };
    }

    // Separate LLMeld tools from client tools
    const llmeldCalls: NormalisedToolCall[] = [];
    const clientCalls: NormalisedToolCall[] = [];

    for (const tc of response.tool_calls) {
      if (LLMELD_TOOL_NAMES.has(tc.function.name)) {
        llmeldCalls.push(tc);
      } else {
        clientCalls.push(tc);
      }
    }

    // If there are client tool calls and no LLMeld calls, pass back to client
    if (clientCalls.length > 0 && llmeldCalls.length === 0) {
      return { response, iterations, toolCalls: toolLog };
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.tool_calls,
    });

    // Execute LLMeld tools (in parallel if enabled)
    const executeOne = async (tc: NormalisedToolCall): Promise<NormalisedMessage> => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      const result = await executeTool(tc.function.name, args);
      toolLog.push({ name: tc.function.name, truncated: result.truncated });
      return {
        role: 'tool',
        content: result.output,
        tool_call_id: tc.id,
      };
    };

    let toolResults: NormalisedMessage[];
    if (opts.parallelTools && llmeldCalls.length > 1) {
      toolResults = await Promise.all(llmeldCalls.map(executeOne));
    } else {
      toolResults = [];
      for (const tc of llmeldCalls) {
        toolResults.push(await executeOne(tc));
      }
    }

    messages.push(...toolResults);

    // If there were also client calls, add placeholder results and return
    // so the client can handle them
    if (clientCalls.length > 0) {
      // Return a partial response — the model needs client tool results to continue
      const partialResponse: NormalisedLLMResponse = {
        ...response,
        // Keep only client tool calls in the response
        tool_calls: clientCalls,
        finish_reason: 'tool_calls',
      };
      return { response: partialResponse, iterations, toolCalls: toolLog };
    }
  }

  // Max iterations reached — strip tools and ask for final answer
  const finalResponse = await provider.createChatCompletion({
    ...req,
    messages,
    tools: undefined,
    tool_choice: undefined,
  });
  iterations++;

  return { response: finalResponse, iterations, toolCalls: toolLog };
}

/**
 * Streaming agentic loop: non-streaming for intermediate tool iterations,
 * native streaming for the final text response.
 */
export async function* runAgenticLoopStreaming(
  provider: CloudProvider,
  req: NormalisedLLMRequest,
  opts: AgenticLoopOptions,
): AsyncGenerator<NormalisedStreamEvent, AgenticLoopResult> {
  const messages = [...req.messages];
  const toolLog: AgenticLoopResult['toolCalls'] = [];
  let iterations = 0;

  // Merge LLMeld tools with any client-provided tools
  const allTools = [...TOOL_DEFINITIONS, ...(req.tools ?? [])];

  for (let i = 0; i < opts.maxIterations; i++) {
    iterations++;

    // On the last allowed iteration or when we detect this might be final,
    // use streaming if available
    const isLastIteration = i === opts.maxIterations - 1;

    // Try non-streaming first for tool iterations
    const response = await provider.createChatCompletion({
      ...req,
      messages: [...messages],
      tools: allTools.length > 0 ? allTools : undefined,
      tool_choice: allTools.length > 0 ? 'auto' : undefined,
    });

    if (response.finish_reason !== 'tool_calls' || !response.tool_calls?.length) {
      // Final response — re-do with streaming if provider supports it
      if (provider.createStreamingCompletion) {
        // Re-request with streaming for the final response
        const stream = provider.createStreamingCompletion({
          ...req,
          messages: [...messages],
          tools: allTools.length > 0 ? allTools : undefined,
          tool_choice: allTools.length > 0 ? 'auto' : undefined,
        });

        let finalContent = '';
        let finalUsage = response.usage;
        let finalFinishReason = response.finish_reason;

        for await (const event of stream) {
          if (event.type === 'content_delta') {
            finalContent += event.content ?? '';
          }
          if (event.type === 'done') {
            finalFinishReason = event.finish_reason ?? finalFinishReason;
            if (event.usage) finalUsage = event.usage;
          }
          yield event;
        }

        const finalResponse: NormalisedLLMResponse = {
          ...response,
          content: finalContent || response.content,
          finish_reason: finalFinishReason,
          usage: finalUsage,
        };
        return { response: finalResponse, iterations, toolCalls: toolLog };
      }

      // No streaming support — yield content as a single chunk
      if (response.content) {
        yield { type: 'content_delta', content: response.content };
      }
      yield {
        type: 'done',
        finish_reason: response.finish_reason,
        usage: response.usage,
      };
      return { response, iterations, toolCalls: toolLog };
    }

    // Separate LLMeld tools from client tools
    const llmeldCalls: NormalisedToolCall[] = [];
    const clientCalls: NormalisedToolCall[] = [];

    for (const tc of response.tool_calls) {
      if (LLMELD_TOOL_NAMES.has(tc.function.name)) {
        llmeldCalls.push(tc);
      } else {
        clientCalls.push(tc);
      }
    }

    // If there are only client tool calls, pass back to client
    if (clientCalls.length > 0 && llmeldCalls.length === 0) {
      // Yield tool_call deltas for client tools
      for (const tc of clientCalls) {
        yield { type: 'tool_call_delta', tool_call: tc };
      }
      yield { type: 'done', finish_reason: 'tool_calls' };
      return { response, iterations, toolCalls: toolLog };
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.tool_calls,
    });

    // Execute LLMeld tools
    const executeOne = async (tc: NormalisedToolCall): Promise<NormalisedMessage> => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      const result = await executeTool(tc.function.name, args);
      toolLog.push({ name: tc.function.name, truncated: result.truncated });
      return {
        role: 'tool',
        content: result.output,
        tool_call_id: tc.id,
      };
    };

    let toolResults: NormalisedMessage[];
    if (opts.parallelTools && llmeldCalls.length > 1) {
      toolResults = await Promise.all(llmeldCalls.map(executeOne));
    } else {
      toolResults = [];
      for (const tc of llmeldCalls) {
        toolResults.push(await executeOne(tc));
      }
    }

    messages.push(...toolResults);

    // If there were also client calls, return partial response
    if (clientCalls.length > 0) {
      for (const tc of clientCalls) {
        yield { type: 'tool_call_delta', tool_call: tc };
      }
      yield { type: 'done', finish_reason: 'tool_calls' };
      const partialResponse: NormalisedLLMResponse = {
        ...response,
        tool_calls: clientCalls,
        finish_reason: 'tool_calls',
      };
      return { response: partialResponse, iterations, toolCalls: toolLog };
    }
  }

  // Max iterations — strip tools and get final answer with streaming
  iterations++;
  if (provider.createStreamingCompletion) {
    const stream = provider.createStreamingCompletion({
      ...req,
      messages,
      tools: undefined,
      tool_choice: undefined,
    });

    let finalContent = '';
    let finalUsage: NormalisedLLMResponse['usage'];
    let finalFinishReason: NormalisedLLMResponse['finish_reason'] = 'stop';

    for await (const event of stream) {
      if (event.type === 'content_delta') {
        finalContent += event.content ?? '';
      }
      if (event.type === 'done') {
        finalFinishReason = event.finish_reason ?? finalFinishReason;
        if (event.usage) finalUsage = event.usage;
      }
      yield event;
    }

    const finalResponse: NormalisedLLMResponse = {
      id: `resp-${Date.now()}`,
      model: req.model,
      content: finalContent,
      role: 'assistant',
      finish_reason: finalFinishReason,
      usage: finalUsage,
    };
    return { response: finalResponse, iterations, toolCalls: toolLog };
  }

  // No streaming — fallback
  const finalResponse = await provider.createChatCompletion({
    ...req,
    messages,
    tools: undefined,
    tool_choice: undefined,
  });

  if (finalResponse.content) {
    yield { type: 'content_delta', content: finalResponse.content };
  }
  yield { type: 'done', finish_reason: finalResponse.finish_reason, usage: finalResponse.usage };
  return { response: finalResponse, iterations, toolCalls: toolLog };
}
