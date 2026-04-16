import type { NormalisedLLMRequest } from '../types/normalised.js';
import type { RoutingConfig } from '../types/config.js';
import { classifyTask, estimateTokens } from './classifier.js';

export interface RouteDecision {
  path: 'direct' | 'planner-executor';
  provider: 'planner' | 'executor' | 'fallback';
  reason: string;
  task_type?: string;
}

export function decideRoute(
  req: NormalisedLLMRequest,
  config: RoutingConfig,
): RouteDecision {
  const mode = config.default_mode;

  // Deterministic modes
  if (mode === 'local') {
    return { path: 'direct', provider: 'executor', reason: 'local mode — all requests go to executor' };
  }

  if (mode === 'cloud') {
    return { path: 'direct', provider: 'planner', reason: 'cloud mode — all requests go to cloud' };
  }

  // Extract the last user message for classification
  const lastUserMsg = [...req.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUserMsg?.content ?? '';
  const totalText = req.messages.map((m) => m.content).join(' ');
  const tokens = estimateTokens(totalText);

  if (mode === 'fast') {
    // Only use planner if the request is clearly complex and long
    if (tokens > config.complex_threshold * 2) {
      return {
        path: 'planner-executor',
        provider: 'planner',
        reason: `fast mode but very high token count (${tokens})`,
      };
    }
    return { path: 'direct', provider: 'executor', reason: 'fast mode — prefer local execution' };
  }

  if (mode === 'best') {
    // Only skip planner for trivially simple requests
    if (tokens < config.simple_threshold && !req.tools?.length) {
      return { path: 'direct', provider: 'planner', reason: 'best mode — simple request, direct to cloud' };
    }
    return {
      path: 'planner-executor',
      provider: 'planner',
      reason: 'best mode — use planner for optimal quality',
    };
  }

  // Balanced mode — use classifier
  if (config.enable_task_classifier) {
    const result = classifyTask(userText, tokens, config);

    if (result.classification === 'complex' && result.confidence >= 0.6) {
      // Privacy mode blocks cloud escalation
      if (config.privacy_mode) {
        return {
          path: 'direct',
          provider: 'executor',
          reason: `complex task but privacy mode enabled (${result.reason})`,
        };
      }
      return {
        path: 'planner-executor',
        provider: 'planner',
        reason: `balanced mode — ${result.reason}`,
      };
    }

    return {
      path: 'direct',
      provider: 'executor',
      reason: `balanced mode — ${result.reason}`,
    };
  }

  // Classifier disabled — use token thresholds only
  if (tokens >= config.complex_threshold && !config.privacy_mode) {
    return {
      path: 'planner-executor',
      provider: 'planner',
      reason: `balanced mode — token count ${tokens} exceeds complex threshold`,
    };
  }

  return {
    path: 'direct',
    provider: 'executor',
    reason: `balanced mode — token count ${tokens} below complex threshold`,
  };
}
