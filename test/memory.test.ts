import { describe, it, expect } from 'vitest';
import { stripMemoryBlock, stripMemoryFromHistory } from '../src/orchestrator/memory.js';

describe('stripMemoryBlock', () => {
  const validMemoryJson = JSON.stringify({
    repo_path: null,
    git_remote: null,
    git_branch: null,
    current_goal: 'implement feature X',
    acceptance_criteria: ['tests pass'],
    active_files: [{ path: 'src/foo.ts', purpose: 'main file', last_action: 'modified' }],
    key_decisions: [{ decision: 'use approach A', rationale: 'simpler' }],
    discovered_constraints: ['no external deps'],
    error_context: null,
    project_stack: { language: 'TypeScript', framework: null, test_runner: 'vitest', package_manager: 'pnpm', linting: null },
  });

  it('extracts memory block at end of response', () => {
    const content = `Here is my response.\n\n<memory>\n${validMemoryJson}\n</memory>`;
    const result = stripMemoryBlock(content);

    expect(result.content).toBe('Here is my response.');
    expect(result.memory).not.toBeNull();
    expect(result.memory!.current_goal).toBe('implement feature X');
    expect(result.memory!.active_files).toHaveLength(1);
    expect(result.memory!.active_files[0].last_action).toBe('modified');
    expect(result.memory!.project_stack.language).toBe('TypeScript');
  });

  it('returns null memory when no <memory> block present', () => {
    const content = 'Just a normal response with no memory block.';
    const result = stripMemoryBlock(content);

    expect(result.content).toBe(content);
    expect(result.memory).toBeNull();
  });

  it('does not match <memory> in the middle of the response (non-terminal)', () => {
    const content = 'Here is an example:\n<memory>\n{"current_goal":"fake"}\n</memory>\nAnd more text after it.';
    const result = stripMemoryBlock(content);

    // Regex is anchored to end, so this should NOT match
    expect(result.content).toBe(content);
    expect(result.memory).toBeNull();
  });

  it('handles invalid JSON gracefully', () => {
    const content = 'Response text.\n\n<memory>\n{not valid json}\n</memory>';
    const result = stripMemoryBlock(content);

    expect(result.content).toBe('Response text.');
    expect(result.memory).toBeNull();
  });

  it('clamps overly long strings', () => {
    const longGoal = 'x'.repeat(500);
    const json = JSON.stringify({ current_goal: longGoal, active_files: [], key_decisions: [], acceptance_criteria: [], discovered_constraints: [], error_context: null, project_stack: {} });
    const content = `Response.\n\n<memory>\n${json}\n</memory>`;
    const result = stripMemoryBlock(content);

    expect(result.memory).not.toBeNull();
    expect(result.memory!.current_goal.length).toBeLessThanOrEqual(200);
  });

  it('caps array items at max limit', () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => ({
      path: `file${i}.ts`, purpose: 'test', last_action: 'read',
    }));
    const json = JSON.stringify({ current_goal: 'test', active_files: manyFiles, key_decisions: [], acceptance_criteria: [], discovered_constraints: [], error_context: null, project_stack: {} });
    const content = `Response.\n\n<memory>\n${json}\n</memory>`;
    const result = stripMemoryBlock(content);

    expect(result.memory).not.toBeNull();
    expect(result.memory!.active_files.length).toBeLessThanOrEqual(10);
  });

  it('filters non-string items from string arrays', () => {
    const json = JSON.stringify({
      current_goal: 'test',
      acceptance_criteria: ['valid', 42, null, 'also valid'],
      active_files: [],
      key_decisions: [],
      discovered_constraints: [],
      error_context: null,
      project_stack: {},
    });
    const content = `Response.\n\n<memory>\n${json}\n</memory>`;
    const result = stripMemoryBlock(content);

    expect(result.memory).not.toBeNull();
    expect(result.memory!.acceptance_criteria).toEqual(['valid', 'also valid']);
  });

  it('defaults invalid last_action to "read"', () => {
    const json = JSON.stringify({
      current_goal: 'test',
      active_files: [{ path: 'a.ts', purpose: 'test', last_action: 'deleted' }],
      key_decisions: [],
      acceptance_criteria: [],
      discovered_constraints: [],
      error_context: null,
      project_stack: {},
    });
    const content = `Response.\n\n<memory>\n${json}\n</memory>`;
    const result = stripMemoryBlock(content);

    expect(result.memory!.active_files[0].last_action).toBe('read');
  });
});

describe('stripMemoryFromHistory', () => {
  it('strips memory blocks from assistant messages', () => {
    const messages = [
      { role: 'system' as const, content: 'You are helpful.' },
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there!\n\n<memory>\n{"current_goal":"greet"}\n</memory>' },
      { role: 'user' as const, content: 'Thanks' },
    ];

    const result = stripMemoryFromHistory(messages);

    expect(result[0].content).toBe('You are helpful.');
    expect(result[1].content).toBe('Hello');
    expect(result[2].content).toBe('Hi there!');
    expect(result[3].content).toBe('Thanks');
  });

  it('does not modify user or system messages', () => {
    const messages = [
      { role: 'user' as const, content: 'Here is <memory>example</memory> text' },
      { role: 'system' as const, content: '<memory>system</memory>' },
    ];

    const result = stripMemoryFromHistory(messages);

    expect(result[0].content).toBe('Here is <memory>example</memory> text');
    expect(result[1].content).toBe('<memory>system</memory>');
  });

  it('handles assistant messages without memory blocks', () => {
    const messages = [
      { role: 'assistant' as const, content: 'Just a normal response.' },
    ];

    const result = stripMemoryFromHistory(messages);
    expect(result[0].content).toBe('Just a normal response.');
  });
});
