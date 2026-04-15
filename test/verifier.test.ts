import { describe, it, expect } from 'vitest';
import { verifyStep } from '../src/orchestrator/verifier.js';
import type { PlanStep, StepResult } from '../src/types/plan.js';

const makeStep = (overrides?: Partial<PlanStep>): PlanStep => ({
  id: 'step-1',
  title: 'Test step',
  instruction: 'Write a function called processData',
  expected_output: 'A function named `processData` that takes an array and returns filtered results',
  depends_on: [],
  escalate_if_fails: false,
  allow_local: true,
  ...overrides,
});

const makeResult = (overrides?: Partial<StepResult>): StepResult => ({
  step_id: 'step-1',
  output: 'function processData(arr) { return arr.filter(x => x > 0); }',
  confidence: 'high',
  issues: [],
  tokens_used: 100,
  ...overrides,
});

describe('verifyStep', () => {
  it('passes a good result', () => {
    const result = verifyStep(makeStep(), makeResult());
    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('fails on empty output', () => {
    const result = verifyStep(makeStep(), makeResult({ output: '' }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('empty'))).toBe(true);
  });

  it('fails on low confidence', () => {
    const result = verifyStep(makeStep(), makeResult({ confidence: 'low' }));
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('low confidence'))).toBe(true);
  });

  it('flags missing code when code is expected', () => {
    const step = makeStep({ instruction: 'Implement a sorting function' });
    const result = verifyStep(step, makeResult({ output: 'I think you should use quicksort.' }));
    expect(result.passed).toBe(false);
  });

  it('passes when code output looks like code', () => {
    const step = makeStep({
      instruction: 'Implement a sorting function',
      expected_output: 'A sorting function that takes an array',
    });
    const result = verifyStep(step, makeResult({
      output: 'function sort(arr) { return arr.sort((a, b) => a - b); }',
    }));
    expect(result.passed).toBe(true);
  });
});
