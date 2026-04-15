# LLMeld — Software Specification (Updated with OpenRouter Support)

## Overview

LLMeld is an open-source Node.js/TypeScript server that exposes a **dual API surface** (OpenAI-compatible and Anthropic-compatible) and internally orchestrates a **cloud planner + local executor** architecture. Users of OpenClaw, Hermes, Claude Code, and any OpenAI-compatible web UI install and run one service, point their tool at it as a custom provider, and interact with a single model alias. Behind that alias the gateway decomposes complex tasks using a strong cloud model, delegates bounded subtasks to a local Ollama-hosted model, and reassembles results into one coherent response. OpenRouter is supported as a first-class upstream cloud provider for the planner, the fallback model, or both, using its OpenAI-compatible API surface and optional attribution headers.[cite:281][cite:296][cite:303]

## Project Identity

| Field | Value |
|---|---|
| Project name | `llmeld` |
| Runtime | Node.js 20+ / TypeScript |
| License | MIT |
| Public model alias | `llmeld/planner-executor` (configurable) |
| Default local backend | Ollama (`http://localhost:11434/v1`) |
| Default cloud backend | OpenRouter or Anthropic direct (configurable) |
| Default ports | OpenAI surface: `8000`, Anthropic surface: `8001` |

## Goals

1. Present a **single model surface** to downstream clients even when multiple upstream providers are involved.
2. Expose both **OpenAI-compatible** and **Anthropic-compatible** APIs so OpenClaw, Hermes, Claude Code, and common web UIs can connect cleanly.[cite:44][cite:190][cite:260]
3. Support **cloud planner + local executor** orchestration, where the planner can use Anthropic direct, OpenRouter, or another OpenAI-compatible provider.[cite:281][cite:304]
4. Keep all routing, thresholds, model assignments, and fallback rules in `config.yaml`.
5. Make OpenRouter a **drop-in planner/fallback backend** without changing the public API presented to clients.[cite:281][cite:286]
6. Preserve strong observability, structured tracing, and deterministic fallback behavior.

## Architecture

### High-level topology

```text
Clients
  ├─ OpenClaw
  ├─ Hermes
  ├─ Claude Code
  └─ Web UIs
        │
        ▼
LLMeld
  ├─ OpenAI Surface (:8000)
  │   ├─ GET  /v1/models
  │   ├─ POST /v1/chat/completions
  │   └─ POST /v1/responses
  ├─ Anthropic Surface (:8001)
  │   └─ POST /v1/messages
  ├─ Request Normaliser
  ├─ Routing Policy Engine
  ├─ Planner/Executor Orchestrator
  ├─ Response Assembler
  └─ Trace Logger
        │
        ├─ Local Executor → Ollama / local OpenAI-compatible endpoint
        └─ Cloud Planner / Fallback
             ├─ Anthropic direct
             ├─ OpenRouter
             └─ Generic OpenAI-compatible provider
```

### Component responsibilities

| Component | Responsibility |
|---|---|
| OpenAI Surface | Accepts `/v1/models`, `/v1/chat/completions`, `/v1/responses` and normalises requests.[cite:267][cite:277] |
| Anthropic Surface | Accepts `/v1/messages` with `anthropic-version` header and normalises requests.[cite:272][cite:275] |
| Routing Policy Engine | Decides direct path vs planner/executor path based on config-driven rules. |
| Planner | Calls configured cloud backend: Anthropic direct, OpenRouter, or generic OpenAI-compatible provider.[cite:281][cite:286] |
| Executor | Calls local Ollama or another local OpenAI-compatible endpoint. |
| Response Assembler | Converts internal result into OpenAI or Anthropic response formats. |
| Trace Logger | Emits structured JSON logs for route choice, steps, retries, latency, and estimated cost. |

## OpenRouter fit

OpenRouter is treated as a **cloud substrate**, not as the public gateway. The user-facing abstraction remains LLMeld. This preserves the planner/executor orchestration, local-first policy, and dual-surface client compatibility while allowing the planner backend to target many upstream models through one provider.[cite:281][cite:286]

### Supported OpenRouter roles

| Role | Description |
|---|---|
| Planner backend | Cloud planner calls OpenRouter using an OpenAI-compatible request. |
| Fallback backend | Failed local steps or unavailable local runtime can escalate to OpenRouter. |
| Direct cloud path | In `best` mode or cloud-only deployments, the entire request can route to OpenRouter. |
| Model experimentation layer | Swap planner models without changing downstream clients. |

## Public API surfaces

### OpenAI-compatible surface (port 8000)

Used by OpenClaw, Hermes, and most web UIs.[cite:44][cite:260][cite:267]

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/models` | GET | Return public model aliases |
| `/v1/chat/completions` | POST | Standard OpenAI chat completions |
| `/v1/responses` | POST | OpenAI Responses API |

Must support:
- Non-streaming responses
- Streaming via SSE
- Tool/function calling
- JSON / structured output mode[cite:265][cite:277]

### Anthropic-compatible surface (port 8001)

Used by Claude Code and optionally OpenClaw in `anthropic-messages` mode.[cite:190][cite:276]

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/messages` | POST | Anthropic Messages API-compatible surface |

Must support:
- `anthropic-version: 2023-06-01` request header[cite:272][cite:275]
- Anthropic message schema
- Anthropic-style streaming events
- Tool use fields compatible with Claude Code expectations[cite:192][cite:272]

## Upstream provider abstraction

The gateway must implement a provider interface so planners and fallbacks can switch providers without changing orchestration logic.

```ts
interface CloudProvider {
  name: string;
  createChatCompletion(input: NormalisedLLMRequest): Promise<NormalisedLLMResponse>;
  createStreamingCompletion?(input: NormalisedLLMRequest): AsyncIterable<NormalisedStreamEvent>;
  listModels?(): Promise<ProviderModel[]>;
}
```

### Required provider implementations

1. `AnthropicDirectProvider`
2. `OpenRouterProvider`
3. `OpenAICompatibleProvider`
4. `OllamaProvider` (executor-focused)

## OpenRouter provider specification

### Base URL and authentication

Default OpenRouter base URL:

```text
https://openrouter.ai/api/v1
```

Authentication:

```http
Authorization: Bearer <OPENROUTER_API_KEY>
```

Optional but recommended attribution headers:

```http
HTTP-Referer: https://your-app.example
X-Title: LLMeld
```

OpenRouter documents `HTTP-Referer` and `X-Title` as optional attribution headers for app discoverability and analytics.[cite:296][cite:299][cite:301][cite:303]

### OpenRouter provider behavior

The `OpenRouterProvider` must:
- Use the OpenAI-compatible API path and payload structure by default.[cite:281]
- Support planner requests through `/chat/completions` and optionally `/responses` if enabled.[cite:281]
- Accept OpenRouter model IDs such as `anthropic/claude-opus-4.6`, `openai/...`, or `openrouter/auto`, all driven by config.[cite:300][cite:304]
- Pass through optional attribution headers when configured.[cite:296][cite:303]
- Normalize provider-specific errors into internal gateway error codes.
- Be isolated from client-facing contracts so downstream users never need to know OpenRouter is in the path.

### OpenRouter caveat

Some tool-calling ecosystems have observed edge cases when OpenRouter fronts Anthropic-family models, particularly around tool call ID formats and Anthropic-vs-OpenAI conventions.[cite:302] The gateway must therefore normalize tool call IDs and never expose raw upstream tool IDs directly to downstream clients unless the downstream surface explicitly expects them.

## Planner/executor orchestration

### Core pattern

The orchestrator follows a plan → execute → verify → revise/escalate loop, which is conceptually similar to many small reviewed implementation units.[cite:250][cite:255]

### Plan schema

```ts
interface ExecutionPlan {
  goal: string;
  acceptance_criteria: string[];
  steps: PlanStep[];
  context_for_executor: string;
  estimated_complexity: "low" | "medium" | "high";
}

interface PlanStep {
  id: string;
  title: string;
  instruction: string;
  expected_output: string;
  depends_on: string[];
  escalate_if_fails: boolean;
  allow_local: boolean;
}
```

### Step result schema

```ts
interface StepResult {
  step_id: string;
  output: string;
  confidence: "high" | "medium" | "low";
  issues: string[];
  tokens_used: number;
}
```

### Orchestration rules

1. Normalize incoming request.
2. Evaluate routing policy.
3. If direct path, send to chosen provider and return.
4. If planner/executor path:
   - Call cloud planner.
   - Parse `ExecutionPlan` JSON.
   - Execute steps locally where allowed.
   - Verify each step.
   - Retry or escalate failed steps.
   - Synthesize final answer through planner.
5. Reformat response to requested client surface.

### Escalation rules

| Trigger | Action |
|---|---|
| Local timeout | Escalate step to fallback cloud provider |
| Invalid structured output | Retry executor; then escalate |
| Retry count exceeded | Escalate or degrade per policy |
| Privacy mode enabled | Block cloud escalation and return policy error if required |
| OpenRouter unavailable | Fall back to Anthropic direct or configured secondary provider |

## Routing policy

The routing engine is fully config-driven and supports these operating modes:

| Mode | Behavior |
|---|---|
| `fast` | Local-biased; skip planner unless explicitly forced |
| `balanced` | Planner for complex tasks, local executor for bounded steps |
| `best` | Cloud-biased; use planner heavily and escalate aggressively |
| `cloud` | Route all requests to configured cloud provider |
| `local` | Route all requests locally; disable cloud planner |

Decision inputs may include:
- estimated token count
- presence of tools
- structured output requirements
- request metadata flag
- complexity keyword match
- privacy flag
- configured mode

## Configuration

### Full config schema

```yaml
gateway:
  openai_port: 8000
  anthropic_port: 8001
  api_key: "llmeld-local"
  model_alias: "llmeld/planner-executor"
  debug_traces: false

providers:
  planner:
    type: "openrouter"         # anthropic | openrouter | openai-compatible
    model: "anthropic/claude-opus-4.6"
    api_key_env: "OPENROUTER_API_KEY"
    base_url: "https://openrouter.ai/api/v1"
    use_responses_api: false
    attribution:
      enabled: true
      http_referer: "https://your-app.example"
      x_title: "LLMeld"

  executor:
    type: "ollama"             # ollama | openai-compatible
    model: "gemma4:latest"
    base_url: "http://localhost:11434/v1"
    api_key: "ollama"
    max_tokens: 2048
    temperature: 0.1
    timeout_ms: 30000

  fallback:
    type: "anthropic"
    model: "claude-haiku-4"
    api_key_env: "ANTHROPIC_API_KEY"
    base_url: null

routing:
  default_mode: "balanced"
  simple_threshold: 500
  complex_threshold: 1500
  max_retries: 2
  enable_task_classifier: true
  privacy_mode: false
  complex_keywords:
    - "create"
    - "build"
    - "implement"
    - "architect"
    - "refactor"
    - "design"
  simple_keywords:
    - "what is"
    - "define"
    - "explain briefly"

logging:
  level: "info"
  format: "jsonl"
  trace_file: "./logs/traces.jsonl"
  emit_token_costs: true
```

### Example configs

#### OpenRouter planner + Ollama executor

```yaml
providers:
  planner:
    type: "openrouter"
    model: "anthropic/claude-opus-4.6"
    api_key_env: "OPENROUTER_API_KEY"
    base_url: "https://openrouter.ai/api/v1"
    attribution:
      enabled: true
      http_referer: "https://your-app.example"
      x_title: "LLMeld"

  executor:
    type: "ollama"
    model: "gemma4:latest"
    base_url: "http://localhost:11434/v1"
    api_key: "ollama"

  fallback:
    type: "openrouter"
    model: "anthropic/claude-sonnet-4.5"
    api_key_env: "OPENROUTER_API_KEY"
    base_url: "https://openrouter.ai/api/v1"
```

#### Anthropic direct planner + OpenRouter fallback

```yaml
providers:
  planner:
    type: "anthropic"
    model: "claude-opus-4-6"
    api_key_env: "ANTHROPIC_API_KEY"

  fallback:
    type: "openrouter"
    model: "openai/gpt-5.1"
    api_key_env: "OPENROUTER_API_KEY"
    base_url: "https://openrouter.ai/api/v1"
```

#### OpenRouter auto-router planner

```yaml
providers:
  planner:
    type: "openrouter"
    model: "openrouter/auto"
    api_key_env: "OPENROUTER_API_KEY"
    base_url: "https://openrouter.ai/api/v1"
```

OpenRouter documents an `openrouter/auto` routing option and allowed-model filtering patterns such as `anthropic/*`.[cite:300]

## Client configuration

### OpenClaw

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "hybridmind": {
        "baseUrl": "http://localhost:8000/v1",
        "apiKey": "llmeld-local",
        "api": "openai-completions",
        "models": [
          {
            "id": "llmeld/planner-executor",
            "name": "HybridMind",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 200000,
            "maxTokens": 32000,
            "cost": { "input": 0.001, "output": 0.003 }
          }
        ]
      }
    }
  }
}
```

OpenClaw can also use an Anthropic-style custom provider path, but the OpenAI-compatible path is the preferred default for this gateway.[cite:44][cite:276]

### Hermes

```yaml
provider: "main"
model: "llmeld/planner-executor"
base_url: "http://localhost:8000/v1"
api_key: "llmeld-local"
```

Hermes supports custom OpenAI-compatible endpoints via base URL configuration.[cite:47][cite:260]

### Claude Code

```bash
export ANTHROPIC_BASE_URL="http://localhost:8001"
export ANTHROPIC_AUTH_TOKEN="llmeld-local"
claude
```

Claude Code honors `ANTHROPIC_BASE_URL`, so the gateway must provide a true Anthropic-compatible surface even if its upstream planner is OpenRouter or another provider.[cite:190][cite:192][cite:179]

## Repository structure

```text
llmeld/
├── src/
│   ├── index.ts
│   ├── surfaces/
│   │   ├── openai.ts
│   │   └── anthropic.ts
│   ├── normaliser/
│   │   ├── from-openai.ts
│   │   ├── from-anthropic.ts
│   │   ├── to-openai.ts
│   │   └── to-anthropic.ts
│   ├── providers/
│   │   ├── anthropic-direct.ts
│   │   ├── openrouter.ts
│   │   ├── openai-compatible.ts
│   │   └── ollama.ts
│   ├── router/
│   │   ├── policy.ts
│   │   └── classifier.ts
│   ├── orchestrator/
│   │   ├── planner.ts
│   │   ├── executor.ts
│   │   ├── verifier.ts
│   │   ├── loop.ts
│   │   └── assembler.ts
│   ├── config/
│   │   ├── loader.ts
│   │   └── schema.ts
│   ├── logger/
│   │   └── trace.ts
│   └── types/
│       ├── normalised.ts
│       ├── plan.ts
│       └── config.ts
├── config.yaml
├── config.example.yaml
├── docker-compose.yml
├── Dockerfile
├── package.json
└── README.md
```

## MVP scope

Phase 1 must include:

1. Fastify server with both public surfaces.
2. `/v1/models`, `/v1/chat/completions`, and `/v1/messages` support.
3. `AnthropicDirectProvider`, `OpenRouterProvider`, and `OllamaProvider`.
4. Planner/executor sequential loop.
5. Config-driven provider selection.
6. Basic structured verifier.
7. Trace logging.
8. README with setup guides for OpenClaw, Hermes, Claude Code, and OpenRouter-backed planner deployments.

## Phase 2 scope

- `/v1/responses` full support
- Streaming on all surfaces and providers
- Parallel step execution
- Tool/function pass-through with tool-ID normalization
- Hot reload for config
- Provider health checks and weighted fallback
- OpenRouter-specific model discovery caching
- Cost dashboards and recent trace inspector

## Error handling

| Error | Behavior |
|---|---|
| Ollama unavailable | Fall back to configured cloud provider |
| OpenRouter unavailable | Fall back to Anthropic direct or configured secondary provider |
| Anthropic unavailable | Fall back to OpenRouter if configured |
| Invalid model alias | Return 404 with available aliases |
| Planner returns invalid JSON | Retry once, then degrade to direct cloud response |
| Auth token mismatch | Return 401 |
| Tool ID mismatch from upstream | Normalize to downstream surface expectations |

## Technical constraints

- Never expose raw upstream provider details to clients unless debug mode is enabled.
- Never log secrets or full Authorization headers.
- The public model alias returned by `/v1/models` must exactly match what downstream clients use.[cite:44][cite:110]
- Anthropic surface must accept `anthropic-beta` headers for forward compatibility with Claude Code behavior.[cite:190]
- OpenRouter support must be optional and fully disabled when `OPENROUTER_API_KEY` is absent.
- The gateway must continue to function in cloud-only or local-only modes depending on configuration.

## Implementation notes for Claude Code

Claude Code should implement this in the following order:

1. Create shared internal request/response types.
2. Implement the two public API surfaces.
3. Implement provider adapters (`anthropic-direct`, `openrouter`, `ollama`, `openai-compatible`).
4. Implement routing policy and config loader.
5. Implement planner/executor loop.
6. Implement response translation back to OpenAI and Anthropic formats.
7. Add logging and retries.
8. Add tests and docs.

The most important design rule is this: **clients talk to LLMeld; LLMeld talks to OpenRouter, Anthropic, Ollama, or other providers.** OpenRouter is an upstream cloud fabric, not the public abstraction layer.[cite:281][cite:286]
