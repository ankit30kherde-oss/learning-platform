import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CourseStatus, Prisma } from '@prisma/client';
import slugify from 'slugify';
import { PrismaService } from '../prisma/prisma.module';
import {
  CreateCourseDto,
  CreateLessonDto,
  CreateModuleDto,
  CreateResourceDto,
  ListCoursesQuery,
  UpdateCourseDto,
  UpdateLessonDto,
  UpdateModuleDto,
} from './dto/course.dto';

/**
 * Catalog rules that matter:
 *  - Only PUBLISHED, non-deleted courses are visible to students.
 *  - videoKey / storageKey are S3 keys and are NEVER returned to a student.
 *    The lesson payload a student receives carries only ids; media-service
 *    exchanges a lesson id for a short-lived signed URL after checking
 *    enrollment.
 *  - Price is always read from here, never from the browser (see payment flow).
 */
@Injectable()
export class CoursesService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- public catalog ------------------------------------------------------

  async list(query: ListCoursesQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 12;

    const where: Prisma.CourseWhereInput = {
      status: CourseStatus.PUBLISHED,
      deletedAt: null,
      ...(query.level ? { level: query.level } : {}),
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { subtitle: { contains: query.q, mode: 'insensitive' } },
              { tags: { has: query.q.toLowerCase() } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: publicCourseCardSelect,
      }),
      this.prisma.course.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /** Full course page. Locked lessons are returned without any media key. */
  async getBySlug(slug: string) {
    const course = await this.prisma.course.findFirst({
      where: { slug, status: CourseStatus.PUBLISHED, deletedAt: null },
      include: {
        category: { select: { slug: true, name: true } },
        modules: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
          include: {
            lessons: {
              where: { deletedAt: null },
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                title: true,
                slug: true,
                type: true,
                videoDuration: true,
                isPreview: true,
                sortOrder: true,
              },
            },
          },
        },
      },
    });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  /**
   * Lesson content for a student. `entitled` is decided by the caller
   * (enrollment-service via the gateway); preview lessons are always allowed.
   */
  async getLesson(courseSlug: string, lessonSlug: string, entitled: boolean) {
    const course = await this.prisma.course.findFirst({
      where: { slug: courseSlug, deletedAt: null },
      select: { id: true, title: true, slug: true },
    });
    if (!course) throw new NotFoundException('Course not found.');

    const lesson = await this.prisma.lesson.findFirst({
      where: { courseId: course.id, slug: lessonSlug, deletedAt: null },
      include: {
        resources: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, kind: true, title: true, mimeType: true, sizeBytes: true },
        },
        module: { select: { id: true, title: true, sortOrder: true } },
      },
    });
    if (!lesson) throw new NotFoundException('Lesson not found.');

    const unlocked = entitled || lesson.isPreview;

    return {
      course,
      module: lesson.module,
      lesson: {
        id: lesson.id,
        title: lesson.title,
        slug: lesson.slug,
        type: lesson.type,
        isPreview: lesson.isPreview,
        videoDuration: lesson.videoDuration,
        sortOrder: lesson.sortOrder,
        labTemplateId: unlocked ? lesson.labTemplateId : null,
        quizId: unlocked ? lesson.quizId : null,
        contentMarkdown: unlocked ? lesson.contentMarkdown : null,
        hasVideo: Boolean(lesson.videoKey),
        resources: unlocked ? lesson.resources : [],
      },
      unlocked,
    };
  }

  /** Flat ordered lesson list - progress-service uses it to compute percent. */
  async getCurriculum(courseId: string) {
    const lessons = await this.prisma.lesson.findMany({
      where: { courseId, deletedAt: null },
      orderBy: [{ module: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
      select: { id: true, title: true, slug: true, type: true, moduleId: true },
    });
    return { courseId, lessonCount: lessons.length, lessons };
  }

  // ---- internal (service-to-service) --------------------------------------

  /** Authoritative price. payment-service calls this; it never trusts the client. */
  async getPricing(courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        title: true,
        priceMinor: true,
        currency: true,
        isFree: true,
        status: true,
      },
    });
    if (!course) throw new NotFoundException('Course not found.');
    if (course.status !== CourseStatus.PUBLISHED) {
      throw new BadRequestException('This course is not available for purchase.');
    }
    return course;
  }

  /**
   * A non-purchase view of a course for other services (certificate-service
   * needs the title and duration of a course that may since have been
   * unpublished, which getPricing deliberately refuses to return).
   */
  async getSummary(courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId },
      select: {
        id: true,
        slug: true,
        title: true,
        instructorName: true,
        durationMinutes: true,
        status: true,
        currency: true,
        priceMinor: true,
      },
    });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  /** media-service asks: what is the S3 key behind this lesson's video? */
  async getMediaKey(lessonId: string) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: lessonId, deletedAt: null },
      select: { id: true, courseId: true, videoKey: true, isPreview: true },
    });
    if (!lesson) throw new NotFoundException('Lesson not found.');
    return lesson;
  }

  async getResourceKey(resourceId: string) {
    const resource = await this.prisma.lessonResource.findFirst({
      where: { id: resourceId, deletedAt: null },
      include: { lesson: { select: { courseId: true, isPreview: true } } },
    });
    if (!resource) throw new NotFoundException('Resource not found.');
    return {
      id: resource.id,
      storageKey: resource.storageKey,
      mimeType: resource.mimeType,
      title: resource.title,
      courseId: resource.lesson.courseId,
      isPreview: resource.lesson.isPreview,
    };
  }

  /**
   * Coupon validation for payment-service. Returns a plain verdict so the
   * discount maths stays in one place (payment-service applies it to the
   * authoritative price it already fetched from here).
   */
  async validateCoupon(code: string, courseId?: string) {
    const coupon = await this.prisma.coupon.findFirst({
      where: { code: code.toUpperCase(), deletedAt: null },
      include: { courses: true },
    });
    const invalid = { valid: false as const, reason: 'not_found' };
    if (!coupon || !coupon.isActive) return invalid;

    const now = new Date();
    if (coupon.startsAt && coupon.startsAt > now) return { valid: false as const, reason: 'not_started' };
    if (coupon.expiresAt && coupon.expiresAt < now) return { valid: false as const, reason: 'expired' };
    if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
      return { valid: false as const, reason: 'exhausted' };
    }
    // No rows in coupon_courses means "applies to every course".
    if (coupon.courses.length > 0 && courseId && !coupon.courses.some((c) => c.courseId === courseId)) {
      return { valid: false as const, reason: 'not_applicable' };
    }

    return {
      valid: true as const,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
    };
  }

  async recordCouponRedemption(code: string) {
    await this.prisma.coupon.updateMany({
      where: { code: code.toUpperCase() },
      data: { redeemedCount: { increment: 1 } },
    });
  }

  async incrementEnrollmentCount(courseId: string) {
    await this.prisma.course.updateMany({
      where: { id: courseId },
      data: { enrollmentCount: { increment: 1 } },
    });
  }

  // ---- admin / instructor --------------------------------------------------

  async adminList() {
    return this.prisma.course.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, slug: true, title: true, status: true, priceMinor: true, currency: true,
        lessonCount: true, enrollmentCount: true, updatedAt: true, instructorName: true,
      },
    });
  }

  async adminGet(id: string) {
    const course = await this.prisma.course.findFirst({
      where: { id, deletedAt: null },
      include: {
        modules: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
          include: {
            lessons: {
              where: { deletedAt: null },
              orderBy: { sortOrder: 'asc' },
              include: { resources: { where: { deletedAt: null } } },
            },
          },
        },
      },
    });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  async create(dto: CreateCourseDto, actor: { userId: string; name: string }) {
    const slug = await this.uniqueSlug(dto.title);
    return this.prisma.course.create({
      data: {
        slug,
        title: dto.title,
        subtitle: dto.subtitle,
        description: dto.description,
        outcomes: dto.outcomes ?? [],
        prerequisites: dto.prerequisites ?? [],
        level: dto.level,
        priceMinor: dto.isFree ? 0 : dto.priceMinor,
        listPriceMinor: dto.listPriceMinor,
        isFree: dto.isFree ?? false,
        categoryId: dto.categoryId,
        tags: (dto.tags ?? []).map((t) => t.toLowerCase()),
        thumbnailKey: dto.thumbnailKey,
        instructorId: actor.userId,
        instructorName: actor.name,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      },
    });
  }

  async update(id: string, dto: UpdateCourseDto, actorId: string) {
    await this.mustExist(id);
    const publishing = dto.status === CourseStatus.PUBLISHED;
    return this.prisma.course.update({
      where: { id },
      data: {
        ...dto,
        tags: dto.tags ? dto.tags.map((t) => t.toLowerCase()) : undefined,
        publishedAt: publishing ? new Date() : undefined,
        updatedBy: actorId,
      },
    });
  }

  async publish(id: string, publish: boolean, actorId: string) {
    const course = await this.mustExist(id);
    if (publish) {
      const lessons = await this.prisma.lesson.count({ where: { courseId: id, deletedAt: null } });
      if (lessons === 0) {
        throw new BadRequestException('Add at least one lesson before publishing.');
      }
    }
    return this.prisma.course.update({
      where: { id: course.id },
      data: {
        status: publish ? CourseStatus.PUBLISHED : CourseStatus.DRAFT,
        publishedAt: publish ? new Date() : null,
        updatedBy: actorId,
      },
    });
  }

  /** Soft delete: history, invoices and enrollments must keep resolving. */
  async remove(id: string, actorId: string) {
    await this.mustExist(id);
    await this.prisma.course.update({
      where: { id },
      data: { deletedAt: new Date(), status: CourseStatus.ARCHIVED, updatedBy: actorId },
    });
    return { message: 'Course archived.' };
  }

  async addModule(courseId: string, dto: CreateModuleDto) {
    await this.mustExist(courseId);
    const sortOrder = dto.sortOrder ?? (await this.nextModuleOrder(courseId));
    return this.prisma.courseModule.create({
      data: { courseId, title: dto.title, summary: dto.summary, sortOrder, isPreview: dto.isPreview ?? false },
    });
  }

  async updateModule(moduleId: string, dto: UpdateModuleDto) {
    return this.prisma.courseModule.update({ where: { id: moduleId }, data: dto });
  }

  async removeModule(moduleId: string) {
    await this.prisma.courseModule.update({
      where: { id: moduleId },
      data: { deletedAt: new Date() },
    });
    return { message: 'Module removed.' };
  }

  /**
   * Reordering uses a two-phase update inside one transaction: sortOrder has a
   * unique constraint per course, so we first park rows at negative offsets.
   */
  async reorderModules(courseId: string, ids: string[]) {
    await this.prisma.$transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.courseModule.update({ where: { id }, data: { sortOrder: -(i + 1) } });
      }
      for (const [i, id] of ids.entries()) {
        await tx.courseModule.update({ where: { id }, data: { sortOrder: i } });
      }
    });
    return this.prisma.courseModule.findMany({
      where: { courseId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async addLesson(moduleId: string, dto: CreateLessonDto) {
    const mod = await this.prisma.courseModule.findUniqueOrThrow({ where: { id: moduleId } });
    const sortOrder = dto.sortOrder ?? (await this.nextLessonOrder(moduleId));
    const slug = await this.uniqueLessonSlug(mod.courseId, dto.title);

    const lesson = await this.prisma.lesson.create({
      data: {
        moduleId,
        courseId: mod.courseId,
        title: dto.title,
        slug,
        type: dto.type,
        contentMarkdown: dto.contentMarkdown,
        videoKey: dto.videoKey,
        videoDuration: dto.videoDuration ?? 0,
        isPreview: dto.isPreview ?? false,
        labTemplateId: dto.labTemplateId,
        quizId: dto.quizId,
        sortOrder,
      },
    });
    await this.refreshCourseCounters(mod.courseId);
    return lesson;
  }

  async updateLesson(lessonId: string, dto: UpdateLessonDto) {
    const lesson = await this.prisma.lesson.update({ where: { id: lessonId }, data: dto });
    await this.refreshCourseCounters(lesson.courseId);
    return lesson;
  }

  async removeLesson(lessonId: string) {
    const lesson = await this.prisma.lesson.update({
      where: { id: lessonId },
      data: { deletedAt: new Date() },
    });
    await this.refreshCourseCounters(lesson.courseId);
    return { message: 'Lesson removed.' };
  }

  async reorderLessons(moduleId: string, ids: string[]) {
    await this.prisma.$transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.lesson.update({ where: { id }, data: { sortOrder: -(i + 1) } });
      }
      for (const [i, id] of ids.entries()) {
        await tx.lesson.update({ where: { id }, data: { sortOrder: i } });
      }
    });
    return this.prisma.lesson.findMany({
      where: { moduleId, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async addResource(lessonId: string, dto: CreateResourceDto) {
    const count = await this.prisma.lessonResource.count({ where: { lessonId, deletedAt: null } });
    return this.prisma.lessonResource.create({
      data: { lessonId, ...dto, sortOrder: count },
    });
  }

  async removeResource(resourceId: string) {
    await this.prisma.lessonResource.update({
      where: { id: resourceId },
      data: { deletedAt: new Date() },
    });
    return { message: 'Resource removed.' };
  }

  // ---- helpers -------------------------------------------------------------

  private async mustExist(id: string) {
    const course = await this.prisma.course.findFirst({ where: { id, deletedAt: null } });
    if (!course) throw new NotFoundException('Course not found.');
    return course;
  }

  private async refreshCourseCounters(courseId: string) {
    const agg = await this.prisma.lesson.aggregate({
      where: { courseId, deletedAt: null },
      _count: { _all: true },
      _sum: { videoDuration: true },
    });
    await this.prisma.course.update({
      where: { id: courseId },
      data: {
        lessonCount: agg._count._all,
        durationMinutes: Math.round((agg._sum.videoDuration ?? 0) / 60),
      },
    });
  }

  private async nextModuleOrder(courseId: string) {
    const last = await this.prisma.courseModule.findFirst({
      where: { courseId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? -1) + 1;
  }

  private async nextLessonOrder(moduleId: string) {
    const last = await this.prisma.lesson.findFirst({
      where: { moduleId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? -1) + 1;
  }

  private async uniqueSlug(title: string): Promise<string> {
    const base = slugify(title, { lower: true, strict: true }).slice(0, 120);
    let candidate = base;
    let n = 1;
    while (await this.prisma.course.findUnique({ where: { slug: candidate } })) {
      candidate = `${base}-${++n}`;
    }
    return candidate;
  }

  private async uniqueLessonSlug(courseId: string, title: string): Promise<string> {
    const base = slugify(title, { lower: true, strict: true }).slice(0, 140);
    let candidate = base;
    let n = 1;
    while (
      await this.prisma.lesson.findFirst({ where: { courseId, slug: candidate } })
    ) {
      candidate = `${base}-${++n}`;
    }
    return candidate;
  }
}

export const publicCourseCardSelect = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  level: true,
  priceMinor: true,
  listPriceMinor: true,
  currency: true,
  isFree: true,
  thumbnailKey: true,
  durationMinutes: true,
  lessonCount: true,
  enrollmentCount: true,
  ratingAvg: true,
  instructorName: true,
  tags: true,
  publishedAt: true,
} satisfies Prisma.CourseSelect;
