import type { CloudProvider } from '../providers/base.js';
import type { NormalisedLLMRequest, NormalisedLLMResponse } from '../types/normalised.js';
import type { RoutingConfig } from '../types/config.js';
import type { ExecutionPlan, StepResult } from '../types/plan.js';
import { Planner } from './planner.js';
import { Executor } from './executor.js';
import { verifyStep } from './verifier.js';
import { v4 as uuidv4 } from 'uuid';

export interface OrchestrationTrace {
  trace_id: string;
  plan?: ExecutionPlan;
  step_results: Array<{
    step_id: string;
    attempt: number;
    passed: boolean;
    escalated: boolean;
    tokens_used: number;
  }>;
  total_tokens: number;
  error?: string;
}

export class OrchestrationLoop {
  private planner: Planner;
  private executor: Executor;
  private fallbackExecutor?: Executor;

  constructor(
    plannerProvider: CloudProvider,
    executorProvider: CloudProvider,
    private routingConfig: RoutingConfig,
    fallbackProvider?: CloudProvider,
  ) {
    this.planner = new Planner(plannerProvider);
    this.executor = new Executor(executorProvider);
    if (fallbackProvider) {
      this.fallbackExecutor = new Executor(fallbackProvider);
    }
  }

  async execute(req: NormalisedLLMRequest): Promise<{
    response: NormalisedLLMResponse;
    trace: OrchestrationTrace;
  }> {
    const trace: OrchestrationTrace = {
      trace_id: uuidv4(),
      step_results: [],
      total_tokens: 0,
    };

    let plan: ExecutionPlan;
    try {
      plan = await this.planner.createPlan(req);
      trace.plan = plan;
    } catch (err) {
      // If planner fails, retry once
      try {
        plan = await this.planner.createPlan(req);
        trace.plan = plan;
      } catch (retryErr) {
        trace.error = `Planner failed: ${retryErr instanceof Error ? retryErr.message : retryErr}`;
        // Degrade: send directly to planner provider as a regular chat
        return { response: await this.degradeToDirectCloud(req), trace };
      }
    }

    // Topological sort of steps by depends_on
    const sortedSteps = this.topologicalSort(plan.steps);

    // Execute steps
    const results: Map<string, StepResult> = new Map();
    const completedOutputs: Array<{ stepId: string; output: string }> = [];

    for (const step of sortedSteps) {
      const executor = step.allow_local ? this.executor : (this.fallbackExecutor ?? this.executor);

      let result: StepResult;
      let passed = false;
      let escalated = false;
      let attempts = 0;

      // Attempt execution
      for (let attempt = 0; attempt <= this.routingConfig.max_retries; attempt++) {
        attempts = attempt + 1;
        try {
          result = await executor.execute(step, plan.context_for_executor, completedOutputs);
          const verification = verifyStep(step, result);

          if (verification.passed) {
            passed = true;
            break;
          }

          // Last retry — try escalation
          if (attempt === this.routingConfig.max_retries) {
            if (step.escalate_if_fails && this.fallbackExecutor && executor !== this.fallbackExecutor) {
              if (!this.routingConfig.privacy_mode) {
                result = await this.fallbackExecutor.execute(
                  step,
                  plan.context_for_executor,
                  completedOutputs,
                );
                escalated = true;
                passed = true;
              }
            }
          }
        } catch (err) {
          // Execution error — try escalation
          if (step.escalate_if_fails && this.fallbackExecutor && !this.routingConfig.privacy_mode) {
            try {
              result = await this.fallbackExecutor.execute(
                step,
                plan.context_for_executor,
                completedOutputs,
              );
              escalated = true;
              passed = true;
            } catch {
              // Escalation also failed — use whatever we have
            }
          }
          break;
        }
      }

      result ??= {
        step_id: step.id,
        output: '[Step failed to produce output]',
        confidence: 'low',
        issues: ['All execution attempts failed'],
        tokens_used: 0,
      };

      results.set(step.id, result);
      completedOutputs.push({ stepId: step.id, output: result.output });
      trace.step_results.push({
        step_id: step.id,
        attempt: attempts,
        passed,
        escalated,
        tokens_used: result.tokens_used,
      });
      trace.total_tokens += result.tokens_used;
    }

    // Synthesize final response
    const stepSummaries = sortedSteps.map((s) => ({
      title: s.title,
      output: results.get(s.id)?.output ?? '',
    }));

    const synthesizedContent = await this.planner.synthesize(
      req.messages,
      plan,
      stepSummaries,
    );

    const response: NormalisedLLMResponse = {
      id: `llmeld-${trace.trace_id}`,
      model: req.model,
      content: synthesizedContent,
      role: 'assistant',
      finish_reason: 'stop',
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: trace.total_tokens,
      },
    };

    return { response, trace };
  }

  private async degradeToDirectCloud(req: NormalisedLLMRequest): Promise<NormalisedLLMResponse> {
    // Fall back to using the planner provider as a regular chat model
    const provider = (this.planner as unknown as { provider: CloudProvider }).provider;
    return provider.createChatCompletion(req);
  }

  private topologicalSort(
    steps: ExecutionPlan['steps'],
  ): ExecutionPlan['steps'] {
    const visited = new Set<string>();
    const sorted: ExecutionPlan['steps'] = [];
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    const visit = (step: ExecutionPlan['steps'][0]) => {
      if (visited.has(step.id)) return;
      visited.add(step.id);
      for (const depId of step.depends_on) {
        const dep = stepMap.get(depId);
        if (dep) visit(dep);
      }
      sorted.push(step);
    };

    for (const step of steps) {
      visit(step);
    }

    return sorted;
  }
}
