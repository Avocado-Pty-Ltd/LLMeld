# LLMeld — Development Plan

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Request Flow](#request-flow)
3. [Onboarding & Developer Setup](#onboarding--developer-setup)
4. [Configuration Philosophy](#configuration-philosophy)
5. [Phase 0 — Project Scaffolding](#phase-0--project-scaffolding)
6. [Phase 1 — MVP](#phase-1--mvp)
7. [Phase 2 — Production Hardening](#phase-2--production-hardening)
8. [Software Engineering Planner/Executor Design](#software-engineering-plannerexecutor-design)
9. [Testing Strategy](#testing-strategy)
10. [Milestone Checklist](#milestone-checklist)

---

## Executive Summary

LLMeld is a dual-surface API gateway that presents a single model alias to downstream clients (OpenClaw, Hermes, Claude Code, web UIs) while internally orchestrating a cloud planner + local executor architecture. This plan breaks the build into incremental, testable milestones with the fastest possible path to a working demo.

---

## Request Flow

This section describes the end-to-end journey of a user message through LLMeld.

### Flow diagram

```
User types a message (in Claude Code, OpenClaw, Hermes, or any web UI)
        │
        ▼
┌──────────────────────────────────────────────────────┐
│  LLMeld receives the request                         │
│  (OpenAI surface :8000 or Anthropic surface :8001)   │
│  Normalises it into a unified internal format        │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
              Routing Policy Engine
              "Is this simple or complex?"
                       │
         ┌─────────────┴─────────────┐
         │                           │
    SIMPLE PATH                 COMPLEX PATH
    (short question,            (build, refactor,
     quick fix,                  multi-step task)
     explanation)                    │
         │                           ▼
         │              ┌────────────────────────────┐
         │              │  CLOUD PLANNER (call #1)   │
         │              │  Sees full context window   │
         │              │  Decomposes into 2-6 steps  │
         │              │  Each step has:             │
         │              │   - instruction + context   │
         │              │   - success criteria        │
         │              │   - dependency ordering     │
         │              │  Returns ExecutionPlan JSON │
         │              └─────────────┬──────────────┘
         │                            │
         │                            ▼
         │              ┌────────────────────────────┐
         │              │  FOR EACH STEP (in order): │
         │              │                            │
         │              │  LOCAL EXECUTOR             │
         │              │  - Gets ONE step only       │
         │              │  - Sees: instruction +      │
         │              │    relevant context snippets │
         │              │  - Does NOT see full convo  │
         │              │  - Produces output + conf.  │
         │              │           │                 │
         │              │           ▼                 │
         │              │  VERIFIER                   │
         │              │  - Checks against criteria  │
         │              │  - Checks confidence level  │
         │              │       │                     │
         │              │       ├─ PASS → next step   │
         │              │       ├─ FAIL → retry once  │
         │              │       └─ FAIL x2 → escalate │
         │              │         to cloud fallback   │
         │              └─────────────┬──────────────┘
         │                            │
         │                  All steps complete
         │                            │
         │                            ▼
         │              ┌────────────────────────────┐
         │              │  CLOUD PLANNER (call #2)   │
         │              │  SYNTHESIS                  │
         │              │  Sees: original request +   │
         │              │    all step results          │
         │              │  Assembles into one coherent │
         │              │    response for the user     │
         │              └─────────────┬──────────────┘
         │                            │
         ▼                            ▼
   Send to local         Denormalise to client format
   or cloud model        (OpenAI or Anthropic JSON)
   directly                       │
         │                        │
         ▼                        ▼
┌──────────────────────────────────────────────────────┐
│  Response sent back to client                        │
│  Client (Claude Code, OpenClaw, etc.) applies the    │
│  result — edits files, shows answer, etc.            │
│  LLMeld itself never touches files.                  │
└──────────────────────────────────────────────────────┘
```

### What each component sees

| | Cloud planner | Local executor |
|---|---|---|
| Full conversation history | Yes | No — only step instruction + context |
| Other steps' results | Yes (at synthesis) | No |
| Makes architectural decisions | Yes | No |
| Writes bulk code / produces output | No | Yes |
| Number of calls per request | 2 (plan + synthesize) | 1 per step (2-6 typical) |

### Concrete example: "Refactor the auth module to use JWT"

```
1. ROUTING → complex (keyword "refactor", multi-file likely)

2. CLOUD PLANNER → produces plan:
   Step 1: "Analyze current auth module structure"
           context: [file paths, current code snippets]
   Step 2: "Write JWT utility functions"
           context: [JWT library docs, expected interface]
           depends_on: [step-1]
   Step 3: "Update auth middleware to use JWT utils"
           context: [current middleware code, step-2 output]
           depends_on: [step-2]
   Step 4: "Update auth tests for JWT flow"
           context: [current test file, new function signatures]
           depends_on: [step-3]

3. LOCAL EXECUTOR runs each step:
   Step 1 → returns analysis of current auth structure
   Step 2 → returns JWT utility code (verified: has expected exports)
   Step 3 → returns updated middleware (verified: imports JWT utils)
   Step 4 → returns updated tests (verified: covers JWT flow)

4. CLOUD PLANNER (synthesis) → combines all outputs into
   a single response with the complete refactored code

5. CLIENT (Claude Code/OpenClaw) receives the response
   and applies the file edits
```

### When the simple path is used

Not every request goes through the planner/executor loop. The routing policy shortcuts to a **direct path** when:

- The message is short (< `simple_threshold` tokens, default 500)
- It matches simple keywords ("what is", "define", "explain briefly")
- The routing mode is `fast` or `local`
- It's a follow-up in a conversation where planner overhead would hurt latency

On the direct path, the request goes straight to the local model (or cloud model in `cloud`/`best` mode) and the response comes back immediately — no planning, no multi-step loop.

---

## Onboarding & Developer Setup

### Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| Node.js | 20+ | Runtime |
| pnpm | 9+ | Package manager (fast, strict) |
| Ollama | latest | Local model executor |
| Docker (optional) | 24+ | Containerised deployment |

### First-run experience (target: under 5 minutes)

The onboarding flow should work like this:

```bash
# 1. Clone and install
git clone https://github.com/<org>/llmeld.git && cd llmeld
pnpm install

# 2. Copy example config and set API keys
cp config.example.yaml config.yaml
# Edit config.yaml — only OPENROUTER_API_KEY or ANTHROPIC_API_KEY is required

# 3. Pull a local model (if using Ollama executor)
ollama pull gemma3:4b

# 4. Start
pnpm dev

# 5. Verify — two quick curls
curl http://localhost:8000/v1/models
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer llmeld-local" \
  -H "Content-Type: application/json" \
  -d '{"model":"llmeld/planner-executor","messages":[{"role":"user","content":"Hello"}]}'
```

### Onboarding deliverables

1. **`config.example.yaml`** — fully commented, all fields explained, sensible defaults.
2. **`pnpm dev`** — starts both surfaces with hot-reload (`tsx watch`).
3. **`pnpm dev:local-only`** — starts in local-only mode (no cloud keys required) for contributors who just want to hack on the server.
4. **Startup validation** — on boot, the server must:
   - Validate `config.yaml` against a Zod schema and print actionable errors.
   - Check Ollama connectivity and print a warning (not crash) if unavailable.
   - Check that at least one cloud API key is set when `routing.default_mode` is not `local`.
   - Print a summary table: surfaces, ports, planner provider, executor provider, routing mode.
5. **`README.md`** — quick start, client config snippets (OpenClaw, Hermes, Claude Code), architecture diagram, and link to this plan.
6. **Docker one-liner** — `docker compose up` starts LLMeld + Ollama side by side.

---

## Configuration Philosophy

LLMeld is **config-driven, not UI-driven**. There is no web dashboard. All configuration lives in `config.yaml`, validated at startup and (in Phase 2) hot-reloaded on file change.

### Why no web UI

- The target users (developers using Claude Code, OpenClaw, Hermes) are comfortable editing YAML.
- A config file is version-controllable, diffable, and copy-pasteable between environments.
- It eliminates an entire category of frontend code, auth, and attack surface.
- Docker/CI deployments just mount a config file — no state to manage.

### How configuration works

| Layer | What it controls | When it's read |
|---|---|---|
| `config.yaml` | Ports, providers, models, routing mode, thresholds, logging | Startup (hot-reload in Phase 2) |
| Environment variables | API keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`), config path (`LLMELD_CONFIG`) | Startup only |
| `config.example.yaml` | Ships with repo, fully commented, all fields documented | N/A — reference file |

### Startup experience

On boot, the server validates the config and prints an at-a-glance summary:

```
[llmeld] Config loaded from ./config.yaml
[llmeld] ┌─────────────┬──────────────────────────────┐
[llmeld] │ OpenAI      │ :8000                        │
[llmeld] │ Anthropic   │ :8001                        │
[llmeld] │ Planner     │ openrouter (claude-opus-4.6)  │
[llmeld] │ Executor    │ ollama (gemma3:4b)            │
[llmeld] │ Fallback    │ anthropic (claude-haiku-4)    │
[llmeld] │ Mode        │ balanced                     │
[llmeld] └─────────────┴──────────────────────────────┘
[llmeld] ⚠ Ollama at localhost:11434 — not reachable (will use fallback)
[llmeld] Ready.
```

If config validation fails, the server exits with an actionable error:

```
[llmeld] Config error: providers.planner.model is required
[llmeld] See config.example.yaml for reference
```

### Phase 2: hot-reload

The server watches `config.yaml` with `fs.watch`. On change:
- Re-validate the full file. If invalid, log a warning and keep the current config.
- Apply safe changes immediately: routing mode, thresholds, model names, logging level.
- Changes that require restart (ports, API keys): log a notice that restart is needed.

### Phase 2: optional admin endpoint

For programmatic control without editing files, an optional authenticated endpoint:

```
POST /admin/routing  { "mode": "best" }     → switch routing mode
GET  /admin/status                            → provider health, uptime, request counts
GET  /admin/traces?last=10                    → recent trace summaries
```

Disabled by default. Enabled via `gateway.admin_enabled: true` + `gateway.admin_key` in config. This is not a UI — it's a JSON API for scripts and monitoring tools.

---

## Phase 0 — Project Scaffolding

**Goal:** Buildable, lintable, testable TypeScript project with CI.

### Steps

| # | Task | Output |
|---|---|---|
| 0.1 | `pnpm init`, install deps: `fastify`, `yaml`, `zod`, `pino`, `undici` | `package.json` |
| 0.2 | TypeScript config: `tsconfig.json` (strict, ESM, Node20 target) | `tsconfig.json` |
| 0.3 | ESLint + Prettier config | `.eslintrc.cjs`, `.prettierrc` |
| 0.4 | Vitest config | `vitest.config.ts` |
| 0.5 | Create directory skeleton per spec (`src/`, subdirs) | Empty files with barrel exports |
| 0.6 | Add npm scripts: `dev`, `build`, `start`, `test`, `lint` | `package.json` scripts |
| 0.7 | `config.example.yaml` with full comments | Config file |
| 0.8 | `Dockerfile` + `docker-compose.yml` (LLMeld + Ollama) | Container files |
| 0.9 | GitHub Actions CI: lint, typecheck, test on push | `.github/workflows/ci.yml` |

### Key decisions

- **Fastify** over Express: better TypeScript support, schema validation, faster.
- **pnpm** over npm/yarn: strict dependency resolution, workspace-ready if monorepo is needed later.
- **Vitest** over Jest: native ESM, fast, compatible with TypeScript.
- **pino** for logging: structured JSON, fast, Fastify-native.

---

## Phase 1 — MVP

Phase 1 is split into 7 sequential milestones. Each milestone produces a testable increment.

### Milestone 1: Types & Config (1-2 days)

**Files:** `src/types/`, `src/config/`

1. Define normalised internal types in `src/types/normalised.ts`:
   - `NormalisedLLMRequest` — unified representation of a chat request regardless of source surface.
   - `NormalisedLLMResponse` — unified response.
   - `NormalisedStreamEvent` — unified streaming chunk.
   - `NormalisedMessage`, `NormalisedToolCall`, `NormalisedToolResult`.
2. Define plan types in `src/types/plan.ts` — `ExecutionPlan`, `PlanStep`, `StepResult` per spec.
3. Define config types in `src/types/config.ts` — TypeScript types mirroring the YAML schema.
4. Implement config loader in `src/config/loader.ts`:
   - Read `config.yaml` (or path from `LLMELD_CONFIG` env var).
   - Validate with Zod schema in `src/config/schema.ts`.
   - Resolve `api_key_env` references to actual env vars.
   - Export a frozen, typed config singleton.
5. Write tests: valid config loads, missing required fields error, env var resolution works.

### Milestone 2: Provider Adapters (2-3 days)

**Files:** `src/providers/`

Implement the `CloudProvider` interface from the spec and four concrete providers.

1. **`CloudProvider` interface** — `src/providers/base.ts`
   ```ts
   interface CloudProvider {
     name: string;
     createChatCompletion(req: NormalisedLLMRequest): Promise<NormalisedLLMResponse>;
     createStreamingCompletion?(req: NormalisedLLMRequest): AsyncIterable<NormalisedStreamEvent>;
     listModels?(): Promise<ProviderModel[]>;
   }
   ```

2. **`OllamaProvider`** — `src/providers/ollama.ts`
   - Calls Ollama's OpenAI-compatible `/v1/chat/completions`.
   - Handles connection errors gracefully (Ollama may not be running).
   - Respects `timeout_ms` from config.

3. **`OpenAICompatibleProvider`** — `src/providers/openai-compatible.ts`
   - Generic provider for any OpenAI-compatible API.
   - Used as base class or shared implementation for OpenRouter and Ollama.

4. **`OpenRouterProvider`** — `src/providers/openrouter.ts`
   - Extends/wraps `OpenAICompatibleProvider`.
   - Adds `HTTP-Referer` and `X-Title` attribution headers when configured.
   - Normalizes tool call IDs (critical caveat from spec — OpenRouter + Anthropic models can have mismatched tool IDs).
   - Accepts OpenRouter model IDs like `anthropic/claude-opus-4.6`, `openrouter/auto`.

5. **`AnthropicDirectProvider`** — `src/providers/anthropic-direct.ts`
   - Calls Anthropic's native Messages API.
   - Translates between normalised types and Anthropic's request/response schema.
   - Handles `anthropic-version` header.

6. **Provider factory** — `src/providers/factory.ts`
   - Given a provider config block, returns the correct `CloudProvider` instance.

**Tests:** Mock HTTP responses (use `undici.MockAgent` or `msw`) and verify each provider produces correct `NormalisedLLMResponse`.

### Milestone 3: Request Normalisers (1-2 days)

**Files:** `src/normaliser/`

These are pure functions — easy to test in isolation.

1. **`from-openai.ts`** — Convert OpenAI `/v1/chat/completions` request body to `NormalisedLLMRequest`.
2. **`from-anthropic.ts`** — Convert Anthropic `/v1/messages` request body to `NormalisedLLMRequest`.
3. **`to-openai.ts`** — Convert `NormalisedLLMResponse` to OpenAI response JSON.
4. **`to-anthropic.ts`** — Convert `NormalisedLLMResponse` to Anthropic response JSON.

Special care:
- Tool call ID normalization (spec caveat).
- System message handling: OpenAI uses `messages[0].role === "system"`, Anthropic uses a top-level `system` field.
- `stop_reason` / `finish_reason` mapping.
- Token usage field mapping.

**Tests:** Snapshot tests with fixture request/response pairs for both surfaces.

### Milestone 4: API Surfaces (1-2 days)

**Files:** `src/surfaces/`, `src/index.ts`

1. **OpenAI surface** — `src/surfaces/openai.ts`
   - `GET /v1/models` — returns configured model aliases.
   - `POST /v1/chat/completions` — accepts OpenAI request, normalises, routes, denormalises response.
   - Auth: validate `Authorization: Bearer <gateway_api_key>`.
   - Register as a Fastify plugin.

2. **Anthropic surface** — `src/surfaces/anthropic.ts`
   - `POST /v1/messages` — accepts Anthropic request with `anthropic-version` header.
   - Accept `anthropic-beta` headers without error (forward-compat for Claude Code).
   - Auth: validate `x-api-key` header.
   - Register as a Fastify plugin.

3. **`src/index.ts`** — Main entry:
   - Load config.
   - Create Fastify instances for each surface (separate ports).
   - Register surface plugins.
   - Print startup summary.

**Tests:** Integration tests using `fastify.inject()` — no real server needed.

### Milestone 5: Routing Policy Engine (1 day)

**Files:** `src/router/`

1. **`policy.ts`** — Core routing logic:
   - Input: `NormalisedLLMRequest` + config.
   - Output: `RouteDecision` — `{ path: "direct" | "planner-executor", provider: string, reason: string }`.
   - Implements the 5 modes: `fast`, `balanced`, `best`, `cloud`, `local`.
   - In `balanced` mode, uses token count estimation, keyword matching, tool presence, and structured output flags to decide.

2. **`classifier.ts`** — Optional lightweight task classifier:
   - Heuristic-based (keyword + token count) for MVP.
   - Returns `"simple" | "complex"` with a confidence score.

**Tests:** Table-driven tests — given mode + request characteristics, assert correct route decision.

### Milestone 6: Planner/Executor Orchestrator (3-4 days)

**Files:** `src/orchestrator/`

This is the core of LLMeld and the most complex milestone. See the dedicated section below for software-engineering-specific design.

1. **`planner.ts`** — Calls cloud planner with a system prompt that instructs it to return an `ExecutionPlan` JSON.
   - The planner system prompt is the most critical piece of prompt engineering in the project.
   - Must handle planner returning invalid JSON (retry once, then degrade).

2. **`executor.ts`** — Executes a single `PlanStep` against the local provider.
   - Wraps the step instruction into a focused prompt with relevant context.
   - Returns `StepResult`.

3. **`verifier.ts`** — Validates a `StepResult` against the step's `expected_output` criteria.
   - MVP: string-matching heuristics + structural checks.
   - Determines if output is acceptable or needs retry/escalation.

4. **`loop.ts`** — The orchestration loop:
   ```
   plan = await planner.createPlan(request)
   results = []
   for step in topologicalSort(plan.steps):
     result = await executor.execute(step, context)
     verified = await verifier.check(step, result)
     if !verified:
       result = await executor.execute(step, context, retry=true)
       if still !verified and step.escalate_if_fails:
         result = await fallbackProvider.execute(step)
     results.push(result)
   return await assembler.synthesize(plan, results)
   ```

5. **`assembler.ts`** — Takes the plan + all step results and calls the planner one final time to synthesize a coherent response that addresses the original user request.

**Tests:**
- Unit tests per component with mocked providers.
- Integration test: mock planner returns a 3-step plan, mock executor returns results, verify final assembly.

### Milestone 7: Logging, Error Handling & Polish (1-2 days)

**Files:** `src/logger/`

1. **`trace.ts`** — Structured trace logger:
   - Each request gets a `trace_id` (UUID).
   - Log: route decision, planner call, each executor step, retries, escalations, final assembly, total latency, estimated token cost.
   - Write to `./logs/traces.jsonl` and stdout (configurable).

2. **Error handling** — Implement the error table from spec:
   - Provider unavailability → fallback chain.
   - Invalid model alias → 404.
   - Auth mismatch → 401.
   - Planner invalid JSON → retry then degrade.
   - Tool ID normalization on all paths.

3. **Startup validation** — print summary table, validate connectivity.

4. **README.md** — Quick start, client configs, architecture diagram.

---

## Phase 2 — Production Hardening

After MVP is working end-to-end:

| # | Feature | Priority |
|---|---|---|
| 2.1 | SSE streaming on all surfaces and providers | High |
| 2.2 | Tool/function call pass-through with ID normalization | High |
| 2.3 | `/v1/responses` endpoint (OpenAI Responses API) | Medium |
| 2.4 | Parallel step execution (independent steps run concurrently) | Medium |
| 2.5 | Config hot-reload (watch `config.yaml`, apply without restart) | Medium |
| 2.6 | Provider health checks and weighted fallback | Medium |
| 2.7 | OpenRouter model discovery caching | Low |
| 2.8 | Admin JSON API (`/admin/status`, `/admin/traces`, `/admin/routing`) | Low |
| 2.9 | Structured output / JSON mode enforcement | Medium |
| 2.10 | Rate limiting and request queuing | Low |

---

## Software Engineering Planner/Executor Design

This is the most important section. The planner/executor must work exceptionally well for **software engineering tasks** — the primary use case for LLMeld when used with Claude Code, OpenClaw, or Hermes.

### Why software engineering needs special treatment

Software engineering tasks sent through coding assistants have specific characteristics:
- They involve **multi-file context** (existing code, file paths, error messages).
- They require **ordered operations** (read → understand → plan → implement → verify).
- They benefit from **decomposition** — a large refactor can be broken into file-level or function-level changes.
- The executor needs **enough context** to produce correct code, but not so much that it overwhelms a smaller local model.
- **Verification** can be partly automated (syntax checks, pattern matching, structural validation).

### Planner system prompt design

The planner system prompt must instruct the cloud model to:

1. **Analyze the task type** — Is this a question, a bug fix, a new feature, a refactor, a code review, etc.?
2. **Assess complexity honestly** — Some tasks should NOT be decomposed (simple questions, small fixes). The planner must recognize when direct execution is better than a multi-step plan.
3. **Decompose into executor-sized steps** — Each step must be completable by a local model (e.g., 7B-14B parameter) with limited context. Steps should be:
   - **Self-contained** — the executor can complete the step with only the step instruction + provided context.
   - **Bounded** — each step produces a concrete, verifiable output.
   - **Ordered** — dependencies between steps are explicit.
4. **Provide context extracts** — The planner must include relevant code snippets, file paths, and constraints in each step's `instruction` field so the executor doesn't need to "know" the full codebase.
5. **Define verification criteria** — Each step's `expected_output` should describe what a correct result looks like (e.g., "a Python function that takes X and returns Y", "a modified version of the function that handles the null case").

### Planner prompt template (MVP)

```
You are a software engineering task planner. Your job is to decompose a user's request into a sequence of focused, self-contained steps that a smaller AI model can execute independently.

## Rules
1. If the task is simple (a direct question, a small code fix, a brief explanation), set estimated_complexity to "low" and create a single step.
2. For complex tasks, break them into 2-6 steps. Each step must be independently executable.
3. Each step's `instruction` must contain ALL context the executor needs — relevant code snippets, file paths, constraints, expected function signatures. The executor cannot see the original conversation.
4. Each step's `expected_output` must describe what correct output looks like, so it can be verified.
5. Set `allow_local: false` on steps that require deep reasoning, large context synthesis, or tasks that a small model would likely fail at.
6. Set `escalate_if_fails: true` on critical steps where an incorrect result would cascade.

## Output format
Return a single JSON object matching this schema:
{
  "goal": "string — what the user wants to achieve",
  "acceptance_criteria": ["string — how to know the overall task is done"],
  "estimated_complexity": "low" | "medium" | "high",
  "context_for_executor": "string — shared background context all steps might need",
  "steps": [
    {
      "id": "step-1",
      "title": "string — short title",
      "instruction": "string — complete instruction for the executor, including all needed context",
      "expected_output": "string — what correct output looks like",
      "depends_on": [],
      "escalate_if_fails": true/false,
      "allow_local": true/false
    }
  ]
}
```

### Executor prompt design

The executor receives a focused prompt per step:

```
You are completing one step of a larger task.

## Background context
{context_for_executor}

## Your step
**Title:** {step.title}
**Instruction:** {step.instruction}

## Requirements
- Produce ONLY the requested output. Do not explain unless the instruction asks for an explanation.
- If you need to write code, write complete, working code — not pseudocode or partial snippets.
- If you are unsure, state your uncertainty clearly.

## Expected output
{step.expected_output}
```

### Software engineering step patterns

The planner should learn to produce these common step patterns:

| Task Type | Step Pattern |
|---|---|
| Bug fix | 1. Analyze error + identify root cause → 2. Write fix → 3. Write/update test |
| New feature | 1. Design interface/API → 2. Implement core logic → 3. Wire up integration → 4. Add tests |
| Refactor | 1. Identify current structure → 2. Refactor target module → 3. Update callers → 4. Verify no regressions |
| Code review | 1. Summarize changes → 2. Identify issues → 3. Suggest improvements (often single step) |
| Question/explanation | 1. Answer directly (single step, `estimated_complexity: "low"`) |
| Multi-file change | One step per file or per logical unit, with explicit dependencies |

### Verification strategies for code output

The verifier (`src/orchestrator/verifier.ts`) should apply these checks for software engineering output:

1. **Structural checks:**
   - If the step asked for code, does the output contain a code block?
   - If the step asked for a function, does it match the expected signature?
   - Is the output non-empty and non-trivially short?

2. **Consistency checks:**
   - Does the output reference the same variable/function names mentioned in the step context?
   - If the step depended on a previous step's output, are those references present?

3. **Confidence threshold:**
   - The executor self-reports confidence. Below `medium`, escalate.

4. **Future (Phase 2):**
   - Syntax validation (parse the code with a lightweight parser).
   - Diff-format validation for file modifications.

### Synthesis prompt design

After all steps complete, the assembler calls the planner one final time:

```
You planned and executed the following task:

## Original request
{original_user_message}

## Plan
{plan_summary}

## Step results
{for each step: step.title → result.output}

## Instructions
Synthesize these step results into a single, coherent response to the user's original request.
- If the results contain code, present the final code clearly.
- If steps produced partial results, combine them logically.
- If any step had issues, note them.
- Match the response format the user would expect (code blocks for code, prose for explanations).
```

### When NOT to use planner/executor

The routing policy must recognize these cases and use the **direct path** instead:

- Simple questions ("What does X do?", "Explain Y")
- Short messages (< `simple_threshold` tokens)
- Messages in `fast` or `local` mode
- Follow-up messages in a conversation where the plan/execute overhead would hurt latency
- Tasks where the planner overhead exceeds the benefit (small code changes)

---

## Testing Strategy

### Test pyramid

```
          ╱ E2E ╲           ← 5-10 tests: real Fastify server, mocked upstreams
         ╱ Integration ╲     ← 20-30 tests: orchestrator loop, provider chains
        ╱   Unit tests   ╲   ← 50+ tests: normalisers, config, routing, verifier
```

### Unit tests (Vitest)

- **Normalisers:** Fixture-based. Input JSON → expected output JSON. Cover edge cases (empty messages, tool calls, system prompts).
- **Config loader:** Valid YAML, invalid YAML, missing env vars, defaults.
- **Routing policy:** Table-driven. Mode × request features → expected decision.
- **Verifier:** Various step/result combinations → pass/fail.
- **Provider adapters:** Mock HTTP, verify request construction and response parsing.

### Integration tests

- **Orchestrator loop:** Mock planner + executor providers. Feed a request through the full plan→execute→verify→assemble cycle.
- **Error/fallback chains:** Simulate provider failures, verify fallback behavior.
- **Surface → Router → Provider:** `fastify.inject()` through the full request path.

### E2E tests

- Start real Fastify server (both ports).
- Mock upstream providers with `msw` or `undici.MockAgent`.
- Send requests via both OpenAI and Anthropic surfaces.
- Verify complete response format compliance.

### Test fixtures

Create a `test/fixtures/` directory with:
- Sample OpenAI requests and expected responses.
- Sample Anthropic requests and expected responses.
- Sample execution plans (planner output).
- Sample step results (executor output).

---

## Milestone Checklist

Use this to track progress:

### Phase 0 — Scaffolding
- [ ] `package.json` with all deps
- [ ] `tsconfig.json` (strict, ESM)
- [ ] ESLint + Prettier
- [ ] Vitest config
- [ ] Directory skeleton
- [ ] npm scripts (dev, build, start, test, lint)
- [ ] `config.example.yaml`
- [ ] `Dockerfile` + `docker-compose.yml`
- [ ] CI workflow

### Phase 1 — MVP
- [ ] **M1:** Normalised types + config loader + Zod schema
- [ ] **M2:** Provider adapters (Ollama, OpenRouter, Anthropic, OpenAI-compat)
- [ ] **M3:** Request/response normalisers (OpenAI ↔ internal ↔ Anthropic)
- [ ] **M4:** API surfaces (OpenAI on :8000, Anthropic on :8001)
- [ ] **M5:** Routing policy engine
- [ ] **M6:** Planner/executor orchestrator with SE-optimized prompts
- [ ] **M7:** Trace logging, error handling, startup validation
- [ ] **README** with quick start + client configs

### Phase 2 — Production
- [ ] SSE streaming
- [ ] Tool/function pass-through
- [ ] `/v1/responses` endpoint
- [ ] Parallel step execution
- [ ] Config hot-reload
- [ ] Health checks + weighted fallback
- [ ] OpenRouter model discovery cache
- [ ] Admin JSON API (status, traces, routing control)

---

## Timeline estimate

| Phase | Estimated effort |
|---|---|
| Phase 0 — Scaffolding | 1 day |
| Phase 1 — MVP | 10-14 days |
| Phase 2 — Production | 10-14 days |

Phase 1 produces a working, demo-able system. Phase 2 makes it production-grade.
