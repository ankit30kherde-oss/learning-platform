import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { HEADER_CORRELATION_ID } from '@lp/shared';

/** Uniform error body across every service. Never leaks stack traces. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload =
      exception instanceof HttpException ? exception.getResponse() : 'Internal server error';

    const body = {
      statusCode: status,
      error: typeof payload === 'string' ? payload : (payload as any).error ?? 'Error',
      message: typeof payload === 'string' ? payload : (payload as any).message ?? payload,
      path: req.originalUrl,
      correlationId: req.headers[HEADER_CORRELATION_ID] as string | undefined,
      timestamp: new Date().toISOString(),
    };

    if (status >= 500) {
      this.logger.error({ ...body, stack: (exception as Error)?.stack }, 'unhandled error');
    }
    res.status(status).json(body);
  }
}
