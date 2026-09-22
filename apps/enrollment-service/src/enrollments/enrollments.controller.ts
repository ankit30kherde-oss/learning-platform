import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength } from 'class-validator';
import { Role } from '@lp/shared';
import {
  CurrentUser,
  InternalApiGuard,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from '../common/auth-context';
import { EnrollmentsService } from './enrollments.service';

class GrantDto {
  @IsUUID() userId!: string;
  @IsUUID() courseId!: string;
}

class RevokeDto {
  @IsUUID() userId!: string;
  @IsUUID() courseId!: string;
  @IsString() @MaxLength(120) reason!: string;
}

@ApiTags('enrollments')
@ApiBearerAuth()
@Controller('enrollments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Courses the signed-in student can open' })
  listMine(@CurrentUser('userId') userId: string) {
    return this.enrollments.listMine(userId);
  }

  @Get('me/:courseId')
  async mine(@CurrentUser('userId') userId: string, @Param('courseId', ParseUUIDPipe) courseId: string) {
    const entitled = await this.enrollments.isEntitled(userId, courseId);
    return { courseId, entitled };
  }

  @Post('free/:courseId')
  @ApiOperation({ summary: 'Enroll in a free course' })
  enrollFree(
    @CurrentUser('userId') userId: string,
    @Param('courseId', ParseUUIDPipe) courseId: string,
  ) {
    return this.enrollments.enrollFree(userId, courseId);
  }

  @Post('admin/grant')
  @Roles(Role.ADMIN)
  grant(@Body() dto: GrantDto) {
    return this.enrollments.grant(dto.userId, dto.courseId);
  }

  @Post('admin/revoke')
  @Roles(Role.ADMIN)
  revoke(@Body() dto: RevokeDto) {
    return this.enrollments.revoke(dto.userId, dto.courseId, dto.reason);
  }
}

@ApiTags('enrollments-internal')
@Controller('internal/enrollments')
@UseGuards(InternalApiGuard)
export class EnrollmentsInternalController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  /**
   * Used by the gateway, media-service, lab-service and quiz-service before any
   * protected content is handed out, and by certificate-service with
   * `withProgress=true` to confirm the course is actually finished.
   */
  @Get('check')
  async check(
    @Query('userId') userId: string,
    @Query('courseId') courseId: string,
    @Query('withProgress') withProgress?: string,
  ) {
    const entitled = await this.enrollments.isEntitled(userId, courseId);
    if (withProgress !== 'true') return { entitled };
    return { entitled, progressPercent: await this.enrollments.progressPercent(userId, courseId) };
  }
}
