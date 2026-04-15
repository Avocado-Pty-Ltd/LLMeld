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
├── config/          # Configuration loading and validation
├── gateway/         # HTTP API gateway and routing logic
├── providers/       # Provider implementations (OpenRouter, Anthropic, Ollama)
├── core/            # Core orchestration logic
├── types/           # TypeScript type definitions
└── utils/           # Utility functions (logging, cost tracking)
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
  port: 8000
  anthropic_port: 8001
  api_key: llmeld-local
  model_alias:
    - name: llmeld/planner-executor
      planner: gpt-4o-mini
      executor: local/gemma3

providers:
  openrouter:
    api_key: ${OPENROUTER_API_KEY}
  anthropic:
    api_key: ${ANTHROPIC_API_KEY}
  ollama:
    base_url: http://localhost:11434

routing:
  mode: fast
  complexity_threshold: 0.6
  privacy_mode: false

logging:
  level: info
  format: json
  trace_file: ./traces.jsonl
  track_token_costs: true
```

## Cost Analysis

LLMeld automatically logs token costs for each request when `track_token_costs: true`. View cost breakdowns:

```bash
cat traces.jsonl | jq 'select(.cost_usd) | {timestamp, model, cost_usd}'
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
