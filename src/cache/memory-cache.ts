import { createHash } from 'crypto';
import type { WorkingMemory } from '../types/working-memory.js';
import type { NormalisedMessage } from '../types/normalised.js';

export interface CacheEntry {
  memory: WorkingMemory;
  messageCount: number;
  lastAccess: number;
}

export class MemoryCache {
  private store = new Map<string, CacheEntry>();
  private maxEntries: number;
  private ttlMs: number;

  constructor(maxEntries = 100, ttlMs = 30 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.lastAccess > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }

    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    // Evict oldest entry if at capacity
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of this.store) {
        if (v.lastAccess < oldestTime) {
          oldestTime = v.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, entry);
  }

  update(key: string, memory: WorkingMemory, messageCount: number): void {
    const existing = this.store.get(key);
    if (existing) {
      existing.memory = memory;
      existing.messageCount = messageCount;
      existing.lastAccess = Date.now();
    } else {
      this.set(key, { memory, messageCount, lastAccess: Date.now() });
    }
  }

  deriveKey(messages: NormalisedMessage[]): string {
    const systemContent = messages.find(m => m.role === 'system')?.content ?? '';
    const firstUser = messages.find(m => m.role === 'user')?.content ?? '';
    return createHash('sha256').update(systemContent + firstUser).digest('hex').slice(0, 16);
  }
}
