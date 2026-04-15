import type { PlanStep, StepResult } from '../types/plan.js';

export interface VerificationResult {
  passed: boolean;
  reasons: string[];
}

export function verifyStep(step: PlanStep, result: StepResult): VerificationResult {
  const reasons: string[] = [];

  // Check for empty/trivial output
  if (!result.output || result.output.trim().length < 10) {
    reasons.push('Output is empty or trivially short');
  }

  // Check confidence
  if (result.confidence === 'low') {
    reasons.push('Executor reported low confidence');
  }

  // Check for reported issues
  if (result.issues.length > 0) {
    reasons.push(`Executor reported issues: ${result.issues.join('; ')}`);
  }

  // Structural checks for code output
  if (isCodeExpected(step)) {
    if (!containsCodeBlock(result.output) && !looksLikeCode(result.output)) {
      reasons.push('Expected code output but none detected');
    }
  }

  // Check that output references key terms from expected_output
  if (step.expected_output) {
    const keyTerms = extractKeyTerms(step.expected_output);
    const missingTerms = keyTerms.filter(
      (term) => !result.output.toLowerCase().includes(term.toLowerCase()),
    );
    if (missingTerms.length > keyTerms.length / 2 && keyTerms.length > 0) {
      reasons.push(`Output may not match expectations — missing key terms: ${missingTerms.join(', ')}`);
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
  };
}

function isCodeExpected(step: PlanStep): boolean {
  const codeIndicators = [
    'function', 'implement', 'write code', 'create a', 'write a',
    'modify', 'update the code', 'refactor', 'add a method',
  ];
  const lower = (step.instruction + ' ' + step.expected_output).toLowerCase();
  return codeIndicators.some((ind) => lower.includes(ind));
}

function containsCodeBlock(text: string): boolean {
  return /```[\s\S]*?```/.test(text);
}

function looksLikeCode(text: string): boolean {
  const codePatterns = [
    /function\s+\w+/, /const\s+\w+\s*=/, /class\s+\w+/,
    /def\s+\w+/, /import\s+/, /export\s+/,
    /if\s*\(/, /for\s*\(/, /while\s*\(/,
    /=>\s*{/, /\{\s*\n/,
  ];
  return codePatterns.some((p) => p.test(text));
}

function extractKeyTerms(text: string): string[] {
  // Extract quoted terms and function/variable-like names
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const backticked = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const camelCase = [...text.matchAll(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g)].map((m) => m[0]);
  const snakeCase = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]);

  return [...new Set([...quoted, ...backticked, ...camelCase, ...snakeCase])].slice(0, 10);
}
