export interface ExecutionPlan {
  goal: string;
  acceptance_criteria: string[];
  steps: PlanStep[];
  context_for_executor: string;
  estimated_complexity: 'low' | 'medium' | 'high';
}

export interface PlanStep {
  id: string;
  title: string;
  instruction: string;
  expected_output: string;
  depends_on: string[];
  escalate_if_fails: boolean;
  allow_local: boolean;
}

export interface StepResult {
  step_id: string;
  output: string;
  confidence: 'high' | 'medium' | 'low';
  issues: string[];
  tokens_used: number;
  /** Tool calls made during execution — preserved for context sharing */
  tool_log?: string[];
  /** Files that were read or written during execution */
  files_touched?: string[];
}

export type ProgressEvent =
  | { stage: 'planning'; message: string }
  | { stage: 'plan_ready'; plan: ExecutionPlan }
  | { stage: 'step_start'; stepIndex: number; totalSteps: number; step: PlanStep }
  | { stage: 'step_complete'; stepId: string; passed: boolean; tokens: number; elapsed_ms: number }
  | { stage: 'step_retry'; stepId: string; attempt: number }
  | { stage: 'step_escalated'; stepId: string }
  | { stage: 'tool_call'; stepId: string; tool: string; args: string }
  | { stage: 'tool_result'; stepId: string; tool: string; truncated: boolean }
  | { stage: 'synthesizing'; message: string }
  | { stage: 'done' };
