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
- **Configuration-Driven**: Single YAML config for providers, routing, and logging
- **Token Cost Logging**: Estimated token costs in structured trace logs

### Planned / In Progress

- Output comparison across models
- Real-time cost analytics dashboard
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
```

### Using Docker

```bash
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

3. **Configure and start LLMeld:**

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

   ```python
   from openai import OpenAI

   client = OpenAI(
       base_url="http://localhost:8000/v1",
       api_key="llmeld-local"
   )

   response = client.chat.completions.create(
       model="llmeld/planner-executor",
       messages=[{"role": "user", "content": "Explain quantum computing briefly"}]
   )

   print(response.choices[0].message.content)
   ```

5. **Anthropic surface** is available on port 8001 for tools like Claude Code.

## Development

### Project Structure

```
src/
├── config/          # YAML config loading and validation
├── logger/          # Structured trace logging
├── normaliser/      # Request/response normalisation
├── orchestrator/    # Planner/executor orchestration loop
├── providers/       # Provider implementations (Ollama, OpenRouter, Anthropic, etc.)
├── router/          # Smart routing and task classification
├── surfaces/        # OpenAI and Anthropic API surface handlers
├── types/           # Shared TypeScript types
└── index.ts         # Fastify server entrypoint
```

### Scripts

```bash
# Development (with hot reload)
pnpm dev

# Local-only mode (no cloud calls)
pnpm dev:local-only

# Build
pnpm build

# Start (production)
pnpm start

# Test
pnpm test

# Test (watch mode)
pnpm test:watch

# Lint
pnpm lint

# Lint (auto-fix)
pnpm lint:fix

# Format
pnpm format

# Type checking
pnpm typecheck
```

## Docker Deployment

The project includes Docker configuration for easy deployment:

```bash
# Build and run
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

## Contributing

We welcome contributions! Please see `DEVELOPMENT_PLAN.md` for current priorities and the detailed roadmap.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Requirements

- Node.js 20+
- TypeScript 6+
- pnpm
- Ollama (for local execution)
- Dependencies listed in `package.json`

## Support

- **Issues**: Report bugs and request features on [GitHub Issues](https://github.com/Avocado-Pty-Ltd/LLMeld/issues)
- **Discussions**: Join the conversation in [GitHub Discussions](https://github.com/Avocado-Pty-Ltd/LLMeld/discussions)

---

**LLMeld** — Making AI development affordable through smart local compute utilisation.
