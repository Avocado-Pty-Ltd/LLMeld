import { execSync } from 'child_process';
import type { CloudProvider } from '../providers/base.js';
import type { NormalisedLLMRequest, NormalisedMessage } from '../types/normalised.js';
import type { PlanStep, StepResult } from '../types/plan.js';
import type { WorkingMemory } from '../types/working-memory.js';
import type { MemoryCache } from '../cache/memory-cache.js';

const MEMORY_EXTRACTION_PROMPT = `Extract structured working memory from the conversation below. Return valid JSON matching this exact schema:

{
  "repo_path": "absolute path to the TARGET project directory mentioned in conversation, or null",
  "git_remote": "git remote URL of the target project if mentioned, or null",
  "git_branch": "git branch of the target project if mentioned, or null",
  "current_goal": "what the user is currently trying to accomplish",
  "acceptance_criteria": ["measurable criteria for success"],
  "active_files": [{"path": "file/path", "purpose": "why it matters", "last_action": "read|modified|created"}],
  "key_decisions": [{"decision": "what was decided", "rationale": "why"}],
  "discovered_constraints": ["things learned about the project/environment"],
  "error_context": {"description": "what failed", "attempted_fix": "what was tried", "resolved": false} | null,
  "project_stack": {
    "language": "string or null",
    "framework": "string or null",
    "test_runner": "string or null",
    "package_manager": "string or null",
    "linting": "string or null"
  }
}

Rules:
- Only include information explicitly present in the conversation. Do not infer or guess.
- Use null for unknown values.
- Keep strings concise (under 100 chars each).
- active_files should only include files explicitly mentioned.
- IMPORTANT: repo_path should be the project the user is working ON, not the server hosting this AI. If the user mentions a specific project directory or repository, use that path.`;

/**
 * Build a WorkingMemory from the incoming request's message history.
 * Combines deterministic environment extraction with a single LLM call
 * to extract structured context from the conversation.
 */
export async function buildWorkingMemory(
  req: NormalisedLLMRequest,
  provider: CloudProvider,
): Promise<WorkingMemory> {
  // Deterministic: extract environment info
  const env = getEnvironmentInfo();

  // Prepare conversation excerpt for LLM extraction
  const conversationExcerpt = req.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-20)
    .map((m) => {
      const prefix = m.role === 'user' ? 'User' : 'Assistant';
      // Give user messages more room — they carry the intent
      const limit = m.role === 'user' ? 2000 : 800;
      return `${prefix}: ${m.content.slice(0, limit)}`;
    })
    .join('\n\n');

  if (!conversationExcerpt) {
    return createEmptyMemory(env);
  }

  try {
    const response = await provider.createChatCompletion({
      messages: [
        { role: 'system', content: MEMORY_EXTRACTION_PROMPT },
        { role: 'user', content: conversationExcerpt },
      ],
      model: '',
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    });

    const extracted = parseMemoryResponse(response.content);
    return mergeWithEnvironment(extracted, env);
  } catch {
    // If extraction fails, return empty memory with env info — don't block the request
    return createEmptyMemory(env);
  }
}

const INCREMENTAL_UPDATE_PROMPT = `You are updating an existing working memory with new conversation messages. Given the current memory state and new messages, return the updated memory as valid JSON matching the same schema.

Rules:
- Preserve all existing information unless contradicted by new messages.
- Add new files, decisions, and constraints discovered in the new messages.
- Update the current_goal only if the user has changed direction.
- Update repo_path/git_remote/git_branch if the user switches to a different project.
- Update error_context if new errors appeared or previous ones were resolved.
- Keep strings concise (under 100 chars each).
- Return the complete updated memory object.`;

/**
 * Get cached working memory or build from scratch.
 * On cache hit with new messages, performs incremental update.
 */
export async function getOrBuildMemory(
  req: NormalisedLLMRequest,
  provider: CloudProvider,
  cache: MemoryCache,
): Promise<{ memory: WorkingMemory; sessionKey: string; messageCount: number }> {
  const key = cache.deriveKey(req.messages);
  const cached = cache.get(key);
  const currentMessages = req.messages.filter(m => m.role === 'user' || m.role === 'assistant');

  if (!cached) {
    const memory = await buildWorkingMemory(req, provider);
    cache.set(key, { memory, messageCount: currentMessages.length, lastAccess: Date.now() });
    return { memory, sessionKey: key, messageCount: currentMessages.length };
  }

  if (currentMessages.length <= cached.messageCount) {
    cached.lastAccess = Date.now();
    return { memory: cached.memory, sessionKey: key, messageCount: cached.messageCount };
  }

  const newMessages = currentMessages.slice(cached.messageCount);
  const updated = await incrementalUpdate(cached.memory, newMessages, provider);
  cache.set(key, { memory: updated, messageCount: currentMessages.length, lastAccess: Date.now() });
  return { memory: updated, sessionKey: key, messageCount: currentMessages.length };
}

/**
 * Incrementally update working memory by processing only new messages.
 * Sends the current memory state + delta messages to the executor.
 */
async function incrementalUpdate(
  currentMemory: WorkingMemory,
  newMessages: NormalisedMessage[],
  provider: CloudProvider,
): Promise<WorkingMemory> {
  const memoryJson = JSON.stringify({
    current_goal: currentMemory.current_goal,
    acceptance_criteria: currentMemory.acceptance_criteria,
    active_files: currentMemory.active_files,
    key_decisions: currentMemory.key_decisions,
    discovered_constraints: currentMemory.discovered_constraints,
    error_context: currentMemory.error_context,
    project_stack: currentMemory.project_stack,
  });

  const newExcerpt = newMessages
    .filter(m => m.content)
    .map(m => {
      const prefix = m.role === 'user' ? 'User' : 'Assistant';
      const limit = m.role === 'user' ? 2000 : 800;
      return `${prefix}: ${m.content.slice(0, limit)}`;
    })
    .join('\n\n');

  if (!newExcerpt) return currentMemory;

  try {
    const response = await provider.createChatCompletion({
      messages: [
        { role: 'system', content: INCREMENTAL_UPDATE_PROMPT },
        {
          role: 'user',
          content: `Current memory state:\n${memoryJson}\n\nNew messages:\n${newExcerpt}`,
        },
      ],
      model: '',
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    });

    const extracted = parseMemoryResponse(response.content);
    return {
      repo_path: currentMemory.repo_path,
      git_remote: currentMemory.git_remote,
      git_branch: currentMemory.git_branch,
      current_goal: extracted.current_goal ?? currentMemory.current_goal,
      acceptance_criteria: extracted.acceptance_criteria ?? currentMemory.acceptance_criteria,
      active_files: extracted.active_files ?? currentMemory.active_files,
      key_decisions: extracted.key_decisions ?? currentMemory.key_decisions,
      discovered_constraints: extracted.discovered_constraints ?? currentMemory.discovered_constraints,
      error_context: extracted.error_context ?? currentMemory.error_context,
      project_stack: extracted.project_stack ?? currentMemory.project_stack,
    };
  } catch {
    return currentMemory;
  }
}

/**
 * Update working memory in-place after a step completes.
 * Deterministic — no LLM call needed.
 */
export function updateMemoryFromStep(
  memory: WorkingMemory,
  step: PlanStep,
  result: StepResult,
): void {
  // Add files touched by this step
  if (result.files_touched) {
    for (const filePath of result.files_touched) {
      const existing = memory.active_files.find((f) => f.path === filePath);
      if (existing) {
        existing.purpose = step.title;
        // Infer action from tool log
        if (result.tool_log?.some((l) => l.includes('write_file') && l.includes(filePath))) {
          existing.last_action = 'modified';
        }
      } else {
        const action = result.tool_log?.some(
          (l) => l.includes('write_file') && l.includes(filePath),
        )
          ? 'modified'
          : 'read';
        memory.active_files.push({
          path: filePath,
          purpose: step.title,
          last_action: action as 'read' | 'modified' | 'created',
        });
      }
    }
  }

  // Update error context
  if (result.confidence === 'low' || result.issues.length > 0) {
    memory.error_context = {
      description: result.issues.join('; ') || 'Step completed with low confidence',
      attempted_fix: step.instruction.slice(0, 200),
      resolved: false,
    };
  } else if (memory.error_context && !memory.error_context.resolved) {
    memory.error_context.resolved = true;
  }

  // Cap active files to prevent unbounded growth
  if (memory.active_files.length > 15) {
    memory.active_files = memory.active_files.slice(-15);
  }
}

/**
 * Serialize working memory into a compact text format for prompt injection.
 * Produces ~300-500 tokens of high-signal context.
 */
export function serializeMemory(memory: WorkingMemory): string {
  const lines: string[] = ['## Working Memory'];

  // Repository info
  if (memory.repo_path) {
    let repoLine = `Repo: ${memory.repo_path}`;
    if (memory.git_remote) repoLine += ` (${memory.git_remote}`;
    if (memory.git_branch) repoLine += `, branch: ${memory.git_branch}`;
    if (memory.git_remote) repoLine += ')';
    lines.push(repoLine);
  }

  // Goal
  lines.push(`Goal: ${memory.current_goal}`);

  // Acceptance criteria
  if (memory.acceptance_criteria.length > 0) {
    lines.push(`Criteria: ${memory.acceptance_criteria.join('; ')}`);
  }

  // Stack
  const stack = memory.project_stack;
  const stackParts = [
    stack.language,
    stack.framework,
    stack.test_runner,
    stack.package_manager,
    stack.linting,
  ].filter(Boolean);
  if (stackParts.length > 0) {
    lines.push(`Stack: ${stackParts.join(' | ')}`);
  }

  // Active files
  if (memory.active_files.length > 0) {
    lines.push('', '### Active Files');
    for (const f of memory.active_files) {
      lines.push(`- ${f.path} (${f.last_action}: ${f.purpose})`);
    }
  }

  // Key decisions
  if (memory.key_decisions.length > 0) {
    lines.push('', '### Decisions');
    for (const d of memory.key_decisions) {
      lines.push(`- ${d.decision}${d.rationale ? ` (${d.rationale})` : ''}`);
    }
  }

  // Constraints
  if (memory.discovered_constraints.length > 0) {
    lines.push('', '### Constraints');
    for (const c of memory.discovered_constraints) {
      lines.push(`- ${c}`);
    }
  }

  // Error context (only unresolved)
  if (memory.error_context && !memory.error_context.resolved) {
    lines.push('', '### Last Error');
    lines.push(`- ${memory.error_context.description}`);
    if (memory.error_context.attempted_fix) {
      lines.push(`  Tried: ${memory.error_context.attempted_fix}`);
    }
  }

  return lines.join('\n');
}

/**
 * Compact a normalised request's messages using working memory.
 * Replaces full chat history with memory + last 2 exchanges.
 * Used for the direct path (non-planner-executor).
 */
export function compactMessages(
  req: NormalisedLLMRequest,
  memory: WorkingMemory,
): NormalisedLLMRequest {
  const serialized = serializeMemory(memory);
  const messages = [...req.messages];

  // Extract system message if present
  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  // Find the last 2 user/assistant exchanges, then include any trailing tool messages
  const userAssistantIndices: number[] = [];
  for (let i = 0; i < nonSystemMessages.length; i++) {
    if (nonSystemMessages[i].role === 'user' || nonSystemMessages[i].role === 'assistant') {
      userAssistantIndices.push(i);
    }
  }

  // Take from the start of the 4th-to-last user/assistant message (2 exchanges = 4 msgs)
  const cutoff = userAssistantIndices.length > 4
    ? userAssistantIndices[userAssistantIndices.length - 4]
    : 0;
  const recentMessages = nonSystemMessages.slice(cutoff);

  // Build compacted message list
  const compacted = [];

  // System message with memory prepended
  const systemContent = systemMsg
    ? `${serialized}\n\n${systemMsg.content}`
    : serialized;
  compacted.push({ role: 'system' as const, content: systemContent });

  // Recent messages (includes tool messages that belong to the exchanges)
  compacted.push(...recentMessages);

  return { ...req, messages: compacted };
}

// --- Internal helpers ---

interface EnvironmentInfo {
  repo_path: string | null;
  git_remote: string | null;
  git_branch: string | null;
}

function getEnvironmentInfo(): EnvironmentInfo {
  const cwd = process.cwd();
  let gitRemote: string | null = null;
  let gitBranch: string | null = null;

  try {
    gitRemote = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf-8' }).trim();
    gitBranch = execSync('git branch --show-current 2>/dev/null', { encoding: 'utf-8' }).trim();
  } catch {
    // Not a git repo
  }

  return {
    repo_path: cwd,
    git_remote: gitRemote || null,
    git_branch: gitBranch || null,
  };
}

function createEmptyMemory(env: EnvironmentInfo): WorkingMemory {
  return {
    repo_path: env.repo_path,
    git_remote: env.git_remote,
    git_branch: env.git_branch,
    current_goal: '',
    acceptance_criteria: [],
    active_files: [],
    key_decisions: [],
    discovered_constraints: [],
    error_context: null,
    project_stack: {
      language: null,
      framework: null,
      test_runner: null,
      package_manager: null,
      linting: null,
    },
  };
}

function parseMemoryResponse(content: string): Partial<WorkingMemory> {
  let jsonStr = content.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr);

  const hasErrorContext = Object.prototype.hasOwnProperty.call(parsed, 'error_context');
  const hasProjectStack =
    parsed.project_stack !== undefined &&
    parsed.project_stack !== null &&
    typeof parsed.project_stack === 'object';

  return {
    repo_path: typeof parsed.repo_path === 'string' ? parsed.repo_path : undefined,
    git_remote: typeof parsed.git_remote === 'string' ? parsed.git_remote : undefined,
    git_branch: typeof parsed.git_branch === 'string' ? parsed.git_branch : undefined,
    current_goal: typeof parsed.current_goal === 'string' ? parsed.current_goal : undefined,
    acceptance_criteria: Array.isArray(parsed.acceptance_criteria)
      ? parsed.acceptance_criteria
      : undefined,
    active_files: Array.isArray(parsed.active_files) ? parsed.active_files : undefined,
    key_decisions: Array.isArray(parsed.key_decisions) ? parsed.key_decisions : undefined,
    discovered_constraints: Array.isArray(parsed.discovered_constraints)
      ? parsed.discovered_constraints
      : undefined,
    error_context: hasErrorContext && typeof parsed.error_context === 'object' && parsed.error_context !== null
      ? {
          description: typeof parsed.error_context.description === 'string' ? parsed.error_context.description : '',
          attempted_fix: typeof parsed.error_context.attempted_fix === 'string' ? parsed.error_context.attempted_fix : '',
          resolved: Boolean(parsed.error_context.resolved),
        }
      : hasErrorContext && parsed.error_context === null
        ? null
        : undefined,
    project_stack: hasProjectStack
      ? {
          language:
            parsed.project_stack.language === null || typeof parsed.project_stack.language === 'string'
              ? parsed.project_stack.language
              : undefined,
          framework:
            parsed.project_stack.framework === null || typeof parsed.project_stack.framework === 'string'
              ? parsed.project_stack.framework
              : undefined,
          test_runner:
            parsed.project_stack.test_runner === null || typeof parsed.project_stack.test_runner === 'string'
              ? parsed.project_stack.test_runner
              : undefined,
          package_manager:
            parsed.project_stack.package_manager === null ||
            typeof parsed.project_stack.package_manager === 'string'
              ? parsed.project_stack.package_manager
              : undefined,
          linting:
            parsed.project_stack.linting === null || typeof parsed.project_stack.linting === 'string'
              ? parsed.project_stack.linting
              : undefined,
        }
      : undefined,
  };
}

function mergeWithEnvironment(
  extracted: Partial<WorkingMemory>,
  env: EnvironmentInfo,
): WorkingMemory {
  // Prefer LLM-extracted repo info when the conversation references
  // a different project than the server's working directory.
  return {
    repo_path: extracted.repo_path ?? env.repo_path,
    git_remote: extracted.git_remote ?? env.git_remote,
    git_branch: extracted.git_branch ?? env.git_branch,
    current_goal: extracted.current_goal ?? '',
    acceptance_criteria: extracted.acceptance_criteria ?? [],
    active_files: extracted.active_files ?? [],
    key_decisions: extracted.key_decisions ?? [],
    discovered_constraints: extracted.discovered_constraints ?? [],
    error_context: extracted.error_context ?? null,
    project_stack: extracted.project_stack ?? {
      language: null,
      framework: null,
      test_runner: null,
      package_manager: null,
      linting: null,
    },
  };
}
