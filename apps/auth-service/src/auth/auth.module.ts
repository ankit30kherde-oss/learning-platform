import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { EventBus } from '@lp/shared';
import { AuthController } from './auth.controller';
import { UsersInternalController } from './users.internal.controller';
import { AuthService } from './auth.service';
import { TokensService } from './tokens.service';
import { JwtStrategy } from './jwt.strategy';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    ConfigModule,
    MailModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    JwtModule.register({}), // secrets passed per-sign call in TokensService
  ],
  controllers: [AuthController, UsersInternalController],
  providers: [
    AuthService,
    TokensService,
    JwtStrategy,
    {
      provide: EventBus,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new EventBus(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', 'auth-service'),
    },
  ],
  exports: [AuthService, TokensService],
})
export class AuthModule {}
