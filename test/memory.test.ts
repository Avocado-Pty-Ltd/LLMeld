import { describe, it, expect } from 'vitest';
import { parseMemoryFile, serializeMemoryFile, estimateTokens } from '../src/memory/format.js';
import { pruneEntries } from '../src/memory/pruner.js';
import type { MemoryEntry, MemoryConfig } from '../src/memory/types.js';
import { INJECTION_PRIORITY, MEMORY_SECTIONS } from '../src/memory/types.js';
import { configSchema } from '../src/config/schema.js';

const baseConfig: MemoryConfig = {
  enabled: true,
  file_path: './.llmeld/memory.md',
  max_inject_tokens: 2000,
  extraction_provider: 'executor',
  max_entries: 100,
  staleness_days: 30,
  inject_on_direct: true,
  auto_extract: true,
};

describe('memory format', () => {
  const sampleMarkdown = `# LLMeld Shared Memory

## Project Knowledge

### [2026-04-15] Architecture: planner-executor pattern
<!-- type: project | confidence: high | source: auto | ttl: permanent -->
Cloud planner decomposes tasks, local executor runs steps.

## Shared Vocabulary

### [2026-04-15] Term: "surface" means API endpoint layer
<!-- type: vocabulary | confidence: high | source: auto | ttl: permanent -->
Surface = HTTP API layer.

## Orchestration Hints

### [2026-04-16] Hint: executor needs full file paths
<!-- type: orchestration | confidence: high | source: auto | ttl: permanent -->
Always include absolute file paths in step instructions.

## Execution Learnings

### [2026-04-16T14:30:00Z] Learning: shell_exec timeouts on large test suites
<!-- type: learning | confidence: medium | source: auto | ttl: 30d -->
Run specific test files, not the entire suite.

## Conversation Memory

### [2026-04-16T14:30:00Z] Fixed JWT expiry bug in auth middleware
<!-- type: conversation | confidence: medium | source: auto | ttl: 30d -->
Changed src/auth/middleware.ts to validate exp claim.
`;

  it('parses memory markdown into entries', () => {
    const file = parseMemoryFile(sampleMarkdown);
    expect(file.entries).toHaveLength(5);

    const project = file.entries.find((e) => e.type === 'project');
    expect(project).toBeDefined();
    expect(project!.title).toBe('Architecture: planner-executor pattern');
    expect(project!.confidence).toBe('high');
    expect(project!.ttl).toBe('permanent');
    expect(project!.body).toContain('Cloud planner decomposes tasks');

    const vocab = file.entries.find((e) => e.type === 'vocabulary');
    expect(vocab).toBeDefined();
    expect(vocab!.title).toBe('Term: "surface" means API endpoint layer');

    const orch = file.entries.find((e) => e.type === 'orchestration');
    expect(orch).toBeDefined();

    const learning = file.entries.find((e) => e.type === 'learning');
    expect(learning).toBeDefined();
    expect(learning!.confidence).toBe('medium');
    expect(learning!.ttl).toBe('30d');

    const convo = file.entries.find((e) => e.type === 'conversation');
    expect(convo).toBeDefined();
  });

  it('round-trips parse/serialize', () => {
    const file = parseMemoryFile(sampleMarkdown);
    const serialized = serializeMemoryFile(file);
    const reparsed = parseMemoryFile(serialized);

    expect(reparsed.entries).toHaveLength(file.entries.length);
    for (let i = 0; i < file.entries.length; i++) {
      expect(reparsed.entries[i].type).toBe(file.entries[i].type);
      expect(reparsed.entries[i].title).toBe(file.entries[i].title);
      expect(reparsed.entries[i].confidence).toBe(file.entries[i].confidence);
      expect(reparsed.entries[i].ttl).toBe(file.entries[i].ttl);
    }
  });

  it('serializes entries into correct section order', () => {
    const file = parseMemoryFile(sampleMarkdown);
    const serialized = serializeMemoryFile(file);

    const projectIdx = serialized.indexOf('## Project Knowledge');
    const vocabIdx = serialized.indexOf('## Shared Vocabulary');
    const orchIdx = serialized.indexOf('## Orchestration Hints');
    const learnIdx = serialized.indexOf('## Execution Learnings');
    const convoIdx = serialized.indexOf('## Conversation Memory');

    expect(projectIdx).toBeLessThan(vocabIdx);
    expect(vocabIdx).toBeLessThan(orchIdx);
    expect(orchIdx).toBeLessThan(learnIdx);
    expect(learnIdx).toBeLessThan(convoIdx);
  });

  it('handles empty file', () => {
    const file = parseMemoryFile('');
    expect(file.entries).toHaveLength(0);
  });

  it('serializes empty file to header only', () => {
    const serialized = serializeMemoryFile({ entries: [] });
    expect(serialized).toBe('# LLMeld Shared Memory\n');
  });

  it('estimates tokens roughly at 4 chars per token', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75 → 3
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('memory pruner', () => {
  const makeEntry = (
    overrides: Partial<MemoryEntry> = {},
  ): MemoryEntry => ({
    type: 'conversation',
    title: 'Test entry',
    body: 'Test body',
    date: '2026-04-15',
    confidence: 'medium',
    source: 'auto',
    ttl: '30d',
    ...overrides,
  });

  it('removes expired entries', () => {
    const entries: MemoryEntry[] = [
      makeEntry({ date: '2020-01-01', ttl: '30d', title: 'old' }),
      makeEntry({ date: '2026-04-10', ttl: '30d', title: 'recent' }),
    ];
    const result = pruneEntries(entries, baseConfig);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('recent');
  });

  it('never expires permanent entries', () => {
    const entries: MemoryEntry[] = [
      makeEntry({ date: '2020-01-01', ttl: 'permanent', title: 'permanent' }),
      makeEntry({ date: '2020-01-01', ttl: '30d', title: 'expired' }),
    ];
    const result = pruneEntries(entries, baseConfig);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('permanent');
  });

  it('evicts low-confidence entries when over max_entries', () => {
    const config = { ...baseConfig, max_entries: 2 };
    const entries: MemoryEntry[] = [
      makeEntry({ confidence: 'low', title: 'low-conf', date: '2026-04-15', ttl: 'permanent' }),
      makeEntry({ confidence: 'high', title: 'high-conf', date: '2026-04-15', ttl: 'permanent' }),
      makeEntry({ confidence: 'medium', title: 'med-conf', date: '2026-04-15', ttl: 'permanent' }),
    ];
    const result = pruneEntries(entries, config);
    expect(result).toHaveLength(2);
    const titles = result.map((e) => e.title);
    expect(titles).toContain('high-conf');
    expect(titles).toContain('med-conf');
    expect(titles).not.toContain('low-conf');
  });

  it('evicts older entries at same confidence when over max_entries', () => {
    const config = { ...baseConfig, max_entries: 2 };
    const entries: MemoryEntry[] = [
      makeEntry({ confidence: 'medium', title: 'oldest', date: '2026-04-01', ttl: 'permanent' }),
      makeEntry({ confidence: 'medium', title: 'newest', date: '2026-04-15', ttl: 'permanent' }),
      makeEntry({ confidence: 'medium', title: 'middle', date: '2026-04-10', ttl: 'permanent' }),
    ];
    const result = pruneEntries(entries, config);
    expect(result).toHaveLength(2);
    const titles = result.map((e) => e.title);
    expect(titles).toContain('newest');
    expect(titles).toContain('middle');
    expect(titles).not.toContain('oldest');
  });

  it('passes through entries under limit without change', () => {
    const entries: MemoryEntry[] = [
      makeEntry({ title: 'one', date: '2026-04-15', ttl: 'permanent' }),
      makeEntry({ title: 'two', date: '2026-04-15', ttl: 'permanent' }),
    ];
    const result = pruneEntries(entries, baseConfig);
    expect(result).toHaveLength(2);
  });
});

describe('memory types', () => {
  it('INJECTION_PRIORITY has all 5 types', () => {
    expect(INJECTION_PRIORITY).toHaveLength(5);
    expect(INJECTION_PRIORITY[0]).toBe('vocabulary');
    expect(INJECTION_PRIORITY[1]).toBe('project');
  });

  it('MEMORY_SECTIONS maps all types', () => {
    expect(Object.keys(MEMORY_SECTIONS)).toHaveLength(5);
    expect(MEMORY_SECTIONS.project).toBe('Project Knowledge');
    expect(MEMORY_SECTIONS.vocabulary).toBe('Shared Vocabulary');
    expect(MEMORY_SECTIONS.orchestration).toBe('Orchestration Hints');
    expect(MEMORY_SECTIONS.learning).toBe('Execution Learnings');
    expect(MEMORY_SECTIONS.conversation).toBe('Conversation Memory');
  });
});

describe('config schema with memory', () => {
  const minimalConfig = {
    providers: {
      planner: { type: 'openrouter', model: 'anthropic/claude-sonnet-4-20250514', api_key_env: 'OPENROUTER_API_KEY' },
      executor: { type: 'ollama', model: 'gemma3:4b', base_url: 'http://localhost:11434/v1', api_key: 'ollama' },
    },
  };

  it('defaults memory to disabled', () => {
    const result = configSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.memory.enabled).toBe(false);
    expect(result.data.memory.file_path).toBe('./.llmeld/memory.md');
    expect(result.data.memory.max_inject_tokens).toBe(2000);
    expect(result.data.memory.max_entries).toBe(100);
  });

  it('accepts explicit memory config', () => {
    const result = configSchema.safeParse({
      ...minimalConfig,
      memory: {
        enabled: true,
        file_path: './custom/memory.md',
        max_inject_tokens: 1000,
        extraction_provider: 'planner',
        max_entries: 50,
        staleness_days: 60,
        inject_on_direct: false,
        auto_extract: false,
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.memory.enabled).toBe(true);
    expect(result.data.memory.file_path).toBe('./custom/memory.md');
    expect(result.data.memory.max_inject_tokens).toBe(1000);
    expect(result.data.memory.extraction_provider).toBe('planner');
    expect(result.data.memory.max_entries).toBe(50);
  });
});
