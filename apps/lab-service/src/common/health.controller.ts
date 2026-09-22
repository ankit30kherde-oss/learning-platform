import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.module';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('healthz')
  health() {
    return { status: 'ok', service: 'lab-service', uptime: process.uptime() };
  }

  @Get('readyz')
  async ready() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ready', service: 'lab-service' };
  }
}
