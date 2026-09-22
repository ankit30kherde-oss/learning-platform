import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: is the process up? Used by the Kubernetes livenessProbe. */
  @Get('healthz')
  health() {
    return { status: 'ok', service: 'auth-service', uptime: process.uptime() };
  }

  /** Readiness: can we serve traffic (DB reachable)? Kubernetes readinessProbe. */
  @Get('readyz')
  async ready() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ready', service: 'auth-service' };
  }
}
