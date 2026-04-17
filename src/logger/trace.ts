import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoggingConfig } from '../types/config.js';

export interface RequestTrace {
  trace_id: string;
  timestamp: string;
  surface: 'openai' | 'anthropic';
  iterations: number;
  tool_calls: Array<{ name: string; truncated: boolean }>;
  latency_ms: number;
  error?: string;
}

export class TraceLogger {
  private traceFile: string;
  private level: string;
  private format: string;
  private emitCosts: boolean;

  constructor(config: LoggingConfig) {
    this.traceFile = config.trace_file;
    this.level = config.level;
    this.format = config.format;
    this.emitCosts = config.emit_token_costs;

    // Ensure log directory exists
    try {
      mkdirSync(dirname(this.traceFile), { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  logRequest(trace: RequestTrace): void {
    // Write to trace file
    try {
      appendFileSync(this.traceFile, JSON.stringify(trace) + '\n');
    } catch {
      // Log file write failure shouldn't crash the server
    }

    // Console output
    if (this.format === 'pretty') {
      this.prettyLog(trace);
    } else {
      console.log(JSON.stringify(trace));
    }
  }

  log(level: string, message: string, data?: Record<string, unknown>): void {
    const levels = ['debug', 'info', 'warn', 'error'];
    if (levels.indexOf(level) < levels.indexOf(this.level)) return;

    if (this.format === 'pretty') {
      const prefix = level === 'error' ? '!' : level === 'warn' ? '?' : '-';
      console.log(`[llmeld] ${prefix} ${message}`, data ? JSON.stringify(data) : '');
    } else {
      console.log(JSON.stringify({ level, msg: message, ...data, time: new Date().toISOString() }));
    }
  }

  private prettyLog(trace: RequestTrace): void {
    const toolsStr = trace.tool_calls.length > 0
      ? ` [${trace.tool_calls.length} tool calls]`
      : '';
    const errStr = trace.error ? ` ERROR: ${trace.error}` : '';

    console.log(
      `[llmeld] ${trace.surface} | ${trace.iterations} iterations | ${trace.latency_ms}ms${toolsStr}${errStr}`,
    );
  }
}
