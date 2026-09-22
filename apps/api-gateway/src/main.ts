import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import type { Request, Response } from 'express';
import { HEADER_CORRELATION_ID, HEADER_USER_EMAIL, HEADER_USER_ID, HEADER_USER_ROLES } from '@lp/shared';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { correlationMiddleware } from './common/correlation.middleware';
import { courseIdForSlug, decodeAccessToken, isEntitled } from './common/entitlement';

const logger = new Logger('api-gateway');

async function bootstrap() {
  /**
   * bodyParser is OFF on purpose. The gateway streams request bodies straight
   * through to the services; parsing and re-serialising here would break the
   * Razorpay webhook signature and waste memory on video metadata.
   *
   * Typed as NestExpressApplication (rather than the generic INestApplication
   * NestFactory.create infers by default) so app.set('trust proxy', ...) below
   * resolves - that method only exists on the Express-specific application type.
   */
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cookieParser());
  app.set('trust proxy', 1);

  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
    credentials: true,
  });
  app.useGlobalFilters(new AllExceptionsFilter());

  const server = app.getHttpAdapter().getInstance();
  server.use(correlationMiddleware);

  const targets = {
    auth: process.env.AUTH_SERVICE_URL ?? 'http://localhost:4001',
    course: process.env.COURSE_SERVICE_URL ?? 'http://localhost:4002',
    enrollment: process.env.ENROLLMENT_SERVICE_URL ?? 'http://localhost:4003',
    payment: process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:4004',
    media: process.env.MEDIA_SERVICE_URL ?? 'http://localhost:4005',
    lab: process.env.LAB_SERVICE_URL ?? 'http://localhost:4006',
    quiz: process.env.QUIZ_SERVICE_URL ?? 'http://localhost:4007',
    certificate: process.env.CERT_SERVICE_URL ?? 'http://localhost:4008',
    notification: process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:4009',
  };

  /**
   * Entitlement resolution for lesson reads.
   * GET /courses/:slug/lessons/:lessonSlug  ->  adds ?entitled=true|false
   * course-service then decides how much of the lesson to return. The browser
   * cannot set this itself because we overwrite the query parameter.
   */
  server.use('/courses', async (req: Request, _res: Response, next: () => void) => {
    const match = /^\/([^/]+)\/lessons\/([^/?]+)/.exec(req.url);
    if (!match) return next();

    const claims = decodeAccessToken((req as any).cookies?.lp_access ?? bearer(req));
    let entitled = false;
    if (claims) {
      const courseId = await courseIdForSlug(match[1]);
      if (courseId) entitled = await isEntitled(claims.sub, courseId);
    }

    const [path, search = ''] = req.url.split('?');
    const params = new URLSearchParams(search);
    params.set('entitled', String(entitled));
    req.url = `${path}?${params.toString()}`;
    next();
  });

  const routes: Array<[string, string]> = [
    ['/auth', targets.auth],
    ['/courses', targets.course],
    ['/admin/courses', targets.course],
    ['/enrollments', targets.enrollment],
    ['/progress', targets.enrollment],
    ['/payments', targets.payment],
    ['/webhooks', targets.payment],
    ['/media', targets.media],
    ['/labs', targets.lab],
    ['/quizzes', targets.quiz],
    ['/admin/quizzes', targets.quiz],
    ['/certificates', targets.certificate],
    ['/notifications', targets.notification],
  ];

  /**
   * Routes that also carry a WebSocket upgrade. `/labs/ws` is the terminal
   * bridge; without ws:true the upgrade would be answered with a 404 and the
   * lab would silently never connect.
   */
  const wsRoutes = new Set(['/labs']);

  for (const [prefix, target] of routes) {
    server.use(
      prefix,
      createProxyMiddleware({
        target,
        changeOrigin: true,
        xfwd: true,
        ws: wsRoutes.has(prefix),
        // http-proxy-middleware strips the mount path, so add it back.
        pathRewrite: (path: string) => `${prefix}${path === '/' ? '' : path}`,
        proxyTimeout: 30_000,
        timeout: 30_000,
        on: {
          proxyReq: (proxyReq, req) => {
            const r = req as Request;
            proxyReq.setHeader(
              HEADER_CORRELATION_ID,
              (r.headers[HEADER_CORRELATION_ID] as string) ?? '',
            );
            // Hint headers for logging only. Services still verify the JWT
            // themselves, so a forged header buys an attacker nothing.
            const claims = decodeAccessToken((r as any).cookies?.lp_access ?? bearer(r));
            if (claims) {
              proxyReq.setHeader(HEADER_USER_ID, claims.sub);
              proxyReq.setHeader(HEADER_USER_EMAIL, claims.email);
              proxyReq.setHeader(HEADER_USER_ROLES, (claims.roles ?? []).join(','));
            }
            // Never let a client inject the internal service key.
            proxyReq.removeHeader('x-internal-key');
            fixRequestBody(proxyReq, req);
          },
          error: (err, _req, res) => {
            logger.error(`proxy error -> ${target}: ${err.message}`);
            (res as any).writeHead?.(502, { 'Content-Type': 'application/json' });
            (res as any).end?.(
              JSON.stringify({ statusCode: 502, message: 'Upstream service unavailable.' }),
            );
          },
        },
      }),
    );
  }

  const port = Number(process.env.GATEWAY_PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  logger.log(`api-gateway listening on :${port}`);
  for (const [prefix, target] of routes) logger.log(`  ${prefix.padEnd(16)} -> ${target}`);
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

void bootstrap();
