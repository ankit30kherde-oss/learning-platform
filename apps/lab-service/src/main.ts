import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { LabTerminalGateway } from './labs/lab-terminal.gateway';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

  app.use(helmet());
  app.use(cookieParser());
  app.set('trust proxy', 1);

  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(','),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('Lab Service')
    .setDescription('Browser Linux labs on Kubernetes')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('lp_access')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.LAB_PORT ?? 4006);
  await app.listen(port, '0.0.0.0');

  // Attach the terminal bridge to the same HTTP server, so one port serves
  // both the REST API and the WebSocket upgrade.
  app.get(LabTerminalGateway).bind(app.getHttpServer());
  new Logger('bootstrap').log(`lab-service listening on :${port} (docs at /docs)`);
}

void bootstrap();
