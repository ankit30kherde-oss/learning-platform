import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { AccessTokenPayload, RefreshTokenPayload, Role } from '@lp/shared';

/**
 * All token minting/verification lives here.
 *
 * Design decisions:
 *  - Access token: JWT, 15 minutes, HS256 with a dedicated secret. Short-lived
 *    so a stolen token has a small blast radius. Verified by the API gateway
 *    on every request, so no network hop to auth-service per call.
 *  - Refresh token: 256 bits of CSPRNG randomness wrapped in a JWT so it also
 *    carries sid/jti. Stored server-side as SHA-256 only, and ROTATED on every
 *    use. Re-use of an already-used token revokes the whole session (theft
 *    detection, per OAuth 2.0 BCP for public clients).
 *  - Secrets come from env, which in AWS is injected from Secrets Manager via
 *    the External Secrets Operator. They are never in Git.
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  get accessTtlSeconds(): number {
    return Number(this.config.get('JWT_ACCESS_TTL') ?? 900);
  }

  get refreshTtlSeconds(): number {
    return Number(this.config.get('JWT_REFRESH_TTL') ?? 2592000);
  }

  async signAccessToken(args: {
    userId: string;
    email: string;
    roles: Role[];
    sessionId: string;
  }): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: args.userId,
      email: args.email,
      roles: args.roles,
      sid: args.sessionId,
      typ: 'access',
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.accessTtlSeconds,
      issuer: this.config.get('JWT_ISSUER'),
      audience: this.config.get('JWT_AUDIENCE'),
    });
  }

  async signRefreshToken(args: { userId: string; sessionId: string }): Promise<{
    token: string;
    jti: string;
    expiresAt: Date;
  }> {
    const jti = randomBytes(32).toString('hex');
    const payload: RefreshTokenPayload = {
      sub: args.userId,
      sid: args.sessionId,
      jti,
      typ: 'refresh',
    };
    const token = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.refreshTtlSeconds,
      issuer: this.config.get('JWT_ISSUER'),
    });
    return { token, jti, expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000) };
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    return this.jwt.verifyAsync<RefreshTokenPayload>(token, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      issuer: this.config.get('JWT_ISSUER'),
    });
  }

  /** One-way hash for anything we persist: refresh, verification, reset tokens. */
  hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /** URL-safe single-use token for email verification / password reset. */
  randomToken(): string {
    return randomBytes(32).toString('base64url');
  }
}
