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

// Anchored to end of string — the memory block should always be the last thing
const MEMORY_REGEX = /<memory>\s*([\s\S]*?)\s*<\/memory>\s*$/;
// Unanchored variant for stripping from history (memory may not be at end after edits)
const MEMORY_REGEX_GLOBAL = /<memory>\s*[\s\S]*?\s*<\/memory>/g;

// Max items/lengths to prevent prompt bloat from malformed memory
const MAX_STRING_LEN = 200;
const MAX_ARRAY_ITEMS = 10;

function clampString(val: unknown, maxLen = MAX_STRING_LEN): string {
  if (typeof val !== 'string') return '';
  return val.slice(0, maxLen);
}

function nullableString(val: unknown, maxLen = MAX_STRING_LEN): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'string') return null;
  return val.slice(0, maxLen);
}

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
  const env = getCachedEnvironmentInfo();

  try {
    const parsed = JSON.parse(match[1]);
    const memory: WorkingMemory = {
      repo_path: nullableString(parsed.repo_path) ?? env.repo_path,
      git_remote: nullableString(parsed.git_remote) ?? env.git_remote,
      git_branch: nullableString(parsed.git_branch) ?? env.git_branch,
      current_goal: clampString(parsed.current_goal),
      acceptance_criteria: validateStringArray(parsed.acceptance_criteria),
      active_files: validateActiveFiles(parsed.active_files),
      key_decisions: validateKeyDecisions(parsed.key_decisions),
      discovered_constraints: validateStringArray(parsed.discovered_constraints),
      error_context:
        parsed.error_context && typeof parsed.error_context === 'object'
          ? {
              description: clampString(parsed.error_context.description),
              attempted_fix: parsed.error_context.attempted_fix
                ? clampString(parsed.error_context.attempted_fix)
                : undefined,
              resolved: Boolean(parsed.error_context.resolved),
            }
          : null,
      project_stack: {
        language: nullableString(parsed.project_stack?.language),
        framework: nullableString(parsed.project_stack?.framework),
        test_runner: nullableString(parsed.project_stack?.test_runner),
        package_manager: nullableString(parsed.project_stack?.package_manager),
        linting: nullableString(parsed.project_stack?.linting),
      },
    };
    return { content: cleaned, memory };
  } catch {
    return { content: cleaned, memory: null };
  }
}

function validateStringArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item): item is string => typeof item === 'string')
    .slice(0, MAX_ARRAY_ITEMS)
    .map(s => s.slice(0, MAX_STRING_LEN));
}

function validateActiveFiles(arr: unknown): WorkingMemory['active_files'] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item): item is Record<string, unknown> => item && typeof item === 'object')
    .slice(0, MAX_ARRAY_ITEMS)
    .map(item => ({
      path: clampString(item.path),
      purpose: clampString(item.purpose),
      last_action: (['read', 'modified', 'created'].includes(item.last_action as string)
        ? item.last_action
        : 'read') as 'read' | 'modified' | 'created',
    }));
}

function validateKeyDecisions(arr: unknown): WorkingMemory['key_decisions'] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item): item is Record<string, unknown> => item && typeof item === 'object')
    .slice(0, MAX_ARRAY_ITEMS)
    .map(item => ({
      decision: clampString(item.decision),
      rationale: typeof item.rationale === 'string' ? item.rationale.slice(0, MAX_STRING_LEN) : undefined,
    }));
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
    if (msg.role === 'assistant' && msg.content && MEMORY_REGEX_GLOBAL.test(msg.content)) {
      // Reset lastIndex since we're using a global regex
      MEMORY_REGEX_GLOBAL.lastIndex = 0;
      return { ...msg, content: msg.content.replace(MEMORY_REGEX_GLOBAL, '').trimEnd() };
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
// Serialize working memory into compact text for prompt injection
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
// Compact messages using working memory
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
// Deterministic environment extraction — cached at module level
// ---------------------------------------------------------------------------

interface EnvironmentInfo {
  repo_path: string | null;
  git_remote: string | null;
  git_branch: string | null;
}

let _cachedEnv: EnvironmentInfo | null = null;

function getCachedEnvironmentInfo(): EnvironmentInfo {
  if (_cachedEnv) return _cachedEnv;
  _cachedEnv = getEnvironmentInfo();
  return _cachedEnv;
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

/** Reset cached env info (for testing). */
export function _resetEnvCache(): void {
  _cachedEnv = null;
}
