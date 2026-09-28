import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    {
      bufferLogs: false,
      rawBody: true,
    },
  );

  app.use(helmet());
  app.use(cookieParser());
  app.set('trust proxy', 1);

  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
    credentials: true,
  });

  /*
   * Razorpay webhook signature verification requires the exact raw
   * request body. Nest exposes it as req.rawBody when rawBody=true.
   *
   * Keep JSON/urlencoded parsing enabled for normal API requests.
   */
  app.use(
    json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(
    urlencoded({
      extended: true,
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('Payment Service')
    .setDescription('Razorpay payments, verification, refunds and webhooks')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('lp_access')
    .build();

  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, config),
  );

  const port = Number(process.env.PAYMENT_PORT ?? 4004);

  await app.listen(port, '0.0.0.0');

  new Logger('bootstrap').log(
    `payment-service listening on :${port} (docs at /docs)`,
  );
}

void bootstrap();
