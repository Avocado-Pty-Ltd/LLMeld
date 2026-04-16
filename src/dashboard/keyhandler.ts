import readline from 'node:readline';

export type KeyAction = () => void;

let rl: readline.Interface | null = null;

export function setupKeyHandler(handlers: Record<string, KeyAction>): void {
  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on('keypress', (_str: string, key: readline.Key) => {
    if (!key) return;

    // Ctrl+C always exits
    if (key.ctrl && key.name === 'c') {
      handlers['q']?.();
      return;
    }

    const handler = handlers[key.name ?? ''];
    if (handler) handler();
  });
}

export function teardownKeyHandler(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  if (rl) {
    rl.close();
    rl = null;
  }
}
