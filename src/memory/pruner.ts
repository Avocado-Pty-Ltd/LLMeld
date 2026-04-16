import type { MemoryEntry, MemoryConfig } from './types.js';

/**
 * Parse a TTL string like '30d', '90d' into days. Returns Infinity for 'permanent'.
 */
function parseTTLDays(ttl: string): number {
  if (ttl === 'permanent') return Infinity;
  const match = ttl.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : 30;
}

/**
 * Check if an entry has expired based on its TTL.
 */
function isExpired(entry: MemoryEntry, now: Date): boolean {
  const ttlDays = parseTTLDays(entry.ttl);
  if (ttlDays === Infinity) return false;

  const entryDate = new Date(entry.date);
  if (isNaN(entryDate.getTime())) return false;

  const ageMs = now.getTime() - entryDate.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > ttlDays;
}

/**
 * Confidence score for eviction priority (lower = evicted first).
 */
function confidenceScore(confidence: MemoryEntry['confidence']): number {
  switch (confidence) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
  }
}

/**
 * Prune memory entries: remove expired, then evict by confidence if over cap.
 */
export function pruneEntries(entries: MemoryEntry[], config: MemoryConfig): MemoryEntry[] {
  const now = new Date();

  // Phase 1: Remove expired entries
  let pruned = entries.filter((e) => !isExpired(e, now));

  // Phase 2: If still over max_entries, evict by confidence (lowest first), then oldest
  if (pruned.length > config.max_entries) {
    pruned.sort((a, b) => {
      // Lower confidence evicted first
      const confDiff = confidenceScore(a.confidence) - confidenceScore(b.confidence);
      if (confDiff !== 0) return confDiff;
      // Older entries evicted first
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });

    // Keep only the most valuable entries (end of sorted array)
    pruned = pruned.slice(pruned.length - config.max_entries);
  }

  return pruned;
}
