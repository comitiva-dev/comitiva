import pino from 'pino';

/**
 * Runner logger. Writes to stderr only: stdout is the protocol channel.
 * Level comes from COMITIVA_RUNNER_LOG (default `warn`). Secrets are redacted
 * and message content is never logged at `info` or above.
 */
export function createLogger(level = process.env.COMITIVA_RUNNER_LOG ?? 'warn'): pino.Logger {
  return pino(
    {
      name: 'comitiva-runner',
      level,
      redact: {
        paths: ['secret', '*.secret', 'secrets', '*.secrets', 'apiKey', '*.apiKey'],
        censor: '[redacted]',
      },
    },
    pino.destination({ fd: 2, sync: true }),
  );
}

export type Logger = pino.Logger;
