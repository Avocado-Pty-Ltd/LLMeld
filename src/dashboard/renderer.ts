import chalk from 'chalk';
import type { DashboardStats, RecentRequest } from './stats.js';
import type { CapturedLine } from './console-capture.js';
import type { LLMeldConfig } from '../types/config.js';

function pad(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}

function rpad(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : ' '.repeat(width - str.length) + str;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function truncateModel(model: string, maxLen: number): string {
  return model.length > maxLen ? model.slice(0, maxLen - 1) + '\u2026' : model;
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function hline(width: number, left = '\u250c', right = '\u2510', fill = '\u2500'): string {
  return left + fill.repeat(Math.max(0, width - 2)) + right;
}

function separator(width: number): string {
  return '\u251c' + '\u2500'.repeat(Math.max(0, width - 2)) + '\u2524';
}

function row(content: string, width: number): string {
  const visible = stripAnsi(content);
  const padding = Math.max(0, width - 2 - visible.length);
  return '\u2502' + content + ' '.repeat(padding) + '\u2502';
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function renderStatsView(
  stats: DashboardStats,
  config: LLMeldConfig,
  uptime: number,
  cols: number,
  rows: number,
): string[] {
  const w = Math.max(60, cols);
  const lines: string[] = [];

  // Header
  lines.push(hline(w));
  const title = ` ${chalk.bold.cyan('LLMeld')}  ${chalk.dim(`OpenAI :${config.gateway.openai_port}`)}  ${chalk.dim(`Anthropic :${config.gateway.anthropic_port}`)}  ${chalk.dim(`Mode: ${config.routing.default_mode}`)} `;
  lines.push(row(title, w));
  const controls = ` ${chalk.dim(`Uptime: ${formatUptime(uptime)}`)}  ${chalk.yellow('Q')}${chalk.dim(':quit')}  ${chalk.yellow('L')}${chalk.dim(':logs')}  ${chalk.yellow('C')}${chalk.dim(':clear')} `;
  lines.push(row(controls, w));

  // Model info — show planner_models (coding/general) if configured, otherwise the base planner model
  const pm = config.routing.planner_models;
  const plannerPart = pm?.coding || pm?.general
    ? [
        pm.coding ? `${chalk.dim('Coding:')} ${chalk.white(truncateModel(pm.coding, 26))}` : '',
        pm.general ? `${chalk.dim('General:')} ${chalk.white(truncateModel(pm.general, 26))}` : '',
      ].filter(Boolean).join('  ')
    : `${chalk.dim('Planner:')} ${chalk.white(truncateModel(config.providers.planner.model, 28))}`;
  const executorModel = truncateModel(config.providers.executor.model, 28);
  const fallbackPart = config.providers.fallback
    ? `  ${chalk.dim('Fallback:')} ${chalk.white(truncateModel(config.providers.fallback.model, 20))}`
    : '';
  const modelsLine = ` ${plannerPart}  ${chalk.dim('Executor:')} ${chalk.white(executorModel)}${fallbackPart} `;
  lines.push(row(modelsLine, w));

  lines.push(separator(w));

  // Stats summary
  const avgLatency =
    stats.totalRequests > 0
      ? formatMs(Math.round(stats.latencySum / stats.totalRequests))
      : '—';
  const cost = ((stats.totalTokens / 1000) * 0.003).toFixed(4);
  lines.push(
    row(
      ` ${chalk.bold('Requests:')} ${chalk.white(String(stats.totalRequests))}    ${chalk.bold('Avg Latency:')} ${chalk.white(avgLatency)}    ${chalk.bold('Tokens:')} ${chalk.white(formatTokens(stats.totalTokens))}    ${chalk.bold('Cost:')} ${chalk.white(`$${cost}`)} `,
      w,
    ),
  );

  const direct = stats.byRoute.direct;
  const pe = stats.byRoute['planner-executor'];
  const total = stats.totalRequests;
  lines.push(
    row(
      ` ${chalk.green(`Direct: ${direct}`)} ${chalk.dim(`(${pct(direct, total)})`)}    ${chalk.blue(`Planner-Executor: ${pe}`)} ${chalk.dim(`(${pct(pe, total)})`)}    ${stats.totalErrors > 0 ? chalk.red(`Errors: ${stats.totalErrors}`) : chalk.dim('Errors: 0')} `,
      w,
    ),
  );
  lines.push(row('', w));

  // Distribution columns
  const col1 = `${chalk.bold('ROUTES')}`;
  const col2 = `${chalk.bold('TASK TYPES')}`;
  const col3 = `${chalk.bold('SURFACES')}`;
  lines.push(row(` ${pad(col1, 20)}${pad(col2, 20)}${col3} `, w));

  const routeRows: [string, string, string][] = [
    [
      `executor  ${rpad(String(stats.byProvider.executor), 4)}`,
      `coding   ${rpad(String(stats.byTaskType.coding), 4)}`,
      `openai    ${rpad(String(stats.bySurface.openai), 4)}`,
    ],
    [
      `planner   ${rpad(String(stats.byProvider.planner), 4)}`,
      `general  ${rpad(String(stats.byTaskType.general), 4)}`,
      `anthropic ${rpad(String(stats.bySurface.anthropic), 4)}`,
    ],
    [`fallback  ${rpad(String(stats.byProvider.fallback), 4)}`, '', ''],
  ];

  for (const [r, t, s] of routeRows) {
    lines.push(row(` ${chalk.dim(pad(r, 20))}${chalk.dim(pad(t, 20))}${chalk.dim(s)} `, w));
  }

  lines.push(separator(w));

  // Recent requests
  lines.push(row(` ${chalk.bold('RECENT REQUESTS')} `, w));
  const availableRows = Math.max(3, rows - lines.length - 2);
  const recent = stats.recentRequests.slice(0, availableRows);
  if (recent.length === 0) {
    lines.push(row(` ${chalk.dim('  No requests yet...')} `, w));
  } else {
    for (const req of recent) {
      lines.push(row(formatRecentRequest(req, w), w));
    }
  }

  // Fill remaining space
  const remaining = rows - lines.length - 1;
  for (let i = 0; i < remaining; i++) {
    lines.push(row('', w));
  }

  // Bottom border
  lines.push(hline(w, '\u2514', '\u2518'));

  // Append clear-to-end-of-line on each line
  return lines.map((l) => l + '\x1b[K');
}

function formatRecentRequest(req: RecentRequest, _w: number): string {
  const time = new Date(req.timestamp).toLocaleTimeString('en-AU', { hour12: false });
  const surface = pad(req.surface, 9);
  const path =
    req.path === 'planner-executor'
      ? chalk.blue(pad('plan\u2192planner', 15))
      : chalk.green(pad(`direct\u2192${req.provider}`, 15));
  const taskType = pad(req.taskType, 8);
  const latency = rpad(formatMs(req.latencyMs), 7);
  const tokens = rpad(formatTokens(req.tokens), 6);
  const errMark = req.error ? chalk.red(' ERR') : '';
  return ` ${chalk.dim(time)}  ${chalk.dim(surface)}${path} ${chalk.dim(taskType)} ${latency} ${chalk.dim(tokens + ' tok')}${errMark} `;
}

export function renderLogView(
  logLines: CapturedLine[],
  scrollOffset: number,
  cols: number,
  rows: number,
): string[] {
  const w = Math.max(60, cols);
  const lines: string[] = [];

  lines.push(hline(w));
  lines.push(
    row(
      ` ${chalk.bold.cyan('LLMeld Logs')}  ${chalk.yellow('L')}${chalk.dim(':back')}  ${chalk.yellow('\u2191\u2193')}${chalk.dim(':scroll')}  ${chalk.yellow('Q')}${chalk.dim(':quit')} `,
      w,
    ),
  );
  lines.push(separator(w));

  const availableRows = rows - lines.length - 1;

  if (logLines.length === 0) {
    lines.push(row(` ${chalk.dim('  No log entries yet...')} `, w));
    for (let i = 0; i < availableRows - 1; i++) {
      lines.push(row('', w));
    }
  } else {
    // Show from newest, offset by scroll
    const end = logLines.length - scrollOffset;
    const start = Math.max(0, end - availableRows);
    const visible = logLines.slice(start, end);

    for (const entry of visible) {
      const time = new Date(entry.timestamp).toLocaleTimeString('en-AU', { hour12: false });
      const levelColor =
        entry.level === 'error'
          ? chalk.red
          : entry.level === 'warn'
            ? chalk.yellow
            : chalk.dim;
      const text = entry.text.slice(0, w - 20);
      lines.push(row(` ${chalk.dim(time)} ${levelColor(text)} `, w));
    }

    // Fill remaining
    const remaining = availableRows - visible.length;
    for (let i = 0; i < remaining; i++) {
      lines.push(row('', w));
    }
  }

  lines.push(hline(w, '\u2514', '\u2518'));
  return lines.map((l) => l + '\x1b[K');
}
