import type { CloudProvider } from '../providers/base.js';
import type { NormalisedLLMRequest } from '../types/normalised.js';
import type { ExecutionPlan } from '../types/plan.js';

const PLANNER_SYSTEM_PROMPT = `You are a software engineering task planner. Your job is to decompose a user's request into a sequence of focused, self-contained steps that a smaller AI model can execute independently.

## Executor capabilities
The executor is a local AI model with access to these tools:
- **shell_exec**: Run shell commands (git, gh, npm, curl, ls, grep, etc.)
- **read_file**: Read file contents by path
- **write_file**: Write/create files with content

The executor CAN:
- Run CLI commands, interact with the filesystem, use git and gh CLI
- Read and write files, create directories
- Generate text, code, explanations, and analysis

The executor CANNOT:
- Access the internet directly (no browser), but CAN use CLI tools like curl or gh
- Run long-lived processes or servers
- Display images or GUIs

When creating steps, feel free to instruct the executor to use shell commands, read files, or write files as needed.

## Rules
1. If the task is simple (a direct question, a small code fix, a brief explanation), set estimated_complexity to "low" and create a single step that contains the full task.
2. For complex tasks, break them into 2-6 steps. Each step must be independently executable.
3. Each step's "instruction" must contain ALL context the executor needs — relevant code snippets, file paths, constraints, expected function signatures. The executor cannot see the original conversation.
4. Each step's "expected_output" must describe what correct output looks like, so it can be verified.
5. Set "allow_local" to false on steps that require deep reasoning, large context synthesis, or tasks that a small model would likely fail at.
6. Set "escalate_if_fails" to true on critical steps where an incorrect result would cascade.
7. For code tasks: each step should produce a concrete artifact (a function, a file modification, a test). Avoid vague steps like "think about the design".
8. Include relevant code from the conversation in step instructions — the executor cannot see prior messages.

## Output format
Return ONLY a single JSON object (no markdown fences, no explanation) matching this schema:
{
  "goal": "string — what the user wants to achieve",
  "acceptance_criteria": ["string — how to know the overall task is done"],
  "estimated_complexity": "low" | "medium" | "high",
  "context_for_executor": "string — shared background context all steps might need",
  "steps": [
    {
      "id": "step-1",
      "title": "string — short title",
      "instruction": "string — complete instruction for the executor including all needed context",
      "expected_output": "string — what correct output looks like",
      "depends_on": [],
      "escalate_if_fails": true | false,
      "allow_local": true | false
    }
  ]
}`;

export class Planner {
  constructor(private provider: CloudProvider) {}

  async createPlan(req: NormalisedLLMRequest): Promise<ExecutionPlan> {
    // Extract only the latest user message + any system message.
    // Sending the full conversation history causes the planner to continue
    // the chat pattern instead of returning structured JSON.
    const systemMsg = req.messages.find((m) => m.role === 'system');
    const lastUserMsg = [...req.messages].reverse().find((m) => m.role === 'user');

    if (!lastUserMsg) {
      throw new Error('No user message found in request');
    }

    // Build a concise context summary from recent assistant messages (if any)
    // so the planner knows what's already been discussed
    const recentContext = req.messages
      .filter((m) => m.role === 'assistant' && m.content)
      .slice(-2)
      .map((m) => m.content.slice(0, 300))
      .join('\n');

    const userContent = recentContext
      ? `## Recent conversation context\n${recentContext}\n\n## Current request\n${lastUserMsg.content}`
      : lastUserMsg.content;

    const messages = [
      { role: 'system' as const, content: PLANNER_SYSTEM_PROMPT + (systemMsg ? `\n\n## Client system prompt\n${systemMsg.content.slice(0, 500)}` : '') },
      { role: 'user' as const, content: userContent },
    ];

    const plannerReq: NormalisedLLMRequest = {
      messages,
      model: req.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    };

    const response = await this.provider.createChatCompletion(plannerReq);
    return this.parsePlan(response.content);
  }

  async synthesize(
    originalMessages: NormalisedLLMRequest['messages'],
    plan: ExecutionPlan,
    stepResults: Array<{ title: string; output: string }>,
  ): Promise<string> {
    const resultsText = stepResults
      .map((r, i) => `### Step ${i + 1}: ${r.title}\n${r.output}`)
      .join('\n\n');

    const originalUserMsg = [...originalMessages]
      .reverse()
      .find((m) => m.role === 'user')?.content ?? '';

    const synthesisReq: NormalisedLLMRequest = {
      messages: [
        {
          role: 'system',
          content: `You are synthesizing the results of a multi-step task execution into a single coherent response.

Combine the step results into a response that directly addresses the user's original request.
- If results contain code, present the final code clearly with proper formatting.
- If steps produced partial results, combine them logically.
- If any step had issues, note them briefly.
- Match the response format the user would expect (code blocks for code, prose for explanations).
- Do NOT mention the planning/execution process — respond as if you did the work yourself.`,
        },
        {
          role: 'user',
          content: `## Original request\n${originalUserMsg}\n\n## Plan goal\n${plan.goal}\n\n## Step results\n${resultsText}`,
        },
      ],
      model: '',
    };

    const response = await this.provider.createChatCompletion(synthesisReq);
    return response.content;
  }

  private parsePlan(content: string): ExecutionPlan {
    let jsonStr = content.trim();

    // Strip markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    // Try direct parse first
    try {
      const parsed = JSON.parse(jsonStr);
      return this.validatePlan(parsed);
    } catch {
      // Fall through to extraction attempts
    }

    // Try to find a JSON object anywhere in the response
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try {
        const extracted = content.slice(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(extracted);
        return this.validatePlan(parsed);
      } catch {
        // Fall through
      }
    }

    throw new Error(`Planner returned invalid JSON: ${content.slice(0, 200)}`);
  }

  private validatePlan(data: unknown): ExecutionPlan {
    const plan = data as Record<string, unknown>;

    if (!plan.goal || typeof plan.goal !== 'string') {
      throw new Error('Plan missing "goal" field');
    }
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new Error('Plan missing or empty "steps" array');
    }

    return {
      goal: plan.goal as string,
      acceptance_criteria: Array.isArray(plan.acceptance_criteria)
        ? (plan.acceptance_criteria as string[])
        : [],
      estimated_complexity: (['low', 'medium', 'high'].includes(plan.estimated_complexity as string)
        ? plan.estimated_complexity
        : 'medium') as ExecutionPlan['estimated_complexity'],
      context_for_executor: (plan.context_for_executor as string) ?? '',
      steps: (plan.steps as Array<Record<string, unknown>>).map((s, i) => ({
        id: (s.id as string) ?? `step-${i + 1}`,
        title: (s.title as string) ?? `Step ${i + 1}`,
        instruction: (s.instruction as string) ?? '',
        expected_output: (s.expected_output as string) ?? '',
        depends_on: Array.isArray(s.depends_on) ? (s.depends_on as string[]) : [],
        escalate_if_fails: Boolean(s.escalate_if_fails),
        allow_local: s.allow_local !== false,
      })),
    };
  }
}
