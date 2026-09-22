import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { EVENTS, EventBus, EventEnvelope } from '@lp/shared';
import { EnrollmentsController, EnrollmentsInternalController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';
import { ProgressController } from '../progress/progress.controller';
import { ProgressService } from '../progress/progress.service';

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [EnrollmentsController, EnrollmentsInternalController, ProgressController],
  providers: [
    EnrollmentsService,
    ProgressService,
    {
      provide: EventBus,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new EventBus(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          'enrollment-service',
        ),
    },
  ],
  exports: [EnrollmentsService],
})
export class EnrollmentsModule implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly enrollments: EnrollmentsService,
  ) {}

  /**
   * Subscriptions start with the module. In AWS this becomes an SQS consumer
   * loop over a queue subscribed to the EventBridge bus; the handler bodies
   * below do not change.
   */
  async onModuleInit(): Promise<void> {
    await this.bus.subscribe(
      [EVENTS.PAYMENT_COMPLETED, EVENTS.PAYMENT_REFUNDED],
      async (evt: EventEnvelope<any>) => {
        if (evt.name === EVENTS.PAYMENT_COMPLETED) {
          await this.enrollments.handlePaymentCompleted(evt);
        } else {
          await this.enrollments.handlePaymentRefunded(evt);
        }
      },
    );
  }
}
