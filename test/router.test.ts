import { describe, it, expect } from 'vitest';
import { decideRoute } from '../src/router/policy.js';
import { classifyTask, estimateTokens } from '../src/router/classifier.js';
import type { NormalisedLLMRequest } from '../src/types/normalised.js';
import type { RoutingConfig } from '../src/types/config.js';

const defaultRouting: RoutingConfig = {
  default_mode: 'balanced',
  simple_threshold: 500,
  complex_threshold: 1500,
  max_retries: 2,
  enable_task_classifier: true,
  privacy_mode: false,
  complex_keywords: ['create', 'build', 'implement', 'architect', 'refactor', 'design'],
  simple_keywords: ['what is', 'define', 'explain briefly'],
};

function makeReq(content: string): NormalisedLLMRequest {
  return {
    model: 'test',
    messages: [{ role: 'user', content }],
  };
}

describe('classifyTask', () => {
  it('classifies simple questions', () => {
    const result = classifyTask('what is a monad?', 20, defaultRouting);
    expect(result.classification).toBe('simple');
  });

  it('classifies complex tasks', () => {
    const result = classifyTask('implement a JWT auth system and refactor the middleware', 500, defaultRouting);
    expect(result.classification).toBe('complex');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('uses token count for ambiguous cases', () => {
    const result = classifyTask('help me with this code', 100, defaultRouting);
    expect(result.classification).toBe('simple');
  });
});

describe('estimateTokens', () => {
  it('estimates roughly 4 chars per token', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75 → 3
  });
});

describe('decideRoute', () => {
  it('routes to executor in local mode', () => {
    const result = decideRoute(makeReq('anything'), { ...defaultRouting, default_mode: 'local' });
    expect(result.path).toBe('direct');
    expect(result.provider).toBe('executor');
  });

  it('routes to planner in cloud mode', () => {
    const result = decideRoute(makeReq('anything'), { ...defaultRouting, default_mode: 'cloud' });
    expect(result.path).toBe('direct');
    expect(result.provider).toBe('planner');
  });

  it('prefers direct in fast mode for normal requests', () => {
    const result = decideRoute(makeReq('fix this bug'), { ...defaultRouting, default_mode: 'fast' });
    expect(result.path).toBe('direct');
  });

  it('uses planner-executor for complex tasks in balanced mode', () => {
    const result = decideRoute(
      makeReq('implement a new authentication system and refactor the database layer'),
      defaultRouting,
    );
    expect(result.path).toBe('planner-executor');
  });

  it('uses direct path for simple questions in balanced mode', () => {
    const result = decideRoute(makeReq('what is TypeScript?'), defaultRouting);
    expect(result.path).toBe('direct');
  });

  it('respects privacy mode — blocks cloud escalation', () => {
    const result = decideRoute(
      makeReq('implement a new feature and design the architecture'),
      { ...defaultRouting, privacy_mode: true },
    );
    expect(result.path).toBe('direct');
    expect(result.provider).toBe('executor');
  });

  it('uses planner heavily in best mode', () => {
    const result = decideRoute(
      {
        model: 'test',
        messages: [{ role: 'user', content: 'here is a long request with lots of context about my codebase' }],
        tools: [{ type: 'function', function: { name: 'read_file' } }],
      },
      { ...defaultRouting, default_mode: 'best' },
    );
    expect(result.path).toBe('planner-executor');
  });
});
