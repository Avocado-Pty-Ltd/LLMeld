import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CloudProvider } from '../providers/base.js';
import type { OrchestrationTrace } from '../orchestrator/loop.js';
import type { MemoryConfig, MemoryEntry, MemoryEntryType, MemoryFile } from './types.js';
import { INJECTION_PRIORITY, MEMORY_SECTIONS } from './types.js';
import { parseMemoryFile, serializeMemoryFile, estimateTokens } from './format.js';
import { pruneEntries } from './pruner.js';
import { extractMemoryEntries, type ExtractionInput } from './extractor.js';

export class MemoryManager {
  private memoryFile: MemoryFile = { entries: [] };
  private loaded = false;

  constructor(
    private config: MemoryConfig,
    private extractionProvider?: CloudProvider,
  ) {}

  /**
   * Load memory from disk. Safe to call multiple times — caches after first load.
   */
  load(): void {
    if (this.loaded) return;
    try {
      const content = readFileSync(this.config.file_path, 'utf-8');
      this.memoryFile = parseMemoryFile(content);
    } catch {
      // File doesn't exist yet — start empty
      this.memoryFile = { entries: [] };
    }
    this.loaded = true;
  }

  /**
   * Get a memory injection block for the planner (full token budget).
   */
  getPlannerInjection(): string {
    this.load();
    return this.buildInjectionBlock(this.config.max_inject_tokens);
  }

  /**
   * Get a memory injection block for the executor (half token budget).
   * Prioritises vocabulary > project > orchestration.
   */
  getExecutorInjection(): string {
    this.load();
    return this.buildInjectionBlock(Math.floor(this.config.max_inject_tokens / 2));
  }

  /**
   * Get a memory injection block for direct-path requests (full token budget).
   */
  getDirectInjection(): string {
    this.load();
    return this.buildInjectionBlock(this.config.max_inject_tokens);
  }

  /**
   * Extract and save memory entries from a request/response cycle.
   * Runs async — does not block the response.
   */
  async extractAndSave(input: ExtractionInput): Promise<void> {
    if (!this.config.auto_extract || !this.extractionProvider) return;

    try {
      const newEntries = await extractMemoryEntries(this.extractionProvider, input);
      if (newEntries.length === 0) return;

      this.load();

      // Dedup: skip entries with very similar titles
      const existing = this.memoryFile.entries;
      const deduped = newEntries.filter((ne) =>
        !existing.some((e) => e.type === ne.type && isSimilarTitle(e.title, ne.title)),
      );

      if (deduped.length === 0) return;

      // Add new entries and prune
      const combined = [...existing, ...deduped];
      this.memoryFile.entries = pruneEntries(combined, this.config);

      this.save();
    } catch {
      // Extraction failure should never crash the system
    }
  }

  /**
   * Build prioritised injection block within a token budget.
   */
  private buildInjectionBlock(maxTokens: number): string {
    if (this.memoryFile.entries.length === 0) return '';

    const parts: string[] = ['## Shared Memory'];
    let currentTokens = estimateTokens(parts[0]);

    for (const type of INJECTION_PRIORITY) {
      const entries = this.memoryFile.entries
        .filter((e) => e.type === type)
        .sort((a, b) => {
          // High confidence first
          const confOrder = { high: 0, medium: 1, low: 2 };
          const confDiff = confOrder[a.confidence] - confOrder[b.confidence];
          if (confDiff !== 0) return confDiff;
          // Most recent first
          return new Date(b.date).getTime() - new Date(a.date).getTime();
        });

      if (entries.length === 0) continue;

      const sectionHeader = `\n### ${MEMORY_SECTIONS[type]}`;
      const sectionTokens = estimateTokens(sectionHeader);

      if (currentTokens + sectionTokens > maxTokens) break;

      let sectionAdded = false;

      for (const entry of entries) {
        const entryText = `\n- **${entry.title}**: ${entry.body}`;
        const entryTokens = estimateTokens(entryText);

        if (currentTokens + (sectionAdded ? 0 : sectionTokens) + entryTokens > maxTokens) break;

        if (!sectionAdded) {
          parts.push(sectionHeader);
          currentTokens += sectionTokens;
          sectionAdded = true;
        }

        parts.push(entryText);
        currentTokens += entryTokens;
      }
    }

    // Only return block if we actually included entries beyond the header
    return parts.length > 1 ? parts.join('') : '';
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.config.file_path), { recursive: true });
      writeFileSync(this.config.file_path, serializeMemoryFile(this.memoryFile));
    } catch {
      // Save failure should not crash the system
    }
  }
}

/**
 * Simple title similarity check — normalise and compare.
 */
function isSimilarTitle(a: string, b: string): boolean {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = normalise(a);
  const nb = normalise(b);
  if (na === nb) return true;
  // Check if one contains the other (covers minor rephrasing)
  if (na.length > 10 && nb.length > 10) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}
