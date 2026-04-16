import { readFileSync } from 'node:fs';
import type { CapturedLine } from './console-capture.js';
import { getCapturedLines } from './console-capture.js';

export class LogViewer {
  private traceFile: string;
  scrollOffset = 0;

  constructor(traceFile: string) {
    this.traceFile = traceFile;
  }

  scrollUp(n = 3): void {
    this.scrollOffset += n;
  }

  scrollDown(n = 3): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - n);
  }

  resetScroll(): void {
    this.scrollOffset = 0;
  }

  /** Get all log lines (captured console + trace file), sorted by time, newest last. */
  getLines(): CapturedLine[] {
    const captured = getCapturedLines();
    // Also read trace file entries as log lines
    const traceLines = this.readTraceFile();
    // Merge by timestamp
    const all = [...captured, ...traceLines];
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }

  private readTraceFile(): CapturedLine[] {
    try {
      const content = readFileSync(this.traceFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      // Take last 200 entries max
      return lines.slice(-200).map((line) => {
        let ts = Date.now();
        try {
          const parsed = JSON.parse(line);
          if (parsed.timestamp) ts = new Date(parsed.timestamp).getTime();
        } catch {
          /* use current time */
        }
        return { timestamp: ts, level: 'log' as const, text: line };
      });
    } catch {
      return [];
    }
  }
}
