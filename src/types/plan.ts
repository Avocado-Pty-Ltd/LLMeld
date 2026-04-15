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
}
