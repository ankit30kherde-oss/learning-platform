import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { createHash, randomBytes } from 'node:crypto';
import { LabDriver, LabSessionStatus, type LabSession, type LabTemplate } from '@prisma/client';
import { HEADER_INTERNAL_KEY } from '@lp/shared';
import { PrismaService } from '../prisma/prisma.module';
import { LAB_DRIVER, type LabDriverPort, type ProvisionResult } from './drivers/driver.port';

export interface StartLabInput {
  userId: string;
  courseId: string;
  lessonId: string;
  templateId: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class LabsService implements OnModuleInit {
  private readonly logger = new Logger(LabsService.name);
  private readonly maxConcurrentPerUser: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(LAB_DRIVER) private readonly driver: LabDriverPort,
  ) {
    this.maxConcurrentPerUser = Number(this.config.get('LAB_MAX_SESSIONS_PER_USER') ?? 1);
  }

  async onModuleInit() {
    // A restart leaves live containers with no owner. Clean them on boot rather
    // than paying for them until someone notices.
    await this.reapOrphans().catch((e) => this.logger.warn(`orphan sweep failed: ${e.message}`));
  }

  // --------------------------------------------------------------- lifecycle

  async start(input: StartLabInput) {
    await this.assertEntitled(input.userId, input.courseId);

    const template = await this.prisma.labTemplate.findFirst({
      where: {
        // Accept a uuid or a slug; see the DTO for why.
        ...(isUuid(input.templateId) ? { id: input.templateId } : { slug: input.templateId }),
        isActive: true,
        deletedAt: null,
      },
    });
    if (!template) throw new NotFoundException('That lab is not available.');

    const live = await this.prisma.labSession.count({
      where: {
        userId: input.userId,
        status: { in: [LabSessionStatus.PROVISIONING, LabSessionStatus.RUNNING] },
      },
    });
    if (live >= this.maxConcurrentPerUser) {
      // Without this, one account can mint namespaces until the cluster fills.
      throw new HttpException(
        'You already have a lab running. End it before starting another.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // The ticket is the only credential the browser gets, it is single use, and
    // only its hash is stored.
    const ticket = randomBytes(32).toString('base64url');
    const ticketHash = sha256(ticket);

    const session = await this.prisma.labSession.create({
      data: {
        userId: input.userId,
        courseId: input.courseId,
        lessonId: input.lessonId,
        templateId: template.id,
        driver: this.driver.name === 'KUBERNETES' ? LabDriver.KUBERNETES : LabDriver.LOCAL_DOCKER,
        status: LabSessionStatus.PROVISIONING,
        ticketHash,
        expiresAt: new Date(Date.now() + template.ttlSeconds * 1000),
        ipAddress: input.ip?.slice(0, 64),
        userAgent: input.userAgent?.slice(0, 400),
      },
    });

    try {
      const handle = await this.driver.provision(session.id, template);
      await this.prisma.labSession.update({
        where: { id: session.id },
        data: {
          status: LabSessionStatus.RUNNING,
          namespace: handle.namespace,
          podName: handle.podName,
          containerId: handle.containerId,
          startedAt: new Date(),
          lastActivityAt: new Date(),
        },
      });
      await this.event(session.id, 'provisioned', `${handle.namespace ?? handle.containerId}`);
    } catch (err) {
      await this.prisma.labSession.update({
        where: { id: session.id },
        data: {
          status: LabSessionStatus.FAILED,
          endedAt: new Date(),
          endReason: (err as Error).message.slice(0, 200),
        },
      });
      await this.event(session.id, 'provision_failed', (err as Error).message);
      throw err;
    }

    return {
      sessionId: session.id,
      ticket,
      wsPath: '/labs/ws',
      expiresAt: session.expiresAt.toISOString(),
      driver: this.driver.name === 'KUBERNETES' ? 'kubernetes' : 'local',
    };
  }

  /**
   * Exchange the one-time ticket for a session. Called by the WebSocket layer
   * during the upgrade, before a single byte of terminal traffic flows.
   */
  async redeemTicket(ticket: string): Promise<{ session: LabSession; template: LabTemplate }> {
    const session = await this.prisma.labSession.findUnique({
      where: { ticketHash: sha256(ticket) },
      include: { template: true },
    });

    if (!session) throw new ForbiddenException('Invalid lab ticket.');
    if (session.ticketUsedAt) throw new ForbiddenException('That lab ticket was already used.');
    if (session.status !== LabSessionStatus.RUNNING) throw new ForbiddenException('Lab is not running.');
    if (session.expiresAt < new Date()) throw new ForbiddenException('That lab session expired.');

    await this.prisma.labSession.update({
      where: { id: session.id },
      data: { ticketUsedAt: new Date(), lastActivityAt: new Date() },
    });
    await this.event(session.id, 'attached');

    const { template, ...rest } = session;
    return { session: rest as LabSession, template };
  }

  async touch(sessionId: string, bytesIn: number, bytesOut: number) {
    await this.prisma.labSession
      .update({
        where: { id: sessionId },
        data: {
          lastActivityAt: new Date(),
          bytesIn: { increment: BigInt(bytesIn) },
          bytesOut: { increment: BigInt(bytesOut) },
        },
      })
      .catch(() => undefined);
  }

  async stop(sessionId: string, userId: string | null, reason: string) {
    const session = await this.prisma.labSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found.');
    if (userId && session.userId !== userId) throw new ForbiddenException('Not your session.');
    if (session.status === LabSessionStatus.ENDED) return { stopped: true };

    await this.prisma.labSession.update({
      where: { id: sessionId },
      data: { status: LabSessionStatus.STOPPING },
    });

    await this.driver.destroy(this.handleOf(session));

    await this.prisma.labSession.update({
      where: { id: sessionId },
      data: {
        status: reason === 'expired' ? LabSessionStatus.EXPIRED : LabSessionStatus.ENDED,
        endedAt: new Date(),
        endReason: reason,
      },
    });
    await this.event(sessionId, 'destroyed', reason);

    return { stopped: true };
  }

  async listMine(userId: string) {
    return this.prisma.labSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        createdAt: true,
        endedAt: true,
        expiresAt: true,
        lessonId: true,
        courseId: true,
      },
    });
  }

  async listTemplates() {
    return this.prisma.labTemplate.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { title: 'asc' },
    });
  }

  // ------------------------------------------------------------------ reaper

  /**
   * Two clocks kill a session: the hard TTL and the idle timeout. Both matter -
   * the TTL bounds cost, the idle timeout returns capacity from the student who
   * closed the tab and walked away.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reapExpired() {
    const now = new Date();
    const candidates = await this.prisma.labSession.findMany({
      where: {
        status: { in: [LabSessionStatus.RUNNING, LabSessionStatus.PROVISIONING] },
      },
      include: { template: true },
      take: 100,
    });

    for (const s of candidates) {
      const idleFor = s.lastActivityAt ? (now.getTime() - s.lastActivityAt.getTime()) / 1000 : 0;
      const expired = s.expiresAt < now;
      const idle = idleFor > s.template.idleTimeoutSeconds;
      if (!expired && !idle) continue;

      this.logger.log(`reaping ${s.id} (${expired ? 'ttl' : 'idle'})`);
      await this.stop(s.id, null, expired ? 'expired' : 'idle_timeout').catch((e) =>
        this.logger.warn(`reap of ${s.id} failed: ${e.message}`),
      );
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reapOrphans() {
    if (!this.driver.listOrphans) return;
    const active = await this.prisma.labSession.findMany({
      where: { status: { in: [LabSessionStatus.RUNNING, LabSessionStatus.PROVISIONING] } },
      select: { id: true, containerId: true },
    });
    const activeIds = active.flatMap((a) => [a.id, a.containerId].filter(Boolean) as string[]);

    const orphans = await this.driver.listOrphans(activeIds);
    for (const orphan of orphans) {
      this.logger.warn(`destroying orphaned lab resource ${orphan}`);
      await this.driver
        .destroy({
          driver: this.driver.name,
          namespace: orphan.startsWith('lab-') ? orphan : null,
          podName: 'shell',
          containerId: orphan.startsWith('lp-lab-') ? orphan : null,
        })
        .catch(() => undefined);
    }
  }

  // ----------------------------------------------------------------- helpers

  private handleOf(session: LabSession): ProvisionResult {
    return {
      driver: session.driver === LabDriver.KUBERNETES ? 'KUBERNETES' : 'LOCAL_DOCKER',
      namespace: session.namespace,
      podName: session.podName,
      containerId: session.containerId,
    };
  }

  private async event(sessionId: string, kind: string, detail?: string) {
    await this.prisma.labEvent
      .create({ data: { sessionId, kind, detail: detail?.slice(0, 500) } })
      .catch(() => undefined);
  }

  private async assertEntitled(userId: string, courseId: string) {
    const url = `${this.config.getOrThrow('ENROLLMENT_SERVICE_URL')}/internal/enrollments/check`;
    const { data } = await axios.get(url, {
      params: { userId, courseId },
      headers: { [HEADER_INTERNAL_KEY]: this.config.getOrThrow<string>('INTERNAL_API_KEY') },
      timeout: 4000,
    });
    if (!data?.entitled) throw new ForbiddenException('You are not enrolled in this course.');
  }
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}
