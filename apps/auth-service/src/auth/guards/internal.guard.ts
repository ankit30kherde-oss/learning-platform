import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HEADER_INTERNAL_KEY } from '@lp/shared';

/**
 * Service-to-service calls (e.g. enrollment-service asking course-service for a
 * price) carry a shared secret header. In EKS this is additionally constrained
 * by NetworkPolicies so only named pods can even reach the port. In a later
 * phase this becomes mTLS via the service mesh.
 */
@Injectable()
export class InternalApiGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const provided = req.headers[HEADER_INTERNAL_KEY];
    const expected = this.config.getOrThrow<string>('INTERNAL_API_KEY');
    if (!provided || provided !== expected) {
      throw new UnauthorizedException('Internal call rejected.');
    }
    return true;
  }
}
