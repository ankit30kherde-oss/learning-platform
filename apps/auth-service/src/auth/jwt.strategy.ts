import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AccessTokenPayload } from '@lp/shared';
import { PrismaService } from '../prisma/prisma.service';

export const ACCESS_COOKIE = 'lp_access';
export const REFRESH_COOKIE = 'lp_refresh';

/** Read the access token from the HttpOnly cookie first, then Bearer header. */
function extractJwt(req: Request): string | null {
  const fromCookie = (req as any)?.cookies?.[ACCESS_COOKIE];
  if (fromCookie) return fromCookie;
  return ExtractJwt.fromAuthHeaderAsBearerToken()(req);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: extractJwt,
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      issuer: config.get<string>('JWT_ISSUER'),
      audience: config.get<string>('JWT_AUDIENCE'),
    });
  }

  async validate(payload: AccessTokenPayload) {
    if (payload.typ !== 'access') throw new UnauthorizedException('Wrong token type.');

    // Session check makes access tokens revocable within their 15-minute window.
    const session = await this.prisma.session.findUnique({ where: { id: payload.sid } });
    if (!session || session.revokedAt) throw new UnauthorizedException('Session revoked.');

    return { userId: payload.sub, email: payload.email, roles: payload.roles, sessionId: payload.sid };
  }
}
