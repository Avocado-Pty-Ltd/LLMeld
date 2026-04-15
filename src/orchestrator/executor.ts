import type { CloudProvider } from '../providers/base.js';
import type { NormalisedLLMRequest, NormalisedMessage } from '../types/normalised.js';
import type { PlanStep, StepResult, ProgressEvent } from '../types/plan.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';

const MAX_TOOL_ITERATIONS = 10;

const EXECUTOR_SYSTEM_PROMPT = `You are completing one step of a larger software engineering task.

## Available tools
You have access to these tools:
- shell_exec: Run shell commands (git, gh, npm, curl, ls, grep, cat, etc.)
- read_file: Read a file's contents by path
- write_file: Write/create files with content

Use tools when the task requires interacting with the filesystem, running commands, or reading/writing files. For pure text generation tasks (writing code, explanations, analysis), respond directly without tools.

## Requirements
- Produce ONLY the requested output. Do not explain your reasoning unless the instruction asks for an explanation.
- If you need to write code, write complete, working code — not pseudocode or partial snippets.
- If you are unsure about something, state your uncertainty clearly.
- Follow the instruction precisely. Do not add extra features or improvements beyond what is asked.

After your main output, on a new line, rate your confidence as one of: CONFIDENCE:high, CONFIDENCE:medium, CONFIDENCE:low`;

export class Executor {
  constructor(private provider: CloudProvider) {}

  async execute(
    step: PlanStep,
    contextForExecutor: string,
    previousResults?: Array<{ stepId: string; output: string }>,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<StepResult> {
    const emit = onProgress ?? (() => {});

    let instruction = step.instruction;

    // Inject previous step outputs if this step depends on them
    if (previousResults && step.depends_on.length > 0) {
      const relevantResults = previousResults.filter((r) =>
        step.depends_on.includes(r.stepId),
      );
      if (relevantResults.length > 0) {
        const prevContext = relevantResults
          .map((r) => `[Output from ${r.stepId}]:\n${r.output}`)
          .join('\n\n');
        instruction = `## Previous step outputs\n${prevContext}\n\n## Your task\n${instruction}`;
      }
    }

    const prompt = `## Background context
${contextForExecutor}

## Your step
**Title:** ${step.title}
**Instruction:** ${instruction}

## Expected output
${step.expected_output}`;

    const messages: NormalisedMessage[] = [
      { role: 'system', content: EXECUTOR_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ];

    let totalTokens = 0;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const req: NormalisedLLMRequest = {
        messages: [...messages],
        model: '',
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
      };

      const response = await this.provider.createChatCompletion(req);
      totalTokens += response.usage?.total_tokens ?? 0;

      // If model returned text with no tool calls, we're done
      if (response.finish_reason !== 'tool_calls' || !response.tool_calls?.length) {
        return this.parseResult(step.id, response.content, totalTokens);
      }

      // Model wants to call tools — add assistant message with tool_calls
      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls,
      });

      // Execute each tool call and add results
      for (const tc of response.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        const argsPreview = tc.function.name === 'shell_exec'
          ? String(args.command ?? '').slice(0, 80)
          : tc.function.name === 'read_file'
            ? String(args.path ?? '')
            : String(args.path ?? '');

        emit({
          stage: 'tool_call',
          stepId: step.id,
          tool: tc.function.name,
          args: argsPreview,
        });

        const result = await executeTool(tc.function.name, args);

        emit({
          stage: 'tool_result',
          stepId: step.id,
          tool: tc.function.name,
          truncated: result.truncated,
        });

        messages.push({
          role: 'tool',
          content: result.output,
          tool_call_id: tc.id,
        });
      }
    }

    // Hit max iterations — collect whatever output we have
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    return this.parseResult(
      step.id,
      lastAssistant?.content || '[Max tool iterations reached without final response]',
      totalTokens,
    );
  }

  private parseResult(stepId: string, content: string, tokensUsed: number): StepResult {
    let confidence: StepResult['confidence'] = 'medium';
    let output = content;

    const confidenceMatch = content.match(/CONFIDENCE:(high|medium|low)\s*$/i);
    if (confidenceMatch) {
      confidence = confidenceMatch[1].toLowerCase() as StepResult['confidence'];
      output = content.slice(0, confidenceMatch.index).trimEnd();
    }

    const issues: string[] = [];
    if (!output || output.trim().length < 10) {
      issues.push('Output is very short or empty');
    }

    return {
      step_id: stepId,
      output,
      confidence,
      issues,
      tokens_used: tokensUsed,
    };
  }
}
