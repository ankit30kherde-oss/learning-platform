import { INestApplication, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ log: ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Used by e2e tests to reset state between runs. */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV === 'production') throw new Error('refusing to truncate in production');
    await this.$executeRawUnsafe(
      'TRUNCATE TABLE "audit_logs","login_attempts","verification_tokens","refresh_tokens","sessions","users" RESTART IDENTITY CASCADE',
    );
  }

  enableShutdownHooks(app: INestApplication): void {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
