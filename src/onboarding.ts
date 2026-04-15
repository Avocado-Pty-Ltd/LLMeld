import chalk from 'chalk';
import enquirer from 'enquirer';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as dotenv from 'dotenv';

interface OnboardingConfig {
  routingMode: string;
  plannerProvider: string;
  executorProvider: string;
  plannerModel: string;
  executorModel: string;
  apiKey: string;
  apiKeyType: string;
  loggingLevel: string;
  privacyMode: boolean;
}

// Model validation patterns for different providers
const MODEL_PATTERNS = {
  openrouter: /^[a-z0-9]+\/[a-z0-9\-]+$/i,
  anthropic: /^claude-\d+-[\w]+(-\d+)?$/i,
  ollama: /^[\w\-]+$/i,
};

// Support both LLMELD_CONFIG (file path) and LLMELD_CONFIG_DIR (directory) conventions
const CONFIG_DIR = process.env.LLMELD_CONFIG
  ? resolve(process.env.LLMELD_CONFIG).split('/').slice(0, -1).join('/')
  : process.env.LLMELD_CONFIG_DIR
  ? resolve(process.env.LLMELD_CONFIG_DIR)
  : resolve('.');
const CONFIG_PATH = process.env.LLMELD_CONFIG
  ? resolve(process.env.LLMELD_CONFIG)
  : resolve(CONFIG_DIR, 'config.yaml');

export async function runOnboardingWizard(): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan('\n🥑 Welcome to LLMeld!\n'));
  console.log(chalk.gray('This wizard will help you set up LLMeld for your environment.\n'));

  const config = await collectConfiguration();
  await saveConfiguration(config);

  displayCompletionSummary(config);
}

async function collectConfiguration(): Promise<OnboardingConfig> {
  // Check if config already exists
  if (existsSync(CONFIG_PATH)) {
    const overwrite = await enquirer.prompt<{ shouldOverwrite: boolean }>({
      type: 'confirm',
      name: 'shouldOverwrite',
      message: chalk.bold(
        `Configuration file already exists:\n  ${chalk.cyan(CONFIG_PATH)}\n\nOverwrite?`
      ),
      initial: false,
    });

    if (!overwrite.shouldOverwrite) {
      console.log(chalk.yellow('\nSetup cancelled. Using existing configuration.'));
      throw new Error('Wizard cancelled by user');
    }
  }

  console.log(chalk.bold('\n1. Routing Configuration\n'));
  const routingMode = await enquirer.prompt<{ mode: string }>({
    type: 'select',
    name: 'mode',
    message: 'Which routing mode do you prefer?',
    choices: [
      { name: 'balanced', message: 'Balanced - Mix of cost savings and quality' },
      { name: 'best', message: 'Best - Always use cloud models for best results' },
      { name: 'fast', message: 'Fast - Prioritize local execution for speed' },
      { name: 'cloud', message: 'Cloud-only - No local execution' },
      { name: 'local', message: 'Local-only - No cloud usage (privacy mode)' },
    ],
  });

  console.log(chalk.bold('\n2. Provider Configuration\n'));

  let apiKeyType = 'openrouter';
  let apiKey = '';

  const apiKeyChoice = await enquirer.prompt<{ provider: string }>({
    type: 'select',
    name: 'provider',
    message: 'Which API provider do you use?',
    choices: [
      { name: 'openrouter', message: 'OpenRouter (supports multiple models)' },
      { name: 'anthropic', message: 'Anthropic (Claude)' },
      { name: 'skip', message: 'Skip for now (local-only mode)' },
    ],
  });

  apiKeyType = apiKeyChoice.provider;

  if (apiKeyChoice.provider !== 'skip') {
    let validatedKey = '';
    let isValidKey = false;

    while (!isValidKey) {
      const keyInput = await enquirer.prompt<{ key: string }>({
        type: 'password',
        name: 'key',
        message: `Enter your ${apiKeyChoice.provider.toUpperCase()} API key:`,
      });

      // Validate API key format
      if (!keyInput.key || keyInput.key.trim().length === 0) {
        console.log(chalk.red('✗ API key cannot be empty. Please try again.'));
        continue;
      }

      if (keyInput.key.length < 10) {
        console.log(chalk.red('✗ API key seems too short. Please verify and try again.'));
        continue;
      }

      validatedKey = keyInput.key;
      isValidKey = true;
    }

    apiKey = validatedKey;
  }

  console.log(chalk.bold('\n3. Model Selection\n'));

  let plannerModelValid = false;
  let plannerModel = '';

  while (!plannerModelValid) {
    const plannerInput = await enquirer.prompt<{ model: string }>({
      type: 'input',
      name: 'model',
      message: 'Cloud planner model (e.g., openai/gpt-4, claude-3-opus):',
      initial: 'openai/gpt-4-turbo',
    });

    // Validate planner model format
    const pattern = apiKeyType === 'anthropic' 
      ? MODEL_PATTERNS.anthropic 
      : MODEL_PATTERNS.openrouter;

    if (pattern.test(plannerInput.model)) {
      plannerModel = plannerInput.model;
      plannerModelValid = true;
    } else {
      console.log(
        chalk.red(
          `✗ Invalid model format. Expected format for ${apiKeyType}: ${
            apiKeyType === 'anthropic' ? 'claude-3-opus' : 'provider/model-name'
          }`
        )
      );
    }
  }

  let executorModelValid = false;
  let executorModel = '';

  while (!executorModelValid) {
    const executorInput = await enquirer.prompt<{ model: string }>({
      type: 'input',
      name: 'model',
      message: 'Local executor model (must be available in Ollama, e.g., llama2, mistral):',
      initial: 'llama2',
    });

    // Validate executor model format (Ollama models)
    if (MODEL_PATTERNS.ollama.test(executorInput.model)) {
      executorModel = executorInput.model;
      executorModelValid = true;
    } else {
      console.log(chalk.red('✗ Invalid model name. Use only alphanumeric characters and hyphens.'));
    }
  }

  console.log(chalk.bold('\n4. Logging Configuration\n'));

  const loggingLevel = await enquirer.prompt<{ level: string }>({
    type: 'select',
    name: 'level',
    message: 'What logging level do you prefer?',
    choices: [
      { name: 'error', message: 'Error - Only error messages' },
      { name: 'warn', message: 'Warn - Warnings and errors' },
      { name: 'info', message: 'Info - General information (recommended)' },
      { name: 'debug', message: 'Debug - Detailed debugging information' },
    ],
  });

  console.log(chalk.bold('\n5. Privacy Configuration\n'));

  const privacyMode = await enquirer.prompt<{ privacy: boolean }>({
    type: 'confirm',
    name: 'privacy',
    message: 'Enable strict privacy mode (no cloud escalation, only local execution)?',
    initial: false,
  });

  return {
    routingMode: routingMode.mode,
    plannerProvider: apiKeyType,
    executorProvider: 'ollama',
    plannerModel: plannerModel,
    executorModel: executorModel,
    apiKey,
    apiKeyType,
    loggingLevel: loggingLevel.level,
    privacyMode: privacyMode.privacy,
  };
}

async function saveConfiguration(config: OnboardingConfig): Promise<void> {
  try {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    const yaml = generateConfigYaml(config);

    try {
      writeFileSync(CONFIG_PATH, yaml);
      console.log(chalk.green(`\n✓ Configuration saved to ${CONFIG_PATH}`));
    } catch (error) {
      console.error(chalk.red(`✗ Failed to write configuration file: ${error}`));
      throw error;
    }

    // Save API key to .env if provided
    if (config.apiKey) {
      const envPath = resolve(CONFIG_DIR, '.env');
      const envKey = config.apiKeyType.toUpperCase() + '_API_KEY';
      const envContent = `${envKey}="${config.apiKey}"\n`;

      try {
        if (existsSync(envPath)) {
          // Load existing .env file first
          dotenv.config({ path: envPath });

          let existing = readFileSync(envPath, 'utf-8');
          // Remove existing key if present
          existing = existing
            .split('\n')
            .filter((line) => !line.startsWith(envKey + '='))
            .filter((line) => line.trim())
            .join('\n');
          writeFileSync(envPath, existing + '\n' + envContent);
        } else {
          writeFileSync(envPath, envContent);
        }
        console.log(chalk.green(`✓ API key saved to ${envPath}`));
      } catch (error) {
        console.error(chalk.red(`✗ Failed to write .env file: ${error}`));
        throw error;
      }
    }
  } catch (error) {
    console.error(chalk.red(`\n✗ Configuration save failed: ${error}`));
    process.exit(1);
  }
}

function generateConfigYaml(config: OnboardingConfig): string {
  const plannerProvider =
    config.apiKeyType === 'anthropic' ? 'anthropic' : 'openrouter';

  return `# LLMeld Configuration
# Generated by TUI Onboarding Wizard

gateway:
  openai_port: 8000
  api_key: llmeld-local
  model_alias: llmeld/planner-executor

providers:
  planner:
    type: ${plannerProvider}
    model: ${config.plannerModel}
    ${
      plannerProvider === 'anthropic'
        ? 'api_key_env: ANTHROPIC_API_KEY'
        : 'api_key_env: OPENROUTER_API_KEY'
    }

  executor:
    type: ollama
    model: ${config.executorModel}
    base_url: "http://localhost:11434/v1"

  fallback:
    type: ${plannerProvider}
    model: ${config.plannerModel}
    ${
      plannerProvider === 'anthropic'
        ? 'api_key_env: ANTHROPIC_API_KEY'
        : 'api_key_env: OPENROUTER_API_KEY'
    }

routing:
  default_mode: ${config.routingMode}
  privacy_mode: ${config.privacyMode}
  simple_threshold: 500
  complex_threshold: 1500

logging:
  level: ${config.loggingLevel}
  format: pretty
  trace_file: ./logs/traces.jsonl
  emit_token_costs: true
`;
}

function displayCompletionSummary(config: OnboardingConfig): void {
  console.log(chalk.bold.green('\n✨ Setup Complete!\n'));

  console.log(chalk.bold('Configuration Summary:'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  Routing Mode:      ${chalk.cyan(config.routingMode)}`);
  console.log(`  Planner Model:     ${chalk.cyan(config.plannerModel)}`);
  console.log(`  Executor Model:    ${chalk.cyan(config.executorModel)}`);
  console.log(`  Logging Level:     ${chalk.cyan(config.loggingLevel)}`);
  console.log(`  Privacy Mode:      ${chalk.cyan(config.privacyMode ? 'Enabled' : 'Disabled')}`);
  console.log(chalk.gray('─'.repeat(50)));

  console.log(chalk.bold('\n📚 Next Steps:\n'));

  if (config.executorModel && config.executorModel !== 'skip') {
    console.log(chalk.yellow('1. Ensure Ollama is running with your executor model:'));
    console.log(chalk.gray(`   ollama pull ${config.executorModel}`));
    console.log(chalk.gray(`   ollama serve\n`));
  }

  console.log(chalk.yellow('2. Start LLMeld:'));
  console.log(chalk.gray(`   pnpm dev\n`));

  console.log(chalk.yellow('3. Test with a curl request:'));
  const curlCommand = `curl http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer llmeld-local" -d '{"model": "llmeld/planner-executor", "messages": [{"role": "user", "content": "Hello!"}]}'`;
  console.log(chalk.gray(`   ${curlCommand}\n`));

  console.log(chalk.blue('📖 For more information, see: https://github.com/Avocado-Pty-Ltd/LLMeld\n'));
}
