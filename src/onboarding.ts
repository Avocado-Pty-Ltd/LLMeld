import chalk from 'chalk';
import enquirer from 'enquirer';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as dotenv from 'dotenv';

interface OnboardingConfig {
  providerType: string;
  model: string;
  apiKey: string;
  apiKeyType: string;
  loggingLevel: string;
}

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
  console.log(chalk.bold.cyan('\n Welcome to LLMeld!\n'));
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

  console.log(chalk.bold('\n1. Provider Configuration\n'));

  let apiKeyType = 'openrouter';
  let apiKey = '';

  const apiKeyChoice = await enquirer.prompt<{ provider: string }>({
    type: 'select',
    name: 'provider',
    message: 'Which API provider do you use?',
    choices: [
      { name: 'openrouter', message: 'OpenRouter (supports multiple models)' },
      { name: 'anthropic', message: 'Anthropic (Claude)' },
      { name: 'ollama', message: 'Ollama (local models)' },
    ],
  });

  apiKeyType = apiKeyChoice.provider;

  if (apiKeyChoice.provider !== 'ollama') {
    let validatedKey = '';
    let isValidKey = false;

    while (!isValidKey) {
      const keyInput = await enquirer.prompt<{ key: string }>({
        type: 'password',
        name: 'key',
        message: `Enter your ${apiKeyChoice.provider.toUpperCase()} API key:`,
      });

      if (!keyInput.key || keyInput.key.trim().length === 0) {
        console.log(chalk.red('API key cannot be empty. Please try again.'));
        continue;
      }

      if (keyInput.key.length < 10) {
        console.log(chalk.red('API key seems too short. Please verify and try again.'));
        continue;
      }

      validatedKey = keyInput.key;
      isValidKey = true;
    }

    apiKey = validatedKey;
  }

  console.log(chalk.bold('\n2. Model Selection\n'));

  const defaultModel = apiKeyType === 'anthropic'
    ? 'claude-sonnet-4-20250514'
    : apiKeyType === 'ollama'
    ? 'llama2'
    : 'anthropic/claude-sonnet-4-20250514';

  const modelInput = await enquirer.prompt<{ model: string }>({
    type: 'input',
    name: 'model',
    message: `Model to use (e.g., ${defaultModel}):`,
    initial: defaultModel,
  });

  console.log(chalk.bold('\n3. Logging Configuration\n'));

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

  return {
    providerType: apiKeyType,
    model: modelInput.model,
    apiKey,
    apiKeyType,
    loggingLevel: loggingLevel.level,
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
      console.log(chalk.green(`\n Configuration saved to ${CONFIG_PATH}`));
    } catch (error) {
      console.error(chalk.red(`Failed to write configuration file: ${error}`));
      throw error;
    }

    // Save API key to .env if provided
    if (config.apiKey) {
      const envPath = resolve(CONFIG_DIR, '.env');
      const envKey = config.apiKeyType.toUpperCase() + '_API_KEY';
      const envContent = `${envKey}="${config.apiKey}"\n`;

      try {
        if (existsSync(envPath)) {
          dotenv.config({ path: envPath });

          let existing = readFileSync(envPath, 'utf-8');
          existing = existing
            .split('\n')
            .filter((line) => !line.startsWith(envKey + '='))
            .filter((line) => line.trim())
            .join('\n');
          writeFileSync(envPath, existing + '\n' + envContent);
        } else {
          writeFileSync(envPath, envContent);
        }
        console.log(chalk.green(`API key saved to ${envPath}`));
      } catch (error) {
        console.error(chalk.red(`Failed to write .env file: ${error}`));
        throw error;
      }
    }
  } catch (error) {
    console.error(chalk.red(`\nConfiguration save failed: ${error}`));
    process.exit(1);
  }
}

function generateConfigYaml(config: OnboardingConfig): string {
  const isOllama = config.providerType === 'ollama';
  const apiKeyLine = isOllama
    ? '  api_key: "ollama"'
    : config.providerType === 'anthropic'
    ? '  api_key_env: ANTHROPIC_API_KEY'
    : '  api_key_env: OPENROUTER_API_KEY';

  const baseUrlLine = isOllama
    ? '  base_url: "http://localhost:11434/v1"'
    : config.providerType === 'openrouter'
    ? '  base_url: "https://openrouter.ai/api/v1"'
    : '';

  return `# LLMeld Configuration
# Generated by Onboarding Wizard

gateway:
  port: 8000
  api_key: llmeld-local
  model_alias: llmeld/agent

provider:
  type: ${config.providerType}
  model: ${config.model}
${apiKeyLine}
${baseUrlLine ? baseUrlLine + '\n' : ''}
agent:
  max_iterations: 15
  parallel_tools: true

logging:
  level: ${config.loggingLevel}
  format: pretty
  trace_file: ./logs/traces.jsonl
  emit_token_costs: true
`;
}

function displayCompletionSummary(config: OnboardingConfig): void {
  console.log(chalk.bold.green('\n Setup Complete!\n'));

  console.log(chalk.bold('Configuration Summary:'));
  console.log(chalk.gray('-'.repeat(50)));
  console.log(`  Provider:    ${chalk.cyan(config.providerType)}`);
  console.log(`  Model:       ${chalk.cyan(config.model)}`);
  console.log(`  Log Level:   ${chalk.cyan(config.loggingLevel)}`);
  console.log(chalk.gray('-'.repeat(50)));

  console.log(chalk.bold('\nNext Steps:\n'));

  if (config.providerType === 'ollama') {
    console.log(chalk.yellow('1. Ensure Ollama is running with your model:'));
    console.log(chalk.gray(`   ollama pull ${config.model}`));
    console.log(chalk.gray(`   ollama serve\n`));
  }

  console.log(chalk.yellow(`${config.providerType === 'ollama' ? '2' : '1'}. Start LLMeld:`));
  console.log(chalk.gray(`   pnpm dev\n`));

  const curlCommand = `curl http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer llmeld-local" -d '{"model": "llmeld/agent", "messages": [{"role": "user", "content": "Hello!"}]}'`;
  console.log(chalk.yellow(`${config.providerType === 'ollama' ? '3' : '2'}. Test with a curl request:`));
  console.log(chalk.gray(`   ${curlCommand}\n`));
}
