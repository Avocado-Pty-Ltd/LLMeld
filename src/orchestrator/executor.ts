import type { CloudProvider } from '../providers/base.js';
import type { NormalisedLLMRequest } from '../types/normalised.js';
import type { PlanStep, StepResult } from '../types/plan.js';

const EXECUTOR_SYSTEM_PROMPT = `You are completing one step of a larger software engineering task.

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
  ): Promise<StepResult> {
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

    const req: NormalisedLLMRequest = {
      messages: [
        { role: 'system', content: EXECUTOR_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      model: '',
    };

    const response = await this.provider.createChatCompletion(req);
    return this.parseResult(step.id, response.content, response.usage?.total_tokens ?? 0);
  }

  private parseResult(stepId: string, content: string, tokensUsed: number): StepResult {
    // Extract confidence from the end of the response
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
