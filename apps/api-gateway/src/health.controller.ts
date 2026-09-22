import { Controller, Get } from '@nestjs/common';
import axios from 'axios';

@Controller()
export class HealthController {
  @Get('healthz')
  health() {
    return { status: 'ok', service: 'api-gateway', uptime: process.uptime() };
  }

  /** Aggregated readiness: useful during local bring-up and for smoke tests. */
  @Get('readyz')
  async ready() {
    const targets = {
      auth: process.env.AUTH_SERVICE_URL ?? 'http://localhost:4001',
      course: process.env.COURSE_SERVICE_URL ?? 'http://localhost:4002',
      enrollment: process.env.ENROLLMENT_SERVICE_URL ?? 'http://localhost:4003',
      payment: process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:4004',
    };

    const results = await Promise.all(
      Object.entries(targets).map(async ([name, url]) => {
        try {
          const { data } = await axios.get(`${url}/readyz`, { timeout: 2000 });
          return [name, data.status ?? 'ready'] as const;
        } catch {
          return [name, 'unavailable'] as const;
        }
      }),
    );

    const services = Object.fromEntries(results);
    const allReady = Object.values(services).every((s) => s === 'ready');
    return { status: allReady ? 'ready' : 'degraded', services };
  }
}
