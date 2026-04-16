# LLMeld

**Save money with local compute**

A dual-surface API gateway that orchestrates cloud LLM planners with local executors, giving you the intelligence of frontier models with the cost savings of local compute.

## Overview

LLMeld sits between your AI-powered tools and your model providers. It exposes both OpenAI-compatible and Anthropic-compatible API surfaces, intelligently routing requests between a cloud "planner" (for complex reasoning) and a local "executor" (for straightforward work). The result: significant cost savings without sacrificing quality.

## Features

- **Dual API Surfaces**: OpenAI-compatible and Anthropic-compatible endpoints — works with any tool that speaks either protocol
- **Cloud + Local Orchestration**: Planner/executor architecture routes complex tasks to cloud models and simple tasks to local models
- **Smart Routing**: Configurable routing modes (`fast`, `balanced`, `best`, `cloud`, `local`) with heuristic task classification
- **Multi-Provider Support**: OpenRouter, Anthropic, Ollama, and any OpenAI-compatible provider
- **Automatic Fallback**: Failed local executions gracefully escalate to a cloud fallback provider
- **Privacy Mode**: Block all cloud escalation for sensitive environments
- **TUI Dashboard**: Live terminal dashboard with request stats, latency tracking, cost estimates, and scrollable log viewer
- **Shared Memory**: Persistent knowledge across requests — project conventions, orchestration hints, execution learnings, and conversation memory auto-accumulate in a human-editable markdown file
- **Interactive Onboarding**: Setup wizard auto-detects available Ollama models and walks you through first-time configuration
- **Configuration-Driven**: Single YAML config for providers, routing, and logging
- **Token Cost Logging**: Estimated token costs in structured trace logs

### Planned / In Progress

- Output comparison across models
- Spending limits and budget alerts
- Batch processing optimisation
- Web-based management interface

## Installation

### Prerequisites

- Node.js 20+
- pnpm (recommended) or npm
- [Ollama](https://ollama.com/) (for local model execution)

### From Source

```bash
git clone https://github.com/Avocado-Pty-Ltd/LLMeld.git
cd LLMeld
pnpm install
# or if using npm:
npm install
```

### Using Docker

```bash
# Create config from example
cp config.example.yaml config.yaml

# Create .env file with your API keys
cat > .env << 'EOF'
OPENROUTER_API_KEY="your-key-here"
# or
ANTHROPIC_API_KEY="your-key-here"
EOF

# Start the service
docker compose up -d
```

> **Note:** If using the legacy Docker Compose standalone binary, use `docker-compose up -d` instead.

## Configuration

Copy the example configuration and customise it for your needs:

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` to configure your providers, routing mode, and logging preferences. See `config.example.yaml` for detailed comments on every option.

Key configuration areas:

- **Gateway**: Ports, API key, model alias
- **Providers**: Planner (cloud), executor (local), and fallback models
- **Routing**: Mode selection, complexity thresholds, privacy mode
- **Logging**: Level, format, trace file, token cost tracking
- **Memory**: Shared memory for cross-request knowledge persistence (disabled by default)

## Quick Start

1. **Ensure Ollama is running** with a local model pulled:

   ```bash
   ollama pull gemma3:4b
   ollama serve
   ```

2. **Set up your cloud API key** (at least one required):

   ```bash
   export OPENROUTER_API_KEY="your-key-here"
   # or
   export ANTHROPIC_API_KEY="your-key-here"
   ```

3. **Start LLMeld** (the onboarding wizard runs automatically on first launch if no `config.yaml` exists):

   ```bash
   pnpm dev
   ```

   Or configure manually:

   ```bash
   cp config.example.yaml config.yaml
   # Edit config.yaml to match your setup
   pnpm dev
   ```

4. **Send a request** using the OpenAI-compatible surface (default port 8000):

   ```bash
   curl http://localhost:8000/v1/chat/completions \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer llmeld-local" \
     -d '{
       "model": "llmeld/planner-executor",
       "messages": [{"role": "user", "content": "Explain quantum computing briefly"}],
       "stream": false
     }'
   ```

   Or use the OpenAI SDK pointed at LLMeld:

   ```typescript
   import OpenAI from 'openai';

   const client = new OpenAI({
     baseURL: 'http://localhost:8000/v1',
     apiKey: 'llmeld-local',
   });

   const response = await client.chat.completions.create({
     model: 'llmeld/planner-executor',
     messages: [{ role: 'user', content: 'Explain quantum computing briefly' }],
   });

   console.log(response.choices[0].message.content);
   ```

5. **Anthropic surface** is available on port 8001 for tools like Claude Code.

## Development

### Project Structure

```
src/
├── config/          # Configuration loading, validation, and Zod schema
├── dashboard/       # TUI dashboard (stats, renderer, log viewer, key handler)
├── logger/          # Structured trace logging
├── memory/          # Shared memory system (types, format, pruner, extractor, manager)
├── normaliser/      # Request/response format normalisation
├── orchestrator/    # Planner-executor loop, tools, and verification
├── providers/       # Provider implementations (OpenRouter, Anthropic, Ollama)
├── router/          # Routing policy and task classifier
├── surfaces/        # OpenAI and Anthropic API surface handlers
├── types/           # TypeScript type definitions
├── index.ts         # Entry point
└── onboarding.ts    # Interactive setup wizard
```

### Running in Development

```bash
pnpm dev
```

This starts the development server with hot reloading.

### Building for Production

```bash
pnpm build
pnpm start
```

### Running Tests

```bash
pnpm test
```

## Architecture

### Planner-Executor Pattern

LLMeld implements a two-model architecture:

- **Planner**: A cloud-based frontier model (via OpenRouter, Anthropic, etc.) that handles complex reasoning and planning
- **Executor**: A local model (via Ollama) that handles straightforward execution tasks

### Routing Modes

- **`fast`** (default): Routes to local executor whenever possible; escalates complex tasks to planner
- **`balanced`**: Uses heuristic classification to split work
- **`best`**: Always routes to the best model for the job (usually cloud planner)
- **`cloud`**: Bypasses local executor, routes all to cloud planner
- **`local`**: Bypasses cloud planner, routes all to local executor

### Privacy Mode

When enabled (`privacy_mode: true`), LLMeld blocks all cloud escalation and logs a warning when a task would normally escalate. This is useful for sensitive environments where cloud inference is prohibited.

## Configuration Example

```yaml
gateway:
  openai_port: 8000
  anthropic_port: 8001
  api_key: llmeld-local
  model_alias: llmeld/planner-executor

providers:
  planner:
    type: openrouter
    model: anthropic/claude-sonnet-4-20250514
    api_key_env: OPENROUTER_API_KEY

  executor:
    type: ollama
    model: gemma3:4b
    base_url: "http://localhost:11434/v1"

  fallback:
    type: anthropic
    model: claude-haiku-4-20250514
    api_key_env: ANTHROPIC_API_KEY

routing:
  default_mode: balanced
  privacy_mode: false

logging:
  level: info
  format: pretty
  trace_file: ./logs/traces.jsonl
  emit_token_costs: true

memory:
  enabled: false   # Set to true to enable shared memory
```

See `config.example.yaml` for the full reference with all options and comments.

## Dashboard

When running in a TTY, LLMeld displays a live terminal dashboard showing:

- Request counts, average latency, token usage, and estimated costs
- Breakdown by route (direct vs planner-executor), task type, and API surface
- Recent request log with timestamps, routing path, and per-request latency

**Keyboard shortcuts:**

| Key | Action |
|-----|--------|
| `Q` | Quit |
| `L` | Toggle log viewer |
| `C` | Clear stats |
| `Up/Down` | Scroll logs |

To disable the dashboard and use plain console output:

```bash
pnpm dev -- --no-dashboard
```

## Shared Memory

LLMeld can maintain a persistent memory file (`.llmeld/memory.md`) that both the planner and executor access across requests. This lets the models "meld" over time — learning your project's conventions, accumulating orchestration insights, and remembering past work.

### What it stores

| Category | Purpose | Default TTL |
|----------|---------|-------------|
| **Project Knowledge** | Architecture, conventions, file structure | Permanent (high confidence) |
| **Shared Vocabulary** | Consistent terms and naming patterns | Permanent |
| **Orchestration Hints** | How planner should write instructions for executor | Permanent (high) / 90d (medium) |
| **Execution Learnings** | Step failures, timeouts, what worked | 30 days |
| **Conversation Memory** | Completed tasks, decisions, preferences | 30 days |

### How it works

1. After each request, LLMeld asynchronously extracts noteworthy facts using the extraction provider (local executor by default — zero cloud cost)
2. Before each request, relevant memory is injected into the planner's system prompt (full token budget) and executor's user prompt (half budget)
3. Entries are prioritised by type (vocabulary first, then project knowledge, then hints) and confidence
4. Expired entries are automatically pruned; a hard cap prevents bloat

### Enabling memory

Add to your `config.yaml`:

```yaml
memory:
  enabled: true
```

All other fields have sensible defaults. The memory file is plain markdown, human-editable, and git-friendly. See `config.example.yaml` for the full reference.

### Configuration options

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Must explicitly enable |
| `file_path` | `./.llmeld/memory.md` | Path to the memory file |
| `max_inject_tokens` | `2000` | Token budget for injection (~15% overhead) |
| `extraction_provider` | `executor` | Which provider extracts facts (local = free) |
| `max_entries` | `100` | Hard cap, triggers pruning |
| `staleness_days` | `30` | Conversation/learning entries expire |
| `inject_on_direct` | `true` | Also inject on direct-path requests |
| `auto_extract` | `true` | Auto-extract from responses |

## Cost Analysis

LLMeld automatically logs estimated token costs for each request when `emit_token_costs: true`. View cost breakdowns:

```bash
cat logs/traces.jsonl | jq 'select(.estimated_cost) | {timestamp, estimated_cost}'
```

## Troubleshooting

### Ollama Connection Issues

Ensure Ollama is running and accessible:

```bash
curl http://localhost:11434/api/tags
```

### API Key Errors

Check that environment variables are set:

```bash
echo $OPENROUTER_API_KEY
echo $ANTHROPIC_API_KEY
```

### Docker Container Won't Start

Check the logs:

```bash
docker logs -f llmeld
```

Ensure `config.yaml` and `.env` exist in the project root before running `docker compose up`.

## Contributing

We welcome contributions! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License — see LICENSE file for details.

## Support

For issues, questions, or suggestions, please open an issue on GitHub or contact the maintainers.
