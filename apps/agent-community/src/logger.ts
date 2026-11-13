const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export type Logger = Record<Level, (message: string, fields?: Record<string, unknown>) => void>;

export function createLogger(minLevel: Level = "info", sink: (line: string) => void = l => process.stdout.write(`${l}\n`)): Logger {
  const make = (level: Level) => (message: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level, service: "agent-community", message, ...fields }));
  };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
