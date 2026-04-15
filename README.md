# LLMeld

**Save money with local compute**

A powerful tool for integrating, comparing, and orchestrating multiple Large Language Models (LLMs) through a unified interface, optimized for local deployment and cost efficiency.

## Overview

LLMeld enables developers and researchers to seamlessly work with multiple LLMs while minimizing costs through local compute optimization. Whether you're evaluating different models, creating ensemble systems, or managing multi-model applications, LLMeld simplifies the process while keeping expenses low.

## Features

- **Multi-Model Integration**: Load and manage various LLMs from different providers and architectures
- **Local Compute Optimization**: Reduce costs by leveraging local hardware efficiently
- **Output Comparison**: Compare responses across models with built-in analysis tools
- **Model Orchestration**: Create complex workflows involving multiple LLMs
- **Configuration Management**: Flexible system for defining and storing model configurations
- **Unified API**: Consistent interface regardless of underlying model implementation
- **Cost Tracking**: Monitor and optimize spending across different model providers
- **Extensible Architecture**: Easy to add support for new models and providers

## Installation

### Prerequisites

- Node.js 18+ 
- pnpm (recommended) or npm

### From Source

```bash
git clone https://github.com/Avocado-Pty-Ltd/LLMeld.git
cd LLMeld
pnpm install
```

### Using Docker

```bash
docker-compose up -d
```

## Configuration

Copy the example configuration and customize it for your needs:

```bash
cp config.example.yaml config.yaml
```

Edit `config.yaml` to configure your model providers, local compute settings, and cost optimization preferences.

## Quick Start

```typescript
import { LLMeld, ModelManager } from './src';

// Initialize model manager
const manager = new ModelManager();

// Add models with cost optimization
await manager.addModel({
  name: "local-llama",
  provider: "ollama",
  model: "llama2:7b",
  costPerToken: 0, // Free local compute
  priority: "high" // Prefer for cost savings
});

await manager.addModel({
  name: "gpt-4",
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  costPerToken: 0.00003, // Track API costs
  priority: "low" // Use sparingly
});

// Create LLMeld instance
const meld = new LLMeld(manager);

// Compare outputs with cost awareness
const results = await meld.compareModels({
  prompt: "Explain quantum computing",
  models: ["local-llama", "gpt-4"],
  optimizeForCost: true // Prefer cheaper options
});

console.log(results.summary());
console.log(`Total cost: $${results.totalCost}`);
```

## Development

### Project Structure

- `src/` - Main source code
- `test/` - Test files
- `config.example.yaml` - Example configuration
- `DEVELOPMENT_PLAN.md` - Detailed development roadmap

### Scripts

```bash
# Development
pnpm dev

# Build
pnpm build

# Test
pnpm test

# Lint
pnpm lint
```

### Development Setup

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Run tests
pnpm test

# Type checking
pnpm type-check
```

## Docker Deployment

The project includes Docker configuration for easy deployment:

```bash
# Build and run
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## Configuration Options

Key configuration areas in `config.yaml`:

- **Models**: Configure local and API-based models
- **Cost Optimization**: Set spending limits and preferences
- **Performance**: Tune local compute settings
- **Providers**: API keys and endpoints
- **Workflows**: Default orchestration patterns

## Examples

Check the `test/` directory for usage examples and the `DEVELOPMENT_PLAN.md` for detailed implementation guidelines.

## Cost Optimization Features

- **Local-First Strategy**: Prioritize local models when possible
- **Smart Fallbacks**: Use API models only when local options insufficient  
- **Cost Tracking**: Real-time monitoring of API usage costs
- **Spending Limits**: Configurable budgets and alerts
- **Batch Processing**: Optimize requests to reduce API calls

## Contributing

We welcome contributions! Please see the development plan in `DEVELOPMENT_PLAN.md` for current priorities.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## Requirements

- Node.js 18+
- TypeScript 5+
- Dependencies listed in `package.json`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **Issues**: Report bugs and request features on [GitHub Issues](https://github.com/Avocado-Pty-Ltd/LLMeld/issues)
- **Discussions**: Join the conversation in [GitHub Discussions](https://github.com/Avocado-Pty-Ltd/LLMeld/discussions)

## Roadmap

See `DEVELOPMENT_PLAN.md` for the complete roadmap. Key upcoming features:

- [ ] Advanced local model optimization
- [ ] Real-time cost analytics dashboard  
- [ ] Enhanced provider integrations
- [ ] Performance benchmarking tools
- [ ] Web-based management interface

## Acknowledgments

- Built for cost-conscious AI developers
- Optimized for local compute efficiency
- Designed with modern TypeScript best practices

---

**LLMeld** - Making AI development affordable through smart local compute utilization.