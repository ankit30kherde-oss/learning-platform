import { Test } from '@nestjs/testing';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { TokensService } from './tokens.service';
import { Role } from '@lp/shared';

describe('TokensService', () => {
  let tokens: TokensService;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = 'test_access_secret_value_long_enough';
    process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_value_long_enough';
    process.env.JWT_ACCESS_TTL = '900';
    process.env.JWT_REFRESH_TTL = '3600';
    process.env.JWT_ISSUER = 'test-issuer';
    process.env.JWT_AUDIENCE = 'test-aud';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({})],
      providers: [TokensService],
    }).compile();

    tokens = moduleRef.get(TokensService);
  });

  it('signs an access token carrying sub, roles and session id', async () => {
    const jwt = await tokens.signAccessToken({
      userId: 'u-1',
      email: 'a@b.com',
      roles: [Role.STUDENT],
      sessionId: 's-1',
    });
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    expect(claims.sub).toBe('u-1');
    expect(claims.roles).toEqual(['STUDENT']);
    expect(claims.sid).toBe('s-1');
    expect(claims.typ).toBe('access');
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('produces a unique jti per refresh token', async () => {
    const a = await tokens.signRefreshToken({ userId: 'u-1', sessionId: 's-1' });
    const b = await tokens.signRefreshToken({ userId: 'u-1', sessionId: 's-1' });
    expect(a.jti).not.toBe(b.jti);
    expect(a.token).not.toBe(b.token);
  });

  it('verifies its own refresh tokens and rejects tampered ones', async () => {
    const { token } = await tokens.signRefreshToken({ userId: 'u-9', sessionId: 's-9' });
    const payload = await tokens.verifyRefreshToken(token);
    expect(payload.sub).toBe('u-9');
    await expect(tokens.verifyRefreshToken(token + 'x')).rejects.toBeDefined();
  });

  it('hashes deterministically and never stores the raw value', () => {
    const raw = tokens.randomToken();
    expect(tokens.hash(raw)).toBe(tokens.hash(raw));
    expect(tokens.hash(raw)).toHaveLength(64);
    expect(tokens.hash(raw)).not.toContain(raw);
  });
});
