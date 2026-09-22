import pino from 'pino';

/**
 * Structured JSON logging. In EKS the container's stdout is scraped by
 * Fluent Bit -> CloudWatch Logs, so JSON on stdout is all we need.
 * Never log tokens, passwords, OTPs, card data or full request bodies.
 */
export function createLogger(service: string) {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service, env: process.env.NODE_ENV ?? 'development' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'password',
        '*.password',
        'refreshToken',
        '*.refreshToken',
        'razorpay_signature',
      ],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
