import { execSync } from 'child_process';
import type { CloudProvider } from '../providers/base.js';
import type { NormalisedLLMRequest, NormalisedMessage } from '../types/normalised.js';
import type { ExecutionPlan, ProgressEvent } from '../types/plan.js';
import type { WorkingMemory } from '../types/working-memory.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { serializeMemory } from './memory.js';

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

## Working environment
All tools run in the current working directory of the LLMeld server, which may NOT be the target project.
- Check Working Memory for the actual target repo_path. If it differs from CWD, start steps with \`cd <repo_path>\` before running commands.
- If the CWD is already a git checkout of the target repo, use read_file and shell_exec directly.
- Only clone a repository if it is not already checked out locally.
- The local environment details (CWD, git remote, branch) are appended to this prompt — but the Working Memory repo_path takes priority as the target project.

## Rules
1. If the task is simple (a direct question, a small code fix, a brief explanation), set estimated_complexity to "low" and create a single step.
2. For complex tasks, break them into 2-6 steps. Each step must be independently executable.
3. **KEEP STEPS SIMPLE.** The executor is a small local model. Each step should do ONE thing:
   - GOOD: "Read file src/config.ts and list all exported functions"
   - GOOD: "Write a function called parseConfig that takes a string and returns a Config object"
   - BAD: "Read the codebase, design a solution, implement it, and write tests" (too many things)
   - BAD: A step with 10 numbered sub-tasks (break those into separate steps instead)
4. Step instructions should be 1-3 sentences. Put shared context in "context_for_executor" instead of repeating it in every step.
5. Each step's "expected_output" should be a short description of what success looks like.
6. Set "allow_local" to false on steps that require deep reasoning or large context synthesis.
7. Set "escalate_if_fails" to true on critical steps where failure would cascade.
8. For code tasks: each step should produce ONE concrete artifact (a single function, one file edit, one command).
9. Include relevant code/file paths from the conversation in step instructions — the executor cannot see prior messages.

## Working Memory
You will receive a "Working Memory" block with structured context about the current session:
- Repository and git context
- The user's current goal and acceptance criteria
- Files recently read or modified
- Key architectural decisions made so far
- Known constraints and project conventions
- Any recent errors and what was tried

Use this context to create precise, informed step instructions. Reference specific file paths,
decisions, and constraints from the working memory in your step instructions.

## Git workflow — committing and creating PRs
When a plan involves modifying code or files (not just reading/analysis), you MUST add a final step to commit the changes and open a pull request. Follow these rules:

1. **Navigate to the correct repo first.** Use the repo_path from Working Memory. If the target project is different from the CWD, \`cd\` to it before any git operations.
2. **Create a feature branch** from the repo's default branch (usually \`main\`): \`git checkout -b <descriptive-branch-name>\`
3. **Stage only the files modified** by the plan — do NOT use \`git add .\` blindly.
4. **Commit** with a clear, conventional message (e.g., \`feat: add JWT auth endpoints\`).
5. **Push and create a PR** using the \`gh\` CLI: \`gh pr create --title "..." --body "..."\`
6. The PR body should summarize what was done and reference the goal from the plan.

Do NOT create PRs for:
- Pure research/analysis tasks (no files changed)
- Tasks estimated as "low" complexity with no file writes
- Tasks the user explicitly asks NOT to commit

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
  private static readonly MAX_RESEARCH_ITERATIONS = 5;

  constructor(private provider: CloudProvider) {}

  async createPlan(
    req: NormalisedLLMRequest,
    memory: WorkingMemory,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<ExecutionPlan> {
    const emit = onProgress ?? (() => {});
    const systemMsg = req.messages.find((m) => m.role === 'system');
    const lastUserMsg = [...req.messages].reverse().find((m) => m.role === 'user');

    if (!lastUserMsg) {
      throw new Error('No user message found in request');
    }

    // Build user content with working memory instead of raw chat history
    const memoryContext = serializeMemory(memory);
    const userContent = memoryContext
      ? `${memoryContext}\n\n## Current request\n${lastUserMsg.content}`
      : lastUserMsg.content;

    const envContext = this.getEnvironmentContext();

    // Phase 1: Research — let the planner use tools to gather context
    emit({ stage: 'planning', message: 'Researching task context...' });
    const researchContext = await this.research(userContent, envContext, systemMsg?.content, memory);

    // Phase 2: Plan — create the plan with research context embedded
    emit({ stage: 'planning', message: 'Creating execution plan...' });

    const planPrompt = researchContext
      ? `## Research findings\nBefore planning, I gathered this context:\n${researchContext}\n\n## User request\n${userContent}`
      : userContent;

    const messages: NormalisedMessage[] = [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT + envContext + (systemMsg ? `\n\n## Client system prompt\n${systemMsg.content.slice(0, 1000)}` : '') },
      { role: 'user', content: planPrompt },
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

  /**
   * Research phase: the planner uses tools to gather context before creating the plan.
   * This lets it embed specific details (PR comments, file contents, etc.) into step instructions
   * rather than creating vague "read and analyze" steps for the executor.
   */
  private async research(
    userContent: string,
    envContext: string,
    systemPrompt?: string,
    memory?: WorkingMemory,
  ): Promise<string> {
    const knownContext = memory ? `\n\n## Known context from working memory\n${serializeMemory(memory)}` : '';
    const researchPrompt = `You are preparing to plan a software engineering task. Before creating a plan, you can use tools to gather context.

## Tools available
- shell_exec: Run shell commands (git, gh, npm, curl, ls, grep, cat, etc.)
- read_file: Read file contents by path
- write_file: Write/create files (DO NOT use this during research)

## Your goal
Gather the specific context needed to create precise step instructions. For example:
- If the task mentions a PR, fetch the PR comments and understand what needs to change
- If the task mentions files, read the relevant files
- If the task mentions errors, check logs or run diagnostics

Keep research focused — only gather what you need. When done, respond with a summary of your findings.
Do NOT create a plan yet. Just gather and summarize context.
${envContext}
${systemPrompt ? `\n## Client context\n${systemPrompt.slice(0, 500)}` : ''}${knownContext}

## Task to research
${userContent}`;

    const messages: NormalisedMessage[] = [
      { role: 'user', content: researchPrompt },
    ];

    for (let i = 0; i < Planner.MAX_RESEARCH_ITERATIONS; i++) {
      const response = await this.provider.createChatCompletion({
        messages: [...messages],
        model: '',
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
      });

      // If no tool calls, we have our research summary
      if (response.finish_reason !== 'tool_calls' || !response.tool_calls?.length) {
        return response.content;
      }

      // Execute tool calls
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

    // Hit max iterations — use whatever the last assistant message said
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    return lastAssistant?.content || '';
  }

  async synthesize(
    originalMessages: NormalisedLLMRequest['messages'],
    plan: ExecutionPlan,
    stepResults: Array<{ title: string; output: string }>,
    memory?: WorkingMemory,
  ): Promise<string> {
    const resultsText = stepResults
      .map((r, i) => `### Step ${i + 1}: ${r.title}\n${r.output}`)
      .join('\n\n');

    const originalUserMsg = [...originalMessages]
      .reverse()
      .find((m) => m.role === 'user')?.content ?? '';

    const memorySection = memory ? `\n\n## Session context\n${serializeMemory(memory)}` : '';

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
          content: `## Original request\n${originalUserMsg}\n\n## Plan goal\n${plan.goal}\n\n## Step results\n${resultsText}${memorySection}`,
        },
      ],
      model: '',
    };

    const response = await this.provider.createChatCompletion(synthesisReq);
    return response.content;
  }

  private getEnvironmentContext(): string {
    const cwd = process.cwd();
    let gitInfo = '';
    try {
      const remote = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf-8' }).trim();
      const branch = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf-8' }).trim();
      gitInfo = `\nGit repo: ${remote} (branch: ${branch})`;
    } catch {
      // Not a git repo — that's fine
    }
    return `\n\n## Local environment\nCWD: ${cwd}${gitInfo}`;
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
