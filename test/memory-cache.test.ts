import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryCache } from '../src/cache/memory-cache.js';
import type { WorkingMemory } from '../src/types/working-memory.js';
import type { NormalisedMessage } from '../src/types/normalised.js';

function makeMemory(overrides?: Partial<WorkingMemory>): WorkingMemory {
  return {
    repo_path: '/test',
    git_remote: null,
    git_branch: null,
    current_goal: 'test goal',
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
    ...overrides,
  };
}

function makeMessages(system: string, firstUser: string, extra: NormalisedMessage[] = []): NormalisedMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: firstUser },
    ...extra,
  ];
}

describe('MemoryCache', () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = new MemoryCache(3, 1000); // small capacity + 1s TTL for testing
  });

  describe('deriveKey', () => {
    it('produces same key for same system+first user', () => {
      const msgs1 = makeMessages('sys', 'hello');
      const msgs2 = makeMessages('sys', 'hello', [
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'follow up' },
      ]);
      expect(cache.deriveKey(msgs1)).toBe(cache.deriveKey(msgs2));
    });

    it('produces different key for different first user message', () => {
      const msgs1 = makeMessages('sys', 'hello');
      const msgs2 = makeMessages('sys', 'goodbye');
      expect(cache.deriveKey(msgs1)).not.toBe(cache.deriveKey(msgs2));
    });

    it('produces different key for different system prompt', () => {
      const msgs1 = makeMessages('system A', 'hello');
      const msgs2 = makeMessages('system B', 'hello');
      expect(cache.deriveKey(msgs1)).not.toBe(cache.deriveKey(msgs2));
    });
  });

  describe('get/set', () => {
    it('returns undefined on cache miss', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('returns entry on cache hit', () => {
      const memory = makeMemory();
      cache.set('key1', { memory, messageCount: 2, lastAccess: Date.now() });
      const entry = cache.get('key1');
      expect(entry).toBeDefined();
      expect(entry!.memory.current_goal).toBe('test goal');
    });

    it('updates lastAccess on get (LRU)', () => {
      const oldTime = Date.now() - 500;
      cache.set('key1', { memory: makeMemory(), messageCount: 2, lastAccess: oldTime });
      const entry = cache.get('key1');
      expect(entry!.lastAccess).toBeGreaterThan(oldTime);
    });
  });

  describe('TTL expiry', () => {
    it('returns undefined for expired entries', () => {
      const expired = Date.now() - 2000; // 2s ago, TTL is 1s
      cache.set('key1', { memory: makeMemory(), messageCount: 2, lastAccess: expired });
      expect(cache.get('key1')).toBeUndefined();
    });

    it('returns entry for fresh entries', () => {
      cache.set('key1', { memory: makeMemory(), messageCount: 2, lastAccess: Date.now() });
      expect(cache.get('key1')).toBeDefined();
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entry when at capacity', () => {
      const now = Date.now();
      cache.set('oldest', { memory: makeMemory({ current_goal: 'oldest' }), messageCount: 1, lastAccess: now - 300 });
      cache.set('middle', { memory: makeMemory({ current_goal: 'middle' }), messageCount: 1, lastAccess: now - 200 });
      cache.set('newest', { memory: makeMemory({ current_goal: 'newest' }), messageCount: 1, lastAccess: now - 100 });

      // Cache is full (3 entries). Adding a 4th should evict 'oldest'.
      cache.set('extra', { memory: makeMemory({ current_goal: 'extra' }), messageCount: 1, lastAccess: now });

      expect(cache.get('oldest')).toBeUndefined();
      expect(cache.get('middle')).toBeDefined();
      expect(cache.get('newest')).toBeDefined();
      expect(cache.get('extra')).toBeDefined();
    });

    it('does not evict when updating existing key', () => {
      const now = Date.now();
      cache.set('a', { memory: makeMemory({ current_goal: 'a' }), messageCount: 1, lastAccess: now - 200 });
      cache.set('b', { memory: makeMemory({ current_goal: 'b' }), messageCount: 1, lastAccess: now - 100 });
      cache.set('c', { memory: makeMemory({ current_goal: 'c' }), messageCount: 1, lastAccess: now });

      // Update existing key — should not evict anything
      cache.set('b', { memory: makeMemory({ current_goal: 'b-updated' }), messageCount: 2, lastAccess: now });

      expect(cache.get('a')).toBeDefined();
      expect(cache.get('b')!.memory.current_goal).toBe('b-updated');
      expect(cache.get('c')).toBeDefined();
    });
  });

  describe('update', () => {
    it('updates existing entry', () => {
      cache.set('key1', { memory: makeMemory({ current_goal: 'old' }), messageCount: 2, lastAccess: Date.now() - 500 });

      const newMemory = makeMemory({ current_goal: 'new' });
      cache.update('key1', newMemory, 4);

      const entry = cache.get('key1');
      expect(entry!.memory.current_goal).toBe('new');
      expect(entry!.messageCount).toBe(4);
    });

    it('creates entry if key does not exist', () => {
      cache.update('new-key', makeMemory({ current_goal: 'created' }), 1);
      const entry = cache.get('new-key');
      expect(entry).toBeDefined();
      expect(entry!.memory.current_goal).toBe('created');
    });
  });

  describe('replay detection (messageCount)', () => {
    it('same messageCount means no new messages (replay)', () => {
      const memory = makeMemory();
      cache.set('key1', { memory, messageCount: 3, lastAccess: Date.now() });

      const entry = cache.get('key1');
      // Simulate: current request has 3 user/assistant messages — same as cached
      const currentCount = 3;
      expect(currentCount <= entry!.messageCount).toBe(true);
    });

    it('higher messageCount means new messages exist', () => {
      const memory = makeMemory();
      cache.set('key1', { memory, messageCount: 3, lastAccess: Date.now() });

      const entry = cache.get('key1');
      const currentCount = 5;
      expect(currentCount > entry!.messageCount).toBe(true);
    });
  });
});
