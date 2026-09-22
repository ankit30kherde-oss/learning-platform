import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@lp/shared';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** RBAC: a handler may require one or more roles; the user needs at least one. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    const roles: Role[] = user?.roles ?? [];
    if (!required.some((r) => roles.includes(r))) {
      throw new ForbiddenException('You do not have access to this resource.');
    }
    return true;
  }
}
