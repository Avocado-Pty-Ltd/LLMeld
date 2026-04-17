import { execSync } from 'child_process';
import type { NormalisedLLMRequest, NormalisedMessage } from '../types/normalised.js';
import type { WorkingMemory } from '../types/working-memory.js';
import type { MemoryCache } from '../cache/memory-cache.js';

// ---------------------------------------------------------------------------
// Inline memory system instruction — appended to system prompt every turn.
// The model emits a <memory> block after its response; we strip and cache it.
// ---------------------------------------------------------------------------

export const MEMORY_SYSTEM_INSTRUCTION = `

After your response, emit a memory block for context continuity. Format:

<memory>
{"repo_path":null,"git_remote":null,"git_branch":null,"current_goal":"...","acceptance_criteria":["..."],"active_files":[{"path":"...","purpose":"...","last_action":"read|modified|created"}],"key_decisions":[{"decision":"...","rationale":"..."}],"discovered_constraints":["..."],"error_context":null,"project_stack":{"language":null,"framework":null,"test_runner":null,"package_manager":null,"linting":null}}
</memory>

Rules:
- Only include facts from this conversation. Do not infer or guess.
- Be concise (<500 chars total JSON).
- Update the previous memory — don't append, replace it entirely.
- Use null for unknown values, empty arrays for no items.
- The <memory> block MUST be the very last thing in your response.`;

// ---------------------------------------------------------------------------
// Strip <memory> block from model response content
// ---------------------------------------------------------------------------

const MEMORY_REGEX = /<memory>\s*([\s\S]*?)\s*<\/memory>/;

/**
 * Extract and remove the <memory> block from model response content.
 * Returns the cleaned content and parsed memory (or null if none found / parse fails).
 */
export function stripMemoryBlock(content: string): { content: string; memory: WorkingMemory | null } {
  const match = content.match(MEMORY_REGEX);
  if (!match) {
    return { content, memory: null };
  }

  const cleaned = content.replace(MEMORY_REGEX, '').trimEnd();
  const env = getEnvironmentInfo();

  try {
    const parsed = JSON.parse(match[1]);
    const memory: WorkingMemory = {
      repo_path: typeof parsed.repo_path === 'string' ? parsed.repo_path : env.repo_path,
      git_remote: typeof parsed.git_remote === 'string' ? parsed.git_remote : env.git_remote,
      git_branch: typeof parsed.git_branch === 'string' ? parsed.git_branch : env.git_branch,
      current_goal: typeof parsed.current_goal === 'string' ? parsed.current_goal : '',
      acceptance_criteria: Array.isArray(parsed.acceptance_criteria) ? parsed.acceptance_criteria : [],
      active_files: Array.isArray(parsed.active_files) ? parsed.active_files : [],
      key_decisions: Array.isArray(parsed.key_decisions) ? parsed.key_decisions : [],
      discovered_constraints: Array.isArray(parsed.discovered_constraints) ? parsed.discovered_constraints : [],
      error_context:
        parsed.error_context && typeof parsed.error_context === 'object'
          ? {
              description: String(parsed.error_context.description ?? ''),
              attempted_fix: parsed.error_context.attempted_fix ? String(parsed.error_context.attempted_fix) : undefined,
              resolved: Boolean(parsed.error_context.resolved),
            }
          : null,
      project_stack: {
        language: parsed.project_stack?.language ?? null,
        framework: parsed.project_stack?.framework ?? null,
        test_runner: parsed.project_stack?.test_runner ?? null,
        package_manager: parsed.project_stack?.package_manager ?? null,
        linting: parsed.project_stack?.linting ?? null,
      },
    };
    return { content: cleaned, memory };
  } catch {
    return { content: cleaned, memory: null };
  }
}

// ---------------------------------------------------------------------------
// Strip <memory> blocks from assistant messages in request history
// ---------------------------------------------------------------------------

/**
 * Remove <memory>...</memory> from all assistant messages before sending to the provider.
 * This prevents the model from seeing its own memory tags from previous turns.
 */
export function stripMemoryFromHistory(messages: NormalisedMessage[]): NormalisedMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.content && MEMORY_REGEX.test(msg.content)) {
      return { ...msg, content: msg.content.replace(MEMORY_REGEX, '').trimEnd() };
    }
    return msg;
  });
}

// ---------------------------------------------------------------------------
// Session memory cache helpers
// ---------------------------------------------------------------------------

/**
 * Look up cached memory for this session. Returns null on cache miss.
 */
export function getSessionMemory(
  cache: MemoryCache,
  messages: NormalisedMessage[],
): { memory: WorkingMemory; sessionKey: string } | null {
  const key = cache.deriveKey(messages);
  const entry = cache.get(key);
  if (!entry) return null;
  return { memory: entry.memory, sessionKey: key };
}

/**
 * Save extracted memory to the session cache.
 */
export function saveSessionMemory(
  cache: MemoryCache,
  messages: NormalisedMessage[],
  memory: WorkingMemory,
): void {
  const key = cache.deriveKey(messages);
  const userAssistantCount = messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
  cache.update(key, memory, userAssistantCount);
}

// ---------------------------------------------------------------------------
// Serialize working memory into compact text for prompt injection (unchanged)
// ---------------------------------------------------------------------------

export function serializeMemory(memory: WorkingMemory): string {
  const lines: string[] = ['## Working Memory'];

  if (memory.repo_path) {
    let repoLine = `Repo: ${memory.repo_path}`;
    if (memory.git_remote) repoLine += ` (${memory.git_remote}`;
    if (memory.git_branch) repoLine += `, branch: ${memory.git_branch}`;
    if (memory.git_remote) repoLine += ')';
    lines.push(repoLine);
  }

  lines.push(`Goal: ${memory.current_goal}`);

  if (memory.acceptance_criteria.length > 0) {
    lines.push(`Criteria: ${memory.acceptance_criteria.join('; ')}`);
  }

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

  if (memory.active_files.length > 0) {
    lines.push('', '### Active Files');
    for (const f of memory.active_files) {
      lines.push(`- ${f.path} (${f.last_action}: ${f.purpose})`);
    }
  }

  if (memory.key_decisions.length > 0) {
    lines.push('', '### Decisions');
    for (const d of memory.key_decisions) {
      lines.push(`- ${d.decision}${d.rationale ? ` (${d.rationale})` : ''}`);
    }
  }

  if (memory.discovered_constraints.length > 0) {
    lines.push('', '### Constraints');
    for (const c of memory.discovered_constraints) {
      lines.push(`- ${c}`);
    }
  }

  if (memory.error_context && !memory.error_context.resolved) {
    lines.push('', '### Last Error');
    lines.push(`- ${memory.error_context.description}`);
    if (memory.error_context.attempted_fix) {
      lines.push(`  Tried: ${memory.error_context.attempted_fix}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Compact messages using working memory (unchanged)
// ---------------------------------------------------------------------------

export function compactMessages(
  req: NormalisedLLMRequest,
  memory: WorkingMemory,
): NormalisedLLMRequest {
  const serialized = serializeMemory(memory);
  const messages = [...req.messages];

  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const userAssistantIndices: number[] = [];
  for (let i = 0; i < nonSystemMessages.length; i++) {
    if (nonSystemMessages[i].role === 'user' || nonSystemMessages[i].role === 'assistant') {
      userAssistantIndices.push(i);
    }
  }

  const cutoff = userAssistantIndices.length > 4
    ? userAssistantIndices[userAssistantIndices.length - 4]
    : 0;
  const recentMessages = nonSystemMessages.slice(cutoff);

  const compacted = [];

  const systemContent = systemMsg
    ? `${serialized}\n\n${systemMsg.content}`
    : serialized;
  compacted.push({ role: 'system' as const, content: systemContent });

  compacted.push(...recentMessages);

  return { ...req, messages: compacted };
}

// ---------------------------------------------------------------------------
// Deterministic environment extraction (unchanged)
// ---------------------------------------------------------------------------

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
