import type { MemoryEntry, MemoryEntryType, MemoryConfidence, MemorySource, MemoryFile } from './types.js';
import { MEMORY_SECTIONS } from './types.js';

const SECTION_TO_TYPE: Record<string, MemoryEntryType> = Object.fromEntries(
  Object.entries(MEMORY_SECTIONS).map(([type, name]) => [name, type as MemoryEntryType]),
);

const METADATA_RE = /<!--\s*type:\s*(\w+)\s*\|\s*confidence:\s*(\w+)\s*\|\s*source:\s*(\w+)\s*\|\s*ttl:\s*(\S+)\s*-->/;
const ENTRY_HEADING_RE = /^###\s+\[(.+?)\]\s+(.+)$/;

/**
 * Parse a memory markdown file into structured entries.
 */
export function parseMemoryFile(content: string): MemoryFile {
  const entries: MemoryEntry[] = [];
  const lines = content.split('\n');

  let currentSection: MemoryEntryType | null = null;
  let currentEntry: Partial<MemoryEntry> | null = null;
  let bodyLines: string[] = [];

  const flushEntry = () => {
    if (currentEntry && currentEntry.type && currentEntry.title && currentEntry.date) {
      entries.push({
        type: currentEntry.type,
        title: currentEntry.title,
        body: bodyLines.join('\n').trim(),
        date: currentEntry.date,
        confidence: currentEntry.confidence ?? 'medium',
        source: currentEntry.source ?? 'auto',
        ttl: currentEntry.ttl ?? '30d',
      });
    }
    currentEntry = null;
    bodyLines = [];
  };

  for (const line of lines) {
    // Detect section headers (## Project Knowledge, etc.)
    if (line.startsWith('## ')) {
      flushEntry();
      const sectionName = line.slice(3).trim();
      currentSection = SECTION_TO_TYPE[sectionName] ?? null;
      continue;
    }

    // Detect entry headers (### [date] Title)
    const headingMatch = line.match(ENTRY_HEADING_RE);
    if (headingMatch && currentSection) {
      flushEntry();
      currentEntry = {
        type: currentSection,
        date: headingMatch[1],
        title: headingMatch[2],
      };
      continue;
    }

    // Detect metadata comment
    const metaMatch = line.match(METADATA_RE);
    if (metaMatch && currentEntry) {
      currentEntry.confidence = metaMatch[2] as MemoryConfidence;
      currentEntry.source = metaMatch[3] as MemorySource;
      currentEntry.ttl = metaMatch[4];
      continue;
    }

    // Accumulate body lines
    if (currentEntry) {
      bodyLines.push(line);
    }
  }

  flushEntry();
  return { entries };
}

/**
 * Serialize memory entries back to markdown format.
 */
export function serializeMemoryFile(file: MemoryFile): string {
  const sections = new Map<MemoryEntryType, MemoryEntry[]>();

  for (const entry of file.entries) {
    const list = sections.get(entry.type) ?? [];
    list.push(entry);
    sections.set(entry.type, list);
  }

  const parts: string[] = ['# LLMeld Shared Memory\n'];
  const sectionOrder: MemoryEntryType[] = ['project', 'vocabulary', 'orchestration', 'learning', 'conversation'];

  for (const type of sectionOrder) {
    const sectionEntries = sections.get(type);
    if (!sectionEntries || sectionEntries.length === 0) continue;

    parts.push(`## ${MEMORY_SECTIONS[type]}\n`);

    for (const entry of sectionEntries) {
      parts.push(`### [${entry.date}] ${entry.title}`);
      parts.push(`<!-- type: ${entry.type} | confidence: ${entry.confidence} | source: ${entry.source} | ttl: ${entry.ttl} -->`);
      if (entry.body) {
        parts.push(entry.body);
      }
      parts.push('');
    }
  }

  return parts.join('\n').trimEnd() + '\n';
}

/**
 * Rough token estimate for a string (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
