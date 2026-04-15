import { describe, it, expect } from 'vitest';
import { fromOpenAI } from '../src/normaliser/from-openai.js';
import { fromAnthropic } from '../src/normaliser/from-anthropic.js';
import { toOpenAIChatCompletion, toOpenAIModelList } from '../src/normaliser/to-openai.js';
import { toAnthropicMessages } from '../src/normaliser/to-anthropic.js';
import type { NormalisedLLMResponse } from '../src/types/normalised.js';

describe('fromOpenAI', () => {
  it('normalises a basic chat request', () => {
    const result = fromOpenAI({
      model: 'llmeld/planner-executor',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ],
    });

    expect(result.model).toBe('llmeld/planner-executor');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[1].role).toBe('user');
    expect(result.messages[1].content).toBe('Hello');
  });

  it('normalises stop as array', () => {
    const result = fromOpenAI({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
      stop: 'STOP',
    });
    expect(result.stop).toEqual(['STOP']);
  });

  it('passes through tools', () => {
    const result = fromOpenAI({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{
        type: 'function',
        function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
      }],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].function.name).toBe('get_weather');
  });
});

describe('fromAnthropic', () => {
  it('normalises a basic Anthropic request', () => {
    const result = fromAnthropic({
      model: 'claude-3-opus',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 1024,
      system: 'You are helpful',
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('You are helpful');
    expect(result.messages[1].role).toBe('user');
    expect(result.max_tokens).toBe(1024);
  });

  it('handles content block arrays', () => {
    const result = fromAnthropic({
      model: 'claude-3-opus',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me help' },
          { type: 'tool_use', id: 'toolu_123', name: 'search', input: { q: 'test' } },
        ],
      }],
      max_tokens: 1024,
    });

    expect(result.messages[0].content).toBe('Let me help');
    expect(result.messages[0].tool_calls).toHaveLength(1);
    expect(result.messages[0].tool_calls![0].function.name).toBe('search');
  });
});

describe('toOpenAIChatCompletion', () => {
  const baseResponse: NormalisedLLMResponse = {
    id: 'test-123',
    model: 'internal-model',
    content: 'Hello there!',
    role: 'assistant',
    finish_reason: 'stop',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it('formats as OpenAI response with alias', () => {
    const result = toOpenAIChatCompletion(baseResponse, 'llmeld/planner-executor');
    expect(result.model).toBe('llmeld/planner-executor');
    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('Hello there!');
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  it('includes tool calls when present', () => {
    const withTools: NormalisedLLMResponse = {
      ...baseResponse,
      tool_calls: [{
        id: 'call_abc',
        type: 'function',
        function: { name: 'test', arguments: '{}' },
      }],
      finish_reason: 'tool_calls',
    };
    const result = toOpenAIChatCompletion(withTools, 'alias');
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
  });
});

describe('toAnthropicMessages', () => {
  const baseResponse: NormalisedLLMResponse = {
    id: 'test-123',
    model: 'internal-model',
    content: 'Hello there!',
    role: 'assistant',
    finish_reason: 'stop',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it('formats as Anthropic response', () => {
    const result = toAnthropicMessages(baseResponse, 'llmeld/planner-executor');
    expect(result.model).toBe('llmeld/planner-executor');
    expect(result.type).toBe('message');
    expect(result.role).toBe('assistant');
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Hello there!');
    expect(result.stop_reason).toBe('end_turn');
  });

  it('converts tool calls to tool_use blocks', () => {
    const withTools: NormalisedLLMResponse = {
      ...baseResponse,
      tool_calls: [{
        id: 'call_abc',
        type: 'function',
        function: { name: 'test', arguments: '{"x":1}' },
      }],
      finish_reason: 'tool_calls',
    };
    const result = toAnthropicMessages(withTools, 'alias');
    expect(result.content).toHaveLength(2);
    expect(result.content[1].type).toBe('tool_use');
    expect(result.content[1].id).toBe('toolu_abc');
    expect(result.stop_reason).toBe('tool_use');
  });
});

describe('toOpenAIModelList', () => {
  it('returns model list', () => {
    const result = toOpenAIModelList(['llmeld/planner-executor']);
    expect(result.object).toBe('list');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe('llmeld/planner-executor');
    expect(result.data[0].owned_by).toBe('llmeld');
  });
});
