import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  EnrollmentSource,
  EnrollmentStatus,
  PrismaClient,
  Prisma,
} from '@prisma/client';
import {
  EVENTS,
  EventBus,
  EventEnvelope,
  EnrollmentCreatedEvent,
  HEADER_INTERNAL_KEY,
  PaymentCompletedEvent,
} from '@lp/shared';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly bus: EventBus,
  ) {}

  // ---- queries -------------------------------------------------------------

  async listMine(userId: string) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { userId, status: { in: [EnrollmentStatus.ACTIVE, EnrollmentStatus.COMPLETED] } },
      orderBy: { lastAccessedAt: { sort: 'desc', nulls: 'last' } },
    });

    // Join the catalog at read time. course-service stays the owner of titles.
    const courses = await Promise.all(
      enrollments.map((e) => this.fetchCourseCard(e.courseId).catch(() => null)),
    );

    return enrollments.map((e, i) => ({
      id: e.id,
      courseId: e.courseId,
      status: e.status,
      progressPercent: e.progressPercent,
      completedAt: e.completedAt,
      lastAccessedAt: e.lastAccessedAt,
      createdAt: e.createdAt,
      course: courses[i],
    }));
  }

  /** The entitlement check every protected read goes through. */
  async isEntitled(userId: string, courseId: string): Promise<boolean> {
    const e = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
    });
    if (!e) return false;
    if (e.status === EnrollmentStatus.REVOKED) return false;
    if (e.expiresAt && e.expiresAt < new Date()) return false;
    return true;
  }

  /** Cached percent from the enrollment row; progress-service keeps it fresh. */
  async progressPercent(userId: string, courseId: string): Promise<number> {
    const e = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { progressPercent: true },
    });
    return e?.progressPercent ?? 0;
  }

  async getMine(userId: string, courseId: string) {
    const e = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
    });
    if (!e) throw new NotFoundException('You are not enrolled in this course.');
    return e;
  }

  async touch(userId: string, courseId: string) {
    await this.prisma.enrollment.updateMany({
      where: { userId, courseId },
      data: { lastAccessedAt: new Date() },
    });
  }

  // ---- writes --------------------------------------------------------------

  /** Free courses enroll directly, with no payment involved. */
  async enrollFree(userId: string, courseId: string, correlationId?: string) {
    const course = await this.fetchPricing(courseId);
    if (!course.isFree && course.priceMinor > 0) {
      throw new BadRequestException('This course requires payment.');
    }
    return this.createEnrollment({
      userId,
      courseId,
      source: EnrollmentSource.FREE,
      correlationId,
    });
  }

  /** Admin grant (support, bundles, corporate seats). */
  async grant(userId: string, courseId: string, correlationId?: string) {
    return this.createEnrollment({
      userId,
      courseId,
      source: EnrollmentSource.ADMIN,
      correlationId,
    });
  }

  async revoke(userId: string, courseId: string, reason: string) {
    const updated = await this.prisma.enrollment.updateMany({
      where: { userId, courseId },
      data: { status: EnrollmentStatus.REVOKED, revokedAt: new Date(), revokedReason: reason },
    });
    if (updated.count === 0) throw new NotFoundException('Enrollment not found.');
    return { message: 'Access revoked.' };
  }

  /**
   * Idempotent creation. Two concurrent payment.completed deliveries for the
   * same course produce exactly one enrollment thanks to the unique
   * (userId, courseId) index plus the upsert.
   */
  private async createEnrollment(args: {
    userId: string;
    courseId: string;
    source: EnrollmentSource;
    paymentId?: string;
    correlationId?: string;
    tx?: Prisma.TransactionClient;
  }) {
    const db = args.tx ?? this.prisma;
    const enrollment = await db.enrollment.upsert({
      where: { userId_courseId: { userId: args.userId, courseId: args.courseId } },
      update: {
        status: EnrollmentStatus.ACTIVE,
        revokedAt: null,
        revokedReason: null,
        paymentId: args.paymentId ?? undefined,
      },
      create: {
        userId: args.userId,
        courseId: args.courseId,
        source: args.source,
        paymentId: args.paymentId,
        status: EnrollmentStatus.ACTIVE,
      },
    });

    await this.bus.publish<EnrollmentCreatedEvent>(
      EVENTS.ENROLLMENT_CREATED,
      {
        enrollmentId: enrollment.id,
        userId: enrollment.userId,
        courseId: enrollment.courseId,
        source: args.source,
      },
      args.correlationId,
    );

    // Best-effort counter bump in the catalog. Failure here is cosmetic.
    void this.bumpCourseCounter(args.courseId).catch(() => undefined);

    return enrollment;
  }

  // ---- event consumer ------------------------------------------------------

  /**
   * payment.completed -> unlock the course.
   * The handler is idempotent via processed_events; SQS/Redis can redeliver
   * the same message any number of times.
   */
  async handlePaymentCompleted(evt: EventEnvelope<PaymentCompletedEvent>): Promise<void> {
    const already = await this.prisma.processedEvent.findUnique({ where: { eventId: evt.id } });
    if (already) {
      this.logger.debug(`event ${evt.id} already processed, skipping`);
      return;
    }

    const { userId, courseId, paymentId } = evt.data;

    await this.prisma.$transaction(async (tx) => {
      await tx.processedEvent.create({ data: { eventId: evt.id, eventName: evt.name } });
      await tx.enrollment.upsert({
        where: { userId_courseId: { userId, courseId } },
        update: { status: EnrollmentStatus.ACTIVE, paymentId, revokedAt: null, revokedReason: null },
        create: {
          userId,
          courseId,
          paymentId,
          source: EnrollmentSource.PAYMENT,
          status: EnrollmentStatus.ACTIVE,
        },
      });
    });

    this.logger.log(`enrolled user ${userId} in course ${courseId} from payment ${paymentId}`);
    void this.bumpCourseCounter(courseId).catch(() => undefined);
  }

  /** payment.refunded -> pull access back. */
  async handlePaymentRefunded(evt: EventEnvelope<{ userId: string; courseId: string }>) {
    const already = await this.prisma.processedEvent.findUnique({ where: { eventId: evt.id } });
    if (already) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.processedEvent.create({ data: { eventId: evt.id, eventName: evt.name } });
      await tx.enrollment.updateMany({
        where: { userId: evt.data.userId, courseId: evt.data.courseId },
        data: {
          status: EnrollmentStatus.REVOKED,
          revokedAt: new Date(),
          revokedReason: 'refund',
        },
      });
    });
  }

  // ---- outbound calls ------------------------------------------------------

  private get courseBase(): string {
    return this.config.get<string>('COURSE_SERVICE_URL') ?? 'http://localhost:4002';
  }

  private get internalHeaders() {
    return { [HEADER_INTERNAL_KEY]: this.config.getOrThrow<string>('INTERNAL_API_KEY') };
  }

  private async fetchPricing(courseId: string) {
    const { data } = await axios.get(`${this.courseBase}/internal/courses/${courseId}/pricing`, {
      headers: this.internalHeaders,
      timeout: 4000,
    });
    return data as { id: string; priceMinor: number; isFree: boolean; currency: string };
  }

  private async fetchCourseCard(courseId: string) {
    const { data } = await axios.get(`${this.courseBase}/internal/courses/${courseId}/pricing`, {
      headers: this.internalHeaders,
      timeout: 4000,
    });
    return data as { id: string; slug: string; title: string };
  }

  private async bumpCourseCounter(courseId: string) {
    await axios.post(
      `${this.courseBase}/internal/courses/${courseId}/enrollment-count`,
      {},
      { headers: this.internalHeaders, timeout: 4000 },
    );
  }
}
