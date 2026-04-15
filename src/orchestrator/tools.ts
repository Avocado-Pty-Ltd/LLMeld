import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { NormalisedTool } from '../types/normalised.js';

const MAX_OUTPUT_CHARS = 4000;

export const TOOL_DEFINITIONS: NormalisedTool[] = [
  {
    type: 'function',
    function: {
      name: 'shell_exec',
      description:
        'Run a shell command and return its output. Use for git, gh, npm, curl, ls, grep, and other CLI tools. Commands run in the current working directory.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the full file content as text.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to read (absolute or relative to cwd)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file. Creates the file and parent directories if they do not exist. Overwrites existing content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
];

function truncate(text: string): { output: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { output: text, truncated: false };
  }
  return {
    output: text.slice(0, MAX_OUTPUT_CHARS) + `\n\n[... truncated, ${text.length} chars total]`,
    truncated: true,
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ output: string; truncated: boolean }> {
  switch (name) {
    case 'shell_exec': {
      const command = String(args.command ?? '');
      if (!command) return { output: 'Error: no command provided', truncated: false };
      try {
        const stdout = execSync(command, {
          encoding: 'utf-8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return truncate(stdout);
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; status?: number };
        const output = [
          execErr.stdout ? `stdout:\n${execErr.stdout}` : '',
          execErr.stderr ? `stderr:\n${execErr.stderr}` : '',
          `exit_code: ${execErr.status ?? 1}`,
        ]
          .filter(Boolean)
          .join('\n');
        return truncate(output || `Command failed: ${String(err)}`);
      }
    }

    case 'read_file': {
      const path = String(args.path ?? '');
      if (!path) return { output: 'Error: no path provided', truncated: false };
      try {
        const content = readFileSync(path, 'utf-8');
        return truncate(content);
      } catch (err) {
        return { output: `Error reading file: ${err instanceof Error ? err.message : err}`, truncated: false };
      }
    }

    case 'write_file': {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      if (!path) return { output: 'Error: no path provided', truncated: false };
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, 'utf-8');
        return { output: `Successfully wrote ${content.length} bytes to ${path}`, truncated: false };
      } catch (err) {
        return { output: `Error writing file: ${err instanceof Error ? err.message : err}`, truncated: false };
      }
    }

    default:
      return { output: `Unknown tool: ${name}`, truncated: false };
  }
}
