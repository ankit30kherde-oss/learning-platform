import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@lp/shared';
import {
  AuthenticatedUser,
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
} from '../common/auth-context';
import { LabsService } from './labs.service';

export class StartLabDto {
  @ApiProperty() @IsUUID() courseId!: string;
  @ApiProperty() @IsUUID() lessonId!: string;
  /**
   * Either the template uuid or its slug. The catalog seed refers to templates
   * by slug ("linux-basics"), and forcing course authors to paste uuids into
   * lesson records would be a needless trap.
   */
  @ApiProperty({ example: 'linux-basics' })
  @IsString()
  @MaxLength(120)
  @Matches(/^[a-z0-9-]+$/i, { message: 'templateId must be a uuid or a slug' })
  templateId!: string;
}

@ApiTags('labs')
@ApiBearerAuth()
@Controller('labs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LabsController {
  constructor(private readonly labs: LabsService) {}

  /**
   * Starting a lab creates real infrastructure, so it is rate limited far more
   * tightly than a normal read. Five a minute is generous for a human and
   * useless for a script.
   */
  @Post('sessions')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Provision an isolated Linux lab and return a one-time WS ticket' })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StartLabDto,
    @Req() req: Request,
  ) {
    return this.labs.start({
      userId: user.userId,
      courseId: dto.courseId,
      lessonId: dto.lessonId,
      templateId: dto.templateId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('sessions/:id/stop')
  @ApiOperation({ summary: 'End a lab session and destroy its resources' })
  stop(@CurrentUser('userId') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.labs.stop(id, userId, 'user_ended');
  }

  @Delete('sessions/:id')
  destroy(@CurrentUser('userId') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.labs.stop(id, userId, 'user_ended');
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Recent lab sessions for the signed-in student' })
  mine(@CurrentUser('userId') userId: string) {
    return this.labs.listMine(userId);
  }

  @Get('templates')
  @Roles(Role.ADMIN, Role.INSTRUCTOR)
  templates() {
    return this.labs.listTemplates();
  }
}
