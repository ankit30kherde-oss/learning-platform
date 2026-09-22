import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { EnrollmentStatus, LessonProgressStatus } from '@prisma/client';
import { EVENTS, EventBus, HEADER_INTERNAL_KEY, LessonCompletedEvent } from '@lp/shared';
import { PrismaService } from '../prisma/prisma.module';
import { EnrollmentsService } from '../enrollments/enrollments.service';

@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly enrollments: EnrollmentsService,
    private readonly bus: EventBus,
  ) {}

  /** Player heartbeat. Cheap upsert, called every ~15s while watching. */
  async savePosition(userId: string, courseId: string, lessonId: string, position: number) {
    await this.assertEntitled(userId, courseId);
    await this.prisma.lessonProgress.upsert({
      where: { userId_lessonId: { userId, lessonId } },
      update: {
        lastPositionSeconds: Math.max(0, Math.floor(position)),
        watchedSeconds: { increment: 0 },
      },
      create: {
        userId,
        courseId,
        lessonId,
        lastPositionSeconds: Math.max(0, Math.floor(position)),
        status: LessonProgressStatus.STARTED,
      },
    });
    await this.enrollments.touch(userId, courseId);
    return { saved: true };
  }

  async completeLesson(userId: string, courseId: string, lessonId: string, correlationId?: string) {
    await this.assertEntitled(userId, courseId);

    const existing = await this.prisma.lessonProgress.findUnique({
      where: { userId_lessonId: { userId, lessonId } },
    });

    // Completing twice must not double-count.
    if (existing?.status !== LessonProgressStatus.COMPLETED) {
      await this.prisma.lessonProgress.upsert({
        where: { userId_lessonId: { userId, lessonId } },
        update: { status: LessonProgressStatus.COMPLETED, completedAt: new Date() },
        create: {
          userId,
          courseId,
          lessonId,
          status: LessonProgressStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
      await this.bus.publish<LessonCompletedEvent>(
        EVENTS.LESSON_COMPLETED,
        { userId, courseId, lessonId, completedAt: new Date().toISOString() },
        correlationId,
      );
    }

    return this.recalculate(userId, courseId, correlationId);
  }

  async getCourseProgress(userId: string, courseId: string) {
    const [records, curriculum] = await Promise.all([
      this.prisma.lessonProgress.findMany({ where: { userId, courseId } }),
      this.fetchCurriculum(courseId),
    ]);

    const completed = new Set(
      records.filter((r) => r.status === LessonProgressStatus.COMPLETED).map((r) => r.lessonId),
    );
    const positions = Object.fromEntries(records.map((r) => [r.lessonId, r.lastPositionSeconds]));

    return {
      courseId,
      totalLessons: curriculum.lessonCount,
      completedLessons: completed.size,
      percent: curriculum.lessonCount
        ? Math.round((completed.size / curriculum.lessonCount) * 100)
        : 0,
      completedLessonIds: [...completed],
      positions,
      nextLesson: curriculum.lessons.find((l: any) => !completed.has(l.id)) ?? null,
    };
  }

  /** Recompute the cached percent on the enrollment and emit course.completed. */
  private async recalculate(userId: string, courseId: string, correlationId?: string) {
    const summary = await this.getCourseProgress(userId, courseId);

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
    });
    const finished = summary.percent >= 100 && summary.totalLessons > 0;

    if (enrollment) {
      await this.prisma.enrollment.update({
        where: { id: enrollment.id },
        data: {
          progressPercent: summary.percent,
          lastAccessedAt: new Date(),
          ...(finished && !enrollment.completedAt
            ? { completedAt: new Date(), status: EnrollmentStatus.COMPLETED }
            : {}),
        },
      });

      if (finished && !enrollment.completedAt) {
        await this.bus.publish(
          EVENTS.COURSE_COMPLETED,
          { userId, courseId, completedAt: new Date().toISOString() },
          correlationId,
        );
        this.logger.log(`user ${userId} completed course ${courseId}`);
      }
    }

    return summary;
  }

  private async assertEntitled(userId: string, courseId: string) {
    if (!(await this.enrollments.isEntitled(userId, courseId))) {
      throw new ForbiddenException('Enroll in this course to track progress.');
    }
  }

  private async fetchCurriculum(courseId: string) {
    const base = this.config.get<string>('COURSE_SERVICE_URL') ?? 'http://localhost:4002';
    const { data } = await axios.get(`${base}/internal/courses/${courseId}/curriculum`, {
      headers: { [HEADER_INTERNAL_KEY]: this.config.getOrThrow<string>('INTERNAL_API_KEY') },
      timeout: 4000,
    });
    return data as { lessonCount: number; lessons: Array<{ id: string; slug: string; title: string }> };
  }
}
