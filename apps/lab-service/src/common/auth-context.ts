import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenPayload, HEADER_INTERNAL_KEY, Role } from '@lp/shared';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthenticatedUser {
  userId: string;
  email: string;
  roles: Role[];
  sessionId: string;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest().user as AuthenticatedUser | undefined;
    return data ? user?.[data] : user;
  },
);

/**
 * Every service verifies the access token itself with the shared secret.
 * We deliberately do NOT trust x-user-* headers from the gateway: if someone
 * reaches a pod directly (misconfigured NetworkPolicy, port-forward, a
 * compromised sidecar) they still cannot forge an identity.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest();
    const token = extractToken(req);

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Sign in to continue.');
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        issuer: this.config.get<string>('JWT_ISSUER'),
        audience: this.config.get<string>('JWT_AUDIENCE'),
      });
      if (payload.typ !== 'access') throw new Error('wrong token type');
      req.user = {
        userId: payload.sub,
        email: payload.email,
        roles: payload.roles,
        sessionId: payload.sid,
      } satisfies AuthenticatedUser;
      return true;
    } catch {
      if (isPublic) return true; // anonymous view of a public route
      throw new UnauthorizedException('Your session expired. Sign in again.');
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest().user as AuthenticatedUser | undefined;
    if (!user || !required.some((r) => user.roles?.includes(r))) {
      throw new ForbiddenException('You do not have access to this resource.');
    }
    return true;
  }
}

/** Shared-secret guard for service-to-service endpoints under /internal. */
@Injectable()
export class InternalApiGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.headers[HEADER_INTERNAL_KEY] !== this.config.getOrThrow<string>('INTERNAL_API_KEY')) {
      throw new UnauthorizedException('Internal call rejected.');
    }
    return true;
  }
}

function extractToken(req: any): string | undefined {
  const cookie = req.cookies?.['lp_access'];
  if (cookie) return cookie;
  const header: string | undefined = req.headers?.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return undefined;
}
