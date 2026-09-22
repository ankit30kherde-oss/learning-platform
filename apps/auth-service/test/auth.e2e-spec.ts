/**
 * Exercises the auth flow against a real, running Postgres (CI provisions one;
 * see .github/workflows/ci.yml). This is deliberately not mocked: the thing
 * worth testing here - bcrypt hashing round-tripping, unique email
 * constraints, refresh token rotation actually rotating - only fails when the
 * real database and the real crypto are involved.
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Auth flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const email = `e2e-${Date.now()}@example.com`;
  const password = 'Correct-Horse-9';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  it('rejects a weak password', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'short', fullName: 'Test User' })
      .expect(400);
  });

  it('registers a new user', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, fullName: 'Test User' })
      .expect(201);
  });

  it('does not leak whether an email is already registered', async () => {
    // A duplicate registration and a registration with a brand-new email
    // return the same shape and the same status - see auth.service.ts.
    const dup = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, fullName: 'Test User' });
    expect(dup.status).toBe(201);
  });

  it('rejects login before the email is verified is NOT required, but wrong password is rejected', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password-here' })
      .expect(401);
  });

  it('logs in and sets HttpOnly cookies', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('lp_access=') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('lp_refresh=') && c.includes('HttpOnly'))).toBe(true);
  });

  it('rotates the refresh token and rejects reuse of the old one', async () => {
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password });
    const cookieHeader = (login.headers['set-cookie'] as unknown as string[]).join('; ');

    const first = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieHeader)
      .expect(200);

    const rotatedCookie = (first.headers['set-cookie'] as unknown as string[]).join('; ');
    expect(rotatedCookie).not.toEqual(cookieHeader);

    // Reusing the ORIGINAL refresh token after rotation must fail - this is
    // the theft-detection property, and it is the whole reason tokens rotate.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieHeader)
      .expect(401);
  });

  it('locks the account after repeated failed logins', async () => {
    const attempts = Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5);
    for (let i = 0; i < attempts; i++) {
      await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'nope-nope' });
    }
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password }); // even the CORRECT password is now locked out
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/locked|too many/i);
  });
});
