import type { LLMeldConfig } from '../types/config.js';
import type { StatsCollector } from './stats.js';
import { renderStatsView, renderLogView } from './renderer.js';
import { setupKeyHandler, teardownKeyHandler } from './keyhandler.js';
import { LogViewer } from './log-viewer.js';

export class DashboardManager {
  private stats: StatsCollector;
  private config: LLMeldConfig;
  private mode: 'stats' | 'logs' = 'stats';
  private renderInterval: ReturnType<typeof setInterval> | null = null;
  private logViewer: LogViewer;
  private lastRender = 0;
  private renderQueued = false;

  constructor(stats: StatsCollector, config: LLMeldConfig) {
    this.stats = stats;
    this.config = config;
    this.logViewer = new LogViewer(config.logging.trace_file);
  }

  start(): void {
    // Hide cursor, clear screen
    process.stdout.write('\x1b[?25l\x1b[2J\x1b[H');

    setupKeyHandler({
      q: () => {
        this.stop();
        process.kill(process.pid, 'SIGINT');
      },
      l: () => {
        this.mode = this.mode === 'logs' ? 'stats' : 'logs';
        this.logViewer.resetScroll();
        this.render();
      },
      c: () => {
        this.stats.clear();
        this.render();
      },
      up: () => {
        if (this.mode === 'logs') {
          this.logViewer.scrollUp();
          this.render();
        }
      },
      down: () => {
        if (this.mode === 'logs') {
          this.logViewer.scrollDown();
          this.render();
        }
      },
    });

    // Re-render on stats update (debounced)
    this.stats.on('update', () => this.scheduleRender());

    // Re-render on terminal resize
    process.stdout.on('resize', () => this.render());

    // Periodic render for uptime counter
    this.renderInterval = setInterval(() => this.render(), 1000);
    this.render();
  }

  stop(): void {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
    teardownKeyHandler();
    // Show cursor, move below content
    process.stdout.write('\x1b[?25h\n');
  }

  private scheduleRender(): void {
    // Debounce: max 1 render per 100ms for bursts of requests
    if (this.renderQueued) return;
    const elapsed = Date.now() - this.lastRender;
    if (elapsed < 100) {
      this.renderQueued = true;
      setTimeout(() => {
        this.renderQueued = false;
        this.render();
      }, 100 - elapsed);
    } else {
      this.render();
    }
  }

  private render(): void {
    this.lastRender = Date.now();
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    let lines: string[];
    if (this.mode === 'stats') {
      const uptime = Date.now() - this.stats.startTime;
      lines = renderStatsView(this.stats.getStats(), this.config, uptime, cols, rows);
    } else {
      const logLines = this.logViewer.getLines();
      lines = renderLogView(logLines, this.logViewer.scrollOffset, cols, rows);
    }

    // Single write to avoid flicker — cursor home then full frame
    process.stdout.write('\x1b[H' + lines.join('\n'));
  }
}
