import type { RoutingConfig } from '../types/config.js';

export interface ClassificationResult {
  classification: 'simple' | 'complex';
  confidence: number;
  reason: string;
}

export function classifyTask(
  userMessage: string,
  estimatedTokens: number,
  config: RoutingConfig,
): ClassificationResult {
  const lower = String(userMessage ?? '').toLowerCase();

  // Check simple keywords first
  for (const keyword of config.simple_keywords) {
    if (lower.includes(keyword.toLowerCase())) {
      return { classification: 'simple', confidence: 0.8, reason: `matches simple keyword "${keyword}"` };
    }
  }

  // Check complex keywords
  let complexMatches = 0;
  const matched: string[] = [];
  for (const keyword of config.complex_keywords) {
    if (lower.includes(keyword.toLowerCase())) {
      complexMatches++;
      matched.push(keyword);
    }
  }

  if (complexMatches >= 2) {
    return {
      classification: 'complex',
      confidence: 0.9,
      reason: `matches multiple complex keywords: ${matched.join(', ')}`,
    };
  }

  if (complexMatches === 1) {
    // Single complex keyword — check token count to tip the balance
    if (estimatedTokens > config.complex_threshold) {
      return {
        classification: 'complex',
        confidence: 0.7,
        reason: `matches complex keyword "${matched[0]}" and high token count (${estimatedTokens})`,
      };
    }
    return {
      classification: 'complex',
      confidence: 0.6,
      reason: `matches complex keyword "${matched[0]}"`,
    };
  }

  // No keyword matches — use token thresholds
  if (estimatedTokens <= config.simple_threshold) {
    return { classification: 'simple', confidence: 0.7, reason: `low token count (${estimatedTokens})` };
  }

  if (estimatedTokens >= config.complex_threshold) {
    return { classification: 'complex', confidence: 0.6, reason: `high token count (${estimatedTokens})` };
  }

  // In between thresholds — default to simple (lower latency)
  return { classification: 'simple', confidence: 0.5, reason: 'ambiguous, defaulting to simple' };
}

/**
 * Rough token count estimate: ~4 chars per token for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
