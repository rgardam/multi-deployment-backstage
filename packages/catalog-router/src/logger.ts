const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;
export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

/** JSON lines, in the same shape as the Backstage backends' production logs. */
export function createLogger(
  level: string = 'info',
  write: (line: string) => void = line => process.stdout.write(`${line}\n`),
): Logger {
  const threshold = LEVELS[level as LogLevel] ?? LEVELS.info;
  const log =
    (lvl: LogLevel) =>
    (message: string, meta: LogMeta = {}) => {
      if (LEVELS[lvl] >= threshold) {
        write(
          JSON.stringify({
            level: lvl,
            message,
            service: 'catalog-router',
            timestamp: new Date().toISOString(),
            ...meta,
          }),
        );
      }
    };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}
