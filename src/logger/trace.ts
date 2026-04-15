import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoggingConfig } from '../types/config.js';
import type { RouteDecision } from '../router/policy.js';
import type { OrchestrationTrace } from '../orchestrator/loop.js';

export interface RequestTrace {
  trace_id: string;
  timestamp: string;
  surface: 'openai' | 'anthropic';
  route_decision: RouteDecision;
  orchestration?: OrchestrationTrace;
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
    const entry = {
      ...trace,
      ...(this.emitCosts && trace.orchestration
        ? { estimated_cost: this.estimateCost(trace.orchestration.total_tokens) }
        : {}),
    };

    // Write to trace file
    try {
      appendFileSync(this.traceFile, JSON.stringify(entry) + '\n');
    } catch {
      // Log file write failure shouldn't crash the server
    }

    // Console output
    if (this.format === 'pretty') {
      this.prettyLog(trace);
    } else {
      this.jsonLog(entry);
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
    const route = trace.route_decision;
    const steps = trace.orchestration?.step_results ?? [];
    const stepsStr = steps.length > 0
      ? ` [${steps.length} steps, ${steps.filter((s) => s.passed).length} passed]`
      : '';

    console.log(
      `[llmeld] ${trace.surface} | ${route.path} → ${route.provider} | ${trace.latency_ms}ms${stepsStr}`,
    );
  }

  private jsonLog(entry: Record<string, unknown>): void {
    console.log(JSON.stringify(entry));
  }

  private estimateCost(totalTokens: number): string {
    // Rough estimate: ~$0.003 per 1K tokens (blended average)
    const cost = (totalTokens / 1000) * 0.003;
    return `~$${cost.toFixed(4)}`;
  }
}
