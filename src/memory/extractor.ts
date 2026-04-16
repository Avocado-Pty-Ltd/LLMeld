import type { CloudProvider } from '../providers/base.js';
import type { NormalisedLLMRequest } from '../types/normalised.js';
import type { OrchestrationTrace } from '../orchestrator/loop.js';
import type { MemoryEntry } from './types.js';
import { getDefaultTTL } from './types.js';

export interface ExtractionInput {
  userMessage: string;
  assistantResponse: string;
  trace?: OrchestrationTrace;
}

const EXTRACTION_PROMPT = `You are a memory extraction system for LLMeld, an AI orchestration platform.
Analyze the conversation exchange and optionally the orchestration trace to extract noteworthy facts.

## Categories to extract

1. **Project Knowledge** — architecture, conventions, file structure, important paths
2. **Shared Vocabulary** — terms, naming patterns, disambiguation between concepts
3. **Orchestration Hints** — patterns about how the planner should write instructions for the executor
4. **Execution Learnings** — step failures, timeouts, escalations, what worked/didn't
5. **Conversation Memory** — completed tasks, decisions made, user preferences

## Rules
- Extract 0 entries if nothing noteworthy was said. Most conversations produce 0-2 entries.
- Be concise. Title should be descriptive (5-10 words). Body should be 1-3 lines.
- For orchestration hints and execution learnings, you MUST have evidence from the trace data.
- Assign confidence: "high" if clearly stated/proven, "medium" if inferred, "low" if uncertain.
- Do NOT extract trivial facts like "user asked a question" or "assistant responded".

## Output format
Return a JSON array of entries. Return an empty array [] if nothing is noteworthy.

\`\`\`json
[
  {
    "type": "project" | "vocabulary" | "orchestration" | "learning" | "conversation",
    "title": "short descriptive title",
    "body": "1-3 line description",
    "confidence": "high" | "medium" | "low"
  }
]
\`\`\``;

function formatTraceForExtraction(trace: OrchestrationTrace): string {
  if (!trace.plan) return '';

  const parts = [
    `Goal: ${trace.plan.goal}`,
    `Complexity: ${trace.plan.estimated_complexity}`,
    `Steps: ${trace.step_results.length}`,
  ];

  for (const sr of trace.step_results) {
    const step = trace.plan.steps.find((s) => s.id === sr.step_id);
    const title = step?.title ?? sr.step_id;
    const status = sr.passed ? 'PASSED' : 'FAILED';
    const escalated = sr.escalated ? ' (escalated to fallback)' : '';
    const attempts = sr.attempt > 1 ? ` (${sr.attempt} attempts)` : '';
    parts.push(`- ${title}: ${status}${escalated}${attempts}, ${sr.tokens_used} tokens`);
  }

  if (trace.error) {
    parts.push(`Error: ${trace.error}`);
  }

  return parts.join('\n');
}

/**
 * Extract memory entries from a conversation exchange using an LLM.
 */
export async function extractMemoryEntries(
  provider: CloudProvider,
  input: ExtractionInput,
): Promise<MemoryEntry[]> {
  let userContent = `## Conversation\n**User:** ${input.userMessage.slice(0, 2000)}\n\n**Assistant:** ${input.assistantResponse.slice(0, 2000)}`;

  if (input.trace) {
    const traceSummary = formatTraceForExtraction(input.trace);
    if (traceSummary) {
      userContent += `\n\n## Orchestration Trace\n${traceSummary}`;
    }
  }

  const req: NormalisedLLMRequest = {
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: userContent },
    ],
    model: '',
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };

  const response = await provider.createChatCompletion(req);
  return parseExtractionResponse(response.content);
}

function parseExtractionResponse(content: string): MemoryEntry[] {
  const now = new Date().toISOString().split('T')[0];

  let jsonStr = content.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to find an array in the response
    const arrStart = content.indexOf('[');
    const arrEnd = content.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
      try {
        parsed = JSON.parse(content.slice(arrStart, arrEnd + 1));
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null &&
      typeof item.type === 'string' &&
      typeof item.title === 'string' &&
      typeof item.body === 'string',
    )
    .map((item) => {
      const type = item.type as MemoryEntry['type'];
      const confidence = (['high', 'medium', 'low'].includes(item.confidence as string)
        ? item.confidence
        : 'medium') as MemoryEntry['confidence'];

      return {
        type,
        title: item.title as string,
        body: item.body as string,
        date: now,
        confidence,
        source: 'auto' as const,
        ttl: getDefaultTTL(type, confidence),
      };
    });
}
