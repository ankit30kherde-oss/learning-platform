import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { Role as PrismaRole, TokenPurpose, User, UserStatus } from '@prisma/client';
import { EVENTS, EventBus, Role, UserRegisteredEvent } from '@lp/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from './tokens.service';
import { MailService } from '../mail/mail.service';
import { ChangePasswordDto, LoginDto, RegisterDto } from './dto';

export interface RequestContext {
  ip?: string;
  userAgent?: string;
  correlationId?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly bus: EventBus,
  ) {}

  // -------------------------------------------------------------------------
  // Registration + email verification
  // -------------------------------------------------------------------------

  async register(dto: RegisterDto, ctx: RequestContext) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });

    // Do NOT reveal whether the email already exists (account enumeration).
    // We return the same response either way and simply re-send verification.
    if (existing) {
      if (existing.status === UserStatus.PENDING_VERIFICATION) {
        await this.issueEmailVerification(existing);
      }
      return { message: 'Check your inbox to confirm your email address.' };
    }

    const rounds = Number(this.config.get('BCRYPT_ROUNDS') ?? 12);
    const passwordHash = await bcrypt.hash(dto.password, rounds);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        fullName: dto.fullName,
        phone: dto.phone,
        roles: [PrismaRole.STUDENT],
        status: UserStatus.PENDING_VERIFICATION,
        createdByIp: ctx.ip,
        passwordChangedAt: new Date(),
      },
    });

    await this.audit(user.id, 'user.registered', ctx, { email: user.email });
    await this.issueEmailVerification(user);

    await this.bus.publish<UserRegisteredEvent>(
      EVENTS.USER_REGISTERED,
      { userId: user.id, email: user.email, fullName: user.fullName },
      ctx.correlationId,
    );

    return { message: 'Check your inbox to confirm your email address.' };
  }

  private async issueEmailVerification(user: User): Promise<void> {
    const raw = this.tokens.randomToken();
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        purpose: TokenPurpose.EMAIL_VERIFICATION,
        tokenHash: this.tokens.hash(raw),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
      },
    });
    const base = this.config.get<string>('APP_PUBLIC_URL') ?? 'http://localhost:3000';
    await this.mail.sendVerificationEmail(user.email, user.fullName, `${base}/verify-email?token=${raw}`);
  }

  async verifyEmail(rawToken: string, ctx: RequestContext) {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: this.tokens.hash(rawToken) },
      include: { user: true },
    });

    if (!record || record.purpose !== TokenPurpose.EMAIL_VERIFICATION) {
      throw new BadRequestException('This verification link is not valid.');
    }
    if (record.consumedAt) {
      // Idempotent: verifying twice is a success, not an error.
      return { message: 'Email already verified. You can sign in.' };
    }
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('This verification link has expired. Request a new one.');
    }

    await this.prisma.$transaction([
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: { status: UserStatus.ACTIVE, emailVerifiedAt: new Date() },
      }),
    ]);

    await this.audit(record.userId, 'user.email_verified', ctx);
    await this.bus.publish(EVENTS.USER_VERIFIED, { userId: record.userId }, ctx.correlationId);
    return { message: 'Email verified. You can sign in now.' };
  }

  async resendVerification(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user && user.status === UserStatus.PENDING_VERIFICATION) {
      await this.issueEmailVerification(user);
    }
    return { message: 'If that account needs verification, a new link is on its way.' };
  }

  // -------------------------------------------------------------------------
  // Login / refresh / logout
  // -------------------------------------------------------------------------

  async login(dto: LoginDto, ctx: RequestContext): Promise<TokenPair & { user: PublicUser }> {
    const maxAttempts = Number(this.config.get('LOGIN_MAX_ATTEMPTS') ?? 5);
    const lockMinutes = Number(this.config.get('LOGIN_LOCK_MINUTES') ?? 15);

    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    // Constant-ish work whether or not the user exists, to avoid timing oracles.
    const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const passwordOk = await bcrypt.compare(dto.password, hash);

    if (!user || user.deletedAt) {
      await this.recordLoginAttempt(null, dto.email, false, ctx, 'no_such_user');
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.recordLoginAttempt(user.id, dto.email, false, ctx, 'locked');
      throw new ForbiddenException(
        `Too many failed attempts. Try again after ${user.lockedUntil.toISOString()}.`,
      );
    }
    if (!passwordOk) {
      const failed = user.failedLoginCount + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: failed,
          lockedUntil: failed >= maxAttempts ? new Date(Date.now() + lockMinutes * 60_000) : null,
        },
      });
      await this.recordLoginAttempt(user.id, dto.email, false, ctx, 'bad_password');
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    if (user.status === UserStatus.PENDING_VERIFICATION) {
      await this.recordLoginAttempt(user.id, dto.email, false, ctx, 'unverified');
      throw new ForbiddenException('Verify your email address before signing in.');
    }
    if (user.status !== UserStatus.ACTIVE) {
      await this.recordLoginAttempt(user.id, dto.email, false, ctx, 'not_active');
      throw new ForbiddenException('This account is not active. Contact support.');
    }

    const pair = await this.startSession(user, ctx);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.recordLoginAttempt(user.id, dto.email, true, ctx);
    await this.audit(user.id, 'user.login', ctx);

    return { ...pair, user: toPublicUser(user) };
  }

  private async startSession(user: User, ctx: RequestContext): Promise<TokenPair> {
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 400),
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000),
      },
    });

    const refresh = await this.tokens.signRefreshToken({ userId: user.id, sessionId: session.id });
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        sessionId: session.id,
        tokenHash: this.tokens.hash(refresh.token),
        expiresAt: refresh.expiresAt,
      },
    });

    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      email: user.email,
      roles: user.roles as unknown as Role[],
      sessionId: session.id,
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      accessTokenExpiresIn: this.tokens.accessTtlSeconds,
    };
  }

  /**
   * Refresh-token rotation with re-use detection.
   * Every refresh returns a brand new refresh token and marks the old one used.
   * Presenting a token that is already used means it leaked -> kill the session.
   */
  async refresh(rawToken: string | undefined, ctx: RequestContext): Promise<TokenPair> {
    if (!rawToken) throw new UnauthorizedException('Missing refresh token.');

    let payload;
    try {
      payload = await this.tokens.verifyRefreshToken(rawToken);
    } catch {
      throw new UnauthorizedException('Session expired. Sign in again.');
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hash(rawToken) },
      include: { user: true, session: true },
    });

    if (!stored) throw new UnauthorizedException('Session expired. Sign in again.');

    if (stored.usedAt || stored.revokedAt) {
      // Token re-use => assume theft. Revoke the entire family.
      await this.revokeSession(stored.sessionId, 'refresh_token_reuse');
      await this.audit(stored.userId, 'auth.refresh_reuse_detected', ctx, {
        sessionId: stored.sessionId,
      });
      throw new UnauthorizedException('Session revoked for security reasons. Sign in again.');
    }
    if (stored.expiresAt < new Date() || stored.session.revokedAt) {
      throw new UnauthorizedException('Session expired. Sign in again.');
    }

    const user = stored.user;
    if (user.status !== UserStatus.ACTIVE || user.deletedAt) {
      throw new ForbiddenException('This account is not active.');
    }
    // A password change invalidates tokens issued before it.
    if (user.passwordChangedAt && payload.iat && payload.iat * 1000 < user.passwordChangedAt.getTime()) {
      await this.revokeSession(stored.sessionId, 'password_changed');
      throw new UnauthorizedException('Password changed. Sign in again.');
    }

    const next = await this.tokens.signRefreshToken({
      userId: user.id,
      sessionId: stored.sessionId,
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const newToken = await tx.refreshToken.create({
        data: {
          userId: user.id,
          sessionId: stored.sessionId,
          tokenHash: this.tokens.hash(next.token),
          expiresAt: next.expiresAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date(), replacedById: newToken.id },
      });
      await tx.session.update({
        where: { id: stored.sessionId },
        data: { lastUsedAt: new Date() },
      });
      return newToken;
    });

    this.logger.debug(`rotated refresh token ${stored.id} -> ${created.id}`);

    const accessToken = await this.tokens.signAccessToken({
      userId: user.id,
      email: user.email,
      roles: user.roles as unknown as Role[],
      sessionId: stored.sessionId,
    });

    return {
      accessToken,
      refreshToken: next.token,
      accessTokenExpiresIn: this.tokens.accessTtlSeconds,
    };
  }

  async logout(rawToken: string | undefined, ctx: RequestContext) {
    if (rawToken) {
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: this.tokens.hash(rawToken) },
      });
      if (stored) {
        await this.revokeSession(stored.sessionId, 'logout');
        await this.audit(stored.userId, 'user.logout', ctx);
      }
    }
    return { message: 'Signed out.' };
  }

  async logoutAll(userId: string, ctx: RequestContext) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    await Promise.all(sessions.map((s) => this.revokeSession(s.id, 'logout_all')));
    await this.audit(userId, 'user.logout_all', ctx, { count: sessions.length });
    return { message: `Signed out of ${sessions.length} session(s).` };
  }

  private async revokeSession(sessionId: string, reason: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.session.update({
        where: { id: sessionId },
        data: { revokedAt: now, revokedReason: reason },
      }),
      this.prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------------

  async forgotPassword(email: string, ctx: RequestContext) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && !user.deletedAt) {
      const raw = this.tokens.randomToken();
      await this.prisma.verificationToken.create({
        data: {
          userId: user.id,
          purpose: TokenPurpose.PASSWORD_RESET,
          tokenHash: this.tokens.hash(raw),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
        },
      });
      const base = this.config.get<string>('APP_PUBLIC_URL') ?? 'http://localhost:3000';
      await this.mail.sendPasswordResetEmail(
        user.email,
        user.fullName,
        `${base}/reset-password?token=${raw}`,
      );
      await this.audit(user.id, 'user.password_reset_requested', ctx);
    }
    // Always the same answer: no account enumeration.
    return { message: 'If that email is registered, a reset link is on its way.' };
  }

  async resetPassword(rawToken: string, newPassword: string, ctx: RequestContext) {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: this.tokens.hash(rawToken) },
    });
    if (
      !record ||
      record.purpose !== TokenPurpose.PASSWORD_RESET ||
      record.consumedAt ||
      record.expiresAt < new Date()
    ) {
      throw new BadRequestException('This reset link is not valid or has expired.');
    }

    const rounds = Number(this.config.get('BCRYPT_ROUNDS') ?? 12);
    const passwordHash = await bcrypt.hash(newPassword, rounds);

    await this.prisma.$transaction([
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
          // Verifying identity via email also proves the address.
          status: UserStatus.ACTIVE,
          emailVerifiedAt: new Date(),
        },
      }),
      this.prisma.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'password_reset' },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.audit(record.userId, 'user.password_reset', ctx);
    return { message: 'Password updated. Sign in with your new password.' };
  }

  async changePassword(userId: string, dto: ChangePasswordDto, ctx: RequestContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const ok = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Current password is incorrect.');

    const rounds = Number(this.config.get('BCRYPT_ROUNDS') ?? 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(dto.newPassword, rounds),
        passwordChangedAt: new Date(),
      },
    });
    await this.audit(userId, 'user.password_changed', ctx);
    return { message: 'Password updated.' };
  }

  // -------------------------------------------------------------------------
  // Profile + sessions
  // -------------------------------------------------------------------------

  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return toPublicUser(user);
  }

  async listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, ip: true, userAgent: true, lastUsedAt: true, createdAt: true },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async recordLoginAttempt(
    userId: string | null,
    email: string,
    success: boolean,
    ctx: RequestContext,
    reason?: string,
  ) {
    await this.prisma.loginAttempt.create({
      data: { userId, email, success, reason, ip: ctx.ip, userAgent: ctx.userAgent?.slice(0, 400) },
    });
  }

  private async audit(
    userId: string | null,
    action: string,
    ctx: RequestContext,
    metadata?: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        userId,
        action,
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 400),
        correlationId: ctx.correlationId,
        metadata: metadata as any,
      },
    });
  }
}

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  status: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    roles: user.roles,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
  };
}
