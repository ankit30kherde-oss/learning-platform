import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { HEADER_CORRELATION_ID } from '@lp/shared';
import { AuthService, RequestContext, TokenPair } from './auth.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './jwt.strategy';

@ApiTags('auth')
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  // ---- public endpoints ----------------------------------------------------

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a student account and send a verification email' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, ctxOf(req));
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an email address using the emailed token' })
  verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    return this.auth.verifyEmail(dto.token, ctxOf(req));
  }

  @Public()
  @Post('resend-verification')
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  @HttpCode(HttpStatus.OK)
  resendVerification(@Body() dto: ForgotPasswordDto) {
    return this.auth.resendVerification(dto.email);
  }

  @Public()
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in; sets HttpOnly access and refresh cookies' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto, ctxOf(req));
    this.setAuthCookies(res, result);
    return { user: result.user, accessTokenExpiresIn: result.accessTokenExpiresIn };
  }

  @Public()
  @Post('refresh')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[REFRESH_COOKIE] ?? (req.body as any)?.refreshToken;
    const pair = await this.auth.refresh(raw, ctxOf(req));
    this.setAuthCookies(res, pair);
    return { accessTokenExpiresIn: pair.accessTokenExpiresIn };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[REFRESH_COOKIE];
    const out = await this.auth.logout(raw, ctxOf(req));
    this.clearAuthCookies(res);
    return out;
  }

  @Public()
  @Post('forgot-password')
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.auth.forgotPassword(dto.email, ctxOf(req));
  }

  @Public()
  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.auth.resetPassword(dto.token, dto.newPassword, ctxOf(req));
  }

  // ---- authenticated endpoints --------------------------------------------

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current user profile' })
  me(@CurrentUser('userId') userId: string) {
    return this.auth.me(userId);
  }

  @Get('sessions')
  @ApiBearerAuth()
  sessions(@CurrentUser('userId') userId: string) {
    return this.auth.listSessions(userId);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  changePassword(
    @CurrentUser('userId') userId: string,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.auth.changePassword(userId, dto, ctxOf(req));
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  async logoutAll(
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.auth.logoutAll(userId, ctxOf(req));
    this.clearAuthCookies(res);
    return out;
  }

  // ---- cookie helpers ------------------------------------------------------

  /**
   * Tokens live in HttpOnly cookies so page JavaScript (and therefore any XSS
   * payload) cannot read them. SameSite=Lax blocks cross-site form CSRF for
   * the state-changing POSTs; the refresh cookie is additionally path-scoped
   * so it is only ever sent to the refresh/logout endpoints.
   */
  private setAuthCookies(res: Response, pair: TokenPair): void {
    const secure = this.config.get('COOKIE_SECURE') === 'true';
    const sameSite = (this.config.get<string>('COOKIE_SAMESITE') ?? 'lax') as 'lax' | 'strict' | 'none';
    const domain = this.config.get<string>('COOKIE_DOMAIN') || undefined;

    res.cookie(ACCESS_COOKIE, pair.accessToken, {
      httpOnly: true,
      secure,
      sameSite,
      domain,
      path: '/',
      maxAge: pair.accessTokenExpiresIn * 1000,
    });
    res.cookie(REFRESH_COOKIE, pair.refreshToken, {
      httpOnly: true,
      secure,
      sameSite,
      domain,
      path: '/',
      maxAge: Number(this.config.get('JWT_REFRESH_TTL') ?? 2592000) * 1000,
    });
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }
}

function ctxOf(req: Request): RequestContext {
  return {
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip,
    userAgent: req.headers['user-agent'],
    correlationId: req.headers[HEADER_CORRELATION_ID] as string | undefined,
  };
}
