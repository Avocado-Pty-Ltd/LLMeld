export type MemoryEntryType = 'project' | 'vocabulary' | 'orchestration' | 'learning' | 'conversation';
export type MemoryConfidence = 'high' | 'medium' | 'low';
export type MemorySource = 'auto' | 'manual';

export interface MemoryEntry {
  type: MemoryEntryType;
  title: string;
  body: string;
  date: string;
  confidence: MemoryConfidence;
  source: MemorySource;
  ttl: 'permanent' | string; // 'permanent' or e.g. '30d', '90d'
}

export interface MemoryFile {
  entries: MemoryEntry[];
}

export interface MemoryConfig {
  enabled: boolean;
  file_path: string;
  max_inject_tokens: number;
  extraction_provider: 'executor' | 'planner' | 'fallback';
  max_entries: number;
  staleness_days: number;
  inject_on_direct: boolean;
  auto_extract: boolean;
}

/** Section name mapping for the memory file. */
export const MEMORY_SECTIONS: Record<MemoryEntryType, string> = {
  project: 'Project Knowledge',
  vocabulary: 'Shared Vocabulary',
  orchestration: 'Orchestration Hints',
  learning: 'Execution Learnings',
  conversation: 'Conversation Memory',
};

/** Default TTLs per entry type and confidence. */
export function getDefaultTTL(type: MemoryEntryType, confidence: MemoryConfidence): string {
  switch (type) {
    case 'project':
      return confidence === 'high' ? 'permanent' : '90d';
    case 'vocabulary':
      return 'permanent';
    case 'orchestration':
      return confidence === 'high' ? 'permanent' : '90d';
    case 'learning':
      return '30d';
    case 'conversation':
      return '30d';
  }
}

/** Injection priority order: vocabulary > project > orchestration > conversation > learning. */
export const INJECTION_PRIORITY: MemoryEntryType[] = [
  'vocabulary',
  'project',
  'orchestration',
  'conversation',
  'learning',
];
