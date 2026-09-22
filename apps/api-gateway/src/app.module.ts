import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '.env'] }),
    // Edge rate limit. In production AWS WAF does the coarse blocking in front
    // of the ALB and this stays as the per-identity limit.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: Number(process.env.RATE_LIMIT_TTL ?? 60) * 1000,
        limit: Number(process.env.RATE_LIMIT_LIMIT ?? 120),
      },
    ]),
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
