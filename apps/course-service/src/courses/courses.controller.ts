import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@lp/shared';
import {
  AuthenticatedUser,
  CurrentUser,
  InternalApiGuard,
  JwtAuthGuard,
  Public,
  Roles,
  RolesGuard,
} from '../common/auth-context';
import { CoursesService } from './courses.service';
import {
  CreateCourseDto,
  CreateLessonDto,
  CreateModuleDto,
  CreateResourceDto,
  ListCoursesQuery,
  ReorderDto,
  UpdateCourseDto,
  UpdateLessonDto,
  UpdateModuleDto,
} from './dto/course.dto';

@ApiTags('courses')
@Controller('courses')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Browse published courses' })
  list(@Query() query: ListCoursesQuery) {
    return this.courses.list(query);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Course detail page with its curriculum' })
  getBySlug(@Param('slug') slug: string) {
    return this.courses.getBySlug(slug);
  }

  /**
   * Lesson content. Entitlement is resolved by the gateway, which calls
   * enrollment-service and forwards the answer as `entitled`.
   */
  @Public()
  @Get(':slug/lessons/:lessonSlug')
  getLesson(
    @Param('slug') slug: string,
    @Param('lessonSlug') lessonSlug: string,
    @Query('entitled') entitled?: string,
  ) {
    return this.courses.getLesson(slug, lessonSlug, entitled === 'true');
  }
}

@ApiTags('courses-internal')
@Controller('internal/courses')
@UseGuards(InternalApiGuard)
export class CoursesInternalController {
  constructor(private readonly courses: CoursesService) {}

  @Get(':id/pricing')
  @ApiOperation({ summary: 'Authoritative price used by payment-service' })
  pricing(@Param('id', ParseUUIDPipe) id: string) {
    return this.courses.getPricing(id);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'Title/duration for services that render a course name' })
  summary(@Param('id') id: string) {
    return this.courses.getSummary(id);
  }

  @Get(':id/curriculum')
  curriculum(@Param('id', ParseUUIDPipe) id: string) {
    return this.courses.getCurriculum(id);
  }

  @Get('lessons/:lessonId/media-key')
  mediaKey(@Param('lessonId', ParseUUIDPipe) lessonId: string) {
    return this.courses.getMediaKey(lessonId);
  }

  @Get('resources/:resourceId/media-key')
  resourceKey(@Param('resourceId', ParseUUIDPipe) resourceId: string) {
    return this.courses.getResourceKey(resourceId);
  }

  @Post(':id/enrollment-count')
  bump(@Param('id', ParseUUIDPipe) id: string) {
    return this.courses.incrementEnrollmentCount(id);
  }
}

@ApiTags('courses-admin')
@ApiBearerAuth()
@Controller('admin/courses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.INSTRUCTOR)
export class CoursesAdminController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  list() {
    return this.courses.adminList();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.courses.adminGet(id);
  }

  @Post()
  create(@Body() dto: CreateCourseDto, @CurrentUser() user: AuthenticatedUser) {
    return this.courses.create(dto, { userId: user.userId, name: user.email.split('@')[0] });
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourseDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.courses.update(id, dto, userId);
  }

  @Post(':id/publish')
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('userId') userId: string) {
    return this.courses.publish(id, true, userId);
  }

  @Post(':id/unpublish')
  unpublish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('userId') userId: string) {
    return this.courses.publish(id, false, userId);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('userId') userId: string) {
    return this.courses.remove(id, userId);
  }

  // --- modules ---

  @Post(':id/modules')
  addModule(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateModuleDto) {
    return this.courses.addModule(id, dto);
  }

  @Patch('modules/:moduleId')
  updateModule(@Param('moduleId', ParseUUIDPipe) moduleId: string, @Body() dto: UpdateModuleDto) {
    return this.courses.updateModule(moduleId, dto);
  }

  @Delete('modules/:moduleId')
  removeModule(@Param('moduleId', ParseUUIDPipe) moduleId: string) {
    return this.courses.removeModule(moduleId);
  }

  @Put(':id/modules/reorder')
  reorderModules(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReorderDto) {
    return this.courses.reorderModules(id, dto.ids);
  }

  // --- lessons ---

  @Post('modules/:moduleId/lessons')
  addLesson(@Param('moduleId', ParseUUIDPipe) moduleId: string, @Body() dto: CreateLessonDto) {
    return this.courses.addLesson(moduleId, dto);
  }

  @Patch('lessons/:lessonId')
  updateLesson(@Param('lessonId', ParseUUIDPipe) lessonId: string, @Body() dto: UpdateLessonDto) {
    return this.courses.updateLesson(lessonId, dto);
  }

  @Delete('lessons/:lessonId')
  removeLesson(@Param('lessonId', ParseUUIDPipe) lessonId: string) {
    return this.courses.removeLesson(lessonId);
  }

  @Put('modules/:moduleId/lessons/reorder')
  reorderLessons(@Param('moduleId', ParseUUIDPipe) moduleId: string, @Body() dto: ReorderDto) {
    return this.courses.reorderLessons(moduleId, dto.ids);
  }

  // --- resources (PDF / notes) ---

  @Post('lessons/:lessonId/resources')
  addResource(@Param('lessonId', ParseUUIDPipe) lessonId: string, @Body() dto: CreateResourceDto) {
    return this.courses.addResource(lessonId, dto);
  }

  @Delete('resources/:resourceId')
  removeResource(@Param('resourceId', ParseUUIDPipe) resourceId: string) {
    return this.courses.removeResource(resourceId);
  }
}

@ApiTags('coupons-internal')
@Controller('internal/coupons')
@UseGuards(InternalApiGuard)
export class CouponsInternalController {
  constructor(private readonly courses: CoursesService) {}

  /** payment-service asks: is this code usable for this course right now? */
  @Get(':code')
  validate(@Param('code') code: string, @Query('courseId') courseId?: string) {
    return this.courses.validateCoupon(code, courseId);
  }

  @Post(':code/redeem')
  redeem(@Param('code') code: string) {
    return this.courses.recordCouponRedemption(code);
  }
}
