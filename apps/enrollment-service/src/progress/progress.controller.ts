import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, JwtAuthGuard, RolesGuard } from '../common/auth-context';
import { ProgressService } from './progress.service';

class SavePositionDto {
  @IsUUID() courseId!: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(100_000) position!: number;
}

class CompleteDto {
  @IsUUID() courseId!: string;
}

@ApiTags('progress')
@ApiBearerAuth()
@Controller('progress')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  @Get('courses/:courseId')
  @ApiOperation({ summary: 'Percent complete, completed lesson ids and resume points' })
  course(
    @CurrentUser('userId') userId: string,
    @Param('courseId', ParseUUIDPipe) courseId: string,
  ) {
    return this.progress.getCourseProgress(userId, courseId);
  }

  @Post('lessons/:lessonId/position')
  @ApiOperation({ summary: 'Video player heartbeat' })
  position(
    @CurrentUser('userId') userId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: SavePositionDto,
  ) {
    return this.progress.savePosition(userId, dto.courseId, lessonId, dto.position);
  }

  @Post('lessons/:lessonId/complete')
  @ApiOperation({ summary: 'Mark a lesson complete and recompute course progress' })
  complete(
    @CurrentUser('userId') userId: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
    @Body() dto: CompleteDto,
  ) {
    return this.progress.completeLesson(userId, dto.courseId, lessonId);
  }
}
