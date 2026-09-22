import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { EventBus } from '@lp/shared';
import { CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [CertificatesController],
  providers: [
    CertificatesService,
    {
      provide: EventBus,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new EventBus(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          'certificate-service',
        ),
    },
  ],
})
export class CertificatesModule {}
