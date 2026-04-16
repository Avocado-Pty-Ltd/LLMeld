export interface CapturedLine {
  timestamp: number;
  level: 'log' | 'warn' | 'error';
  text: string;
}

const capturedLines: CapturedLine[] = [];
const MAX_CAPTURED = 500;
let originalConsole: {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
} | null = null;

export function installCapture(): void {
  if (originalConsole) return; // already installed

  originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const capture =
    (level: CapturedLine['level']) =>
    (...args: unknown[]) => {
      const text = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      capturedLines.push({ timestamp: Date.now(), level, text });
      if (capturedLines.length > MAX_CAPTURED) capturedLines.shift();
      // Swallow output — the dashboard owns the screen
    };

  console.log = capture('log');
  console.warn = capture('warn');
  console.error = capture('error');
}

export function uninstallCapture(): void {
  if (originalConsole) {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    originalConsole = null;
  }
}

export function getCapturedLines(): CapturedLine[] {
  return capturedLines;
}
