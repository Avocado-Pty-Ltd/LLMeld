import type { CloudProvider } from '../providers/base.js';
import type { NormalisedLLMRequest, NormalisedLLMResponse } from '../types/normalised.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

/** Run a direct request through a provider with an agentic tool-calling loop. */
export async function runAgenticDirect(
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
