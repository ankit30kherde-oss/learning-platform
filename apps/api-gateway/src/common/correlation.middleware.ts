import { NextFunction, Request, Response } from 'express';
import { HEADER_CORRELATION_ID, newCorrelationId } from '@lp/shared';

/**
 * One id per request, generated at the edge and forwarded to every service and
 * every log line. This is what turns several services' logs into a single
 * trace you can follow in CloudWatch Logs Insights.
 *
 * Registered as plain Express middleware in main.ts so it runs before the
 * proxies (Nest's own router is mounted last).
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[HEADER_CORRELATION_ID] as string | undefined;
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : newCorrelationId();
  req.headers[HEADER_CORRELATION_ID] = id;
  res.setHeader(HEADER_CORRELATION_ID, id);
  next();
}
