# LLMeld

LLMeld is a gateway that allows you to use local LLMs for local tasks and cloud services for complex tasks, with a focus on local development and deployment.

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

- **Gateway**: 
  - `host`: Bind address (default: 127.0.0.1)
  - `port`: Listening port (default: 8000)
  - `log_level`: Verbosity (`debug`, `info`, `warn`, `error`)

- **Providers**: 
  - `cloud`: Primary reasoning provider (OpenRouter, Anthropic, etc.)
  - `local`: Local execution provider (typically Ollama)
  - `fallback`: Backup cloud provider for failed local executions

- **Routing**: 
  - `mode`: `fast`, `balanced`, `best`, `cloud`, or `local`
  - `force_local_regex`: Patterns that always run locally (e.g., "password", "ssn")
  - `always_escalate_regex`: Patterns that always run in cloud (e.g., "investment strategy")

- **Logging**: 
  - `trace_log_path`: Path to detailed JSON trace log
  - `emit_token_costs`: Whether to log estimated costs
  - `dashboard_log_path`: Dashboard event log

## Usage

Start the gateway:

```bash
pnpm start
# or if using npm:
npm run start
```

Then point your tools to:

- OpenAI-compatible: `http://localhost:8000/v1`
- Anthropic-compatible: `http://localhost:8000/v1/anthropic`

### API Key Management

Store keys in environment variables:

```bash
export OPENROUTER_API_KEY="your-key-here"
export ANTHROPIC_API_KEY="your-key-here"
```

Or use a `.env` file in project root:

```bash
echo 'OPENROUTER_API_KEY="your-key-here"' > .env
```

### Docker Usage

```bash
# Build image
docker build -t llmeld .

# Run with config mounted
docker run -p 8000:8000 \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -v $(pwd)/.env:/app/.env \
  llmeld
```

### TUI Dashboard

Run with live dashboard:

```bash
pnpm dashboard
# or if using npm:
npm run dashboard
```

### Interactive Setup

For first-time configuration:

```bash
pnpm setup
# or if using npm:
npm run setup
```

### Brand Building

This repository supports building for two brands: EzyBiz and CallConcierge.
Build instructions are provided below.

#### Android

To build either brand, run:
```bash
./gradlew assembleEzyBizRelease
# or for CallConcierge:
./gradlew assembleCallConciergeRelease
```

For debugging, you can use:
```bash
./gradlew assembleEzyBizDebug
# or for CallConcierge:
./gradlew assembleCallConciergeDebug
```

#### iOS

To build for iOS, you must set the `BRAND` environment variable to either `ezybiz` or `callconcierge` when building the app.

Set your brand and build using:
```bash
export BRAND=ezybiz
# or for CallConcierge:
export BRAND=callconcierge
```

Then build with:
```bash
npx react-native run-ios
```

To use a specific scheme:
```bash
xcodebuild -scheme EzyBiz -configuration Release
# or for CallConcierge:
xcodebuild -scheme CallConcierge -configuration Release
```

## Cost Tracking

View cost breakdowns:
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