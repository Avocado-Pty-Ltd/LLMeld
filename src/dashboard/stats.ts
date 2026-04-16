import { EventEmitter } from 'node:events';
import type { RequestTrace } from '../logger/trace.js';

export interface RecentRequest {
  timestamp: string;
  surface: 'openai' | 'anthropic';
  path: 'direct' | 'planner-executor';
  provider: string;
  taskType: string;
  latencyMs: number;
  tokens: number;
  error?: string;
}

export interface DashboardStats {
  totalRequests: number;
  totalErrors: number;
  totalTokens: number;
  latencySum: number;
  byRoute: { direct: number; 'planner-executor': number };
  byProvider: { planner: number; executor: number; fallback: number };
  byTaskType: { coding: number; general: number; unknown: number };
  bySurface: { openai: number; anthropic: number };
  recentRequests: RecentRequest[];
}

export class StatsCollector extends EventEmitter {
  private stats: DashboardStats;
  readonly startTime = Date.now();

  constructor() {
    super();
    this.stats = this.emptyStats();
  }

  recordRequest(trace: RequestTrace): void {
    this.stats.totalRequests++;
    this.stats.latencySum += trace.latency_ms;
    this.stats.totalTokens += trace.orchestration?.total_tokens ?? 0;
    if (trace.error) this.stats.totalErrors++;

    this.stats.byRoute[trace.route_decision.path]++;
    this.stats.byProvider[trace.route_decision.provider as keyof DashboardStats['byProvider']]++;
    this.stats.bySurface[trace.surface]++;

    const taskType = (trace.route_decision.task_type ?? 'unknown') as keyof DashboardStats['byTaskType'];
    this.stats.byTaskType[taskType]++;

    this.stats.recentRequests.unshift({
      timestamp: trace.timestamp,
      surface: trace.surface,
      path: trace.route_decision.path,
      provider: trace.route_decision.provider,
      taskType,
      latencyMs: trace.latency_ms,
      tokens: trace.orchestration?.total_tokens ?? 0,
      error: trace.error,
    });

    if (this.stats.recentRequests.length > 50) {
      this.stats.recentRequests.pop();
    }

    this.emit('update');
  }

  getStats(): DashboardStats {
    return this.stats;
  }

  clear(): void {
    this.stats = this.emptyStats();
    this.emit('update');
  }

  private emptyStats(): DashboardStats {
    return {
      totalRequests: 0,
      totalErrors: 0,
      totalTokens: 0,
      latencySum: 0,
      byRoute: { direct: 0, 'planner-executor': 0 },
      byProvider: { planner: 0, executor: 0, fallback: 0 },
      byTaskType: { coding: 0, general: 0, unknown: 0 },
      bySurface: { openai: 0, anthropic: 0 },
      recentRequests: [],
    };
  }
}
