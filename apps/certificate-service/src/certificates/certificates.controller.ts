import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Role } from '@lp/shared';
import { CurrentUser, JwtAuthGuard, Public, Roles, RolesGuard } from '../common/auth-context';
import { CertificatesService } from './certificates.service';

export class RevokeDto {
  @ApiProperty() @IsString() @MaxLength(300) reason!: string;
}

@ApiTags('certificates')
@Controller('certificates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get('me')
  @ApiBearerAuth()
  mine(@CurrentUser('userId') userId: string) {
    return this.certificates.listMine(userId);
  }

  @Post('courses/:courseId/claim')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Claim a certificate for a course you have finished' })
  claim(@CurrentUser('userId') userId: string, @Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.certificates.issue(userId, courseId);
  }

  /**
   * Public and rate limited: this is the endpoint an employer hits, and also
   * the one someone would use to walk the serial space. The serial has ~60
   * bits of entropy, and 20 checks a minute makes enumeration hopeless.
   */
  @Public()
  @Get('verify/:serial')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Public verification of a certificate serial' })
  verify(@Param('serial') serial: string, @Req() req: Request) {
    return this.certificates.verify(serial, req.ip, req.headers['user-agent']);
  }

  @Get(':serial/print')
  @ApiBearerAuth()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Printable certificate (use the browser to save as PDF)' })
  print(@CurrentUser('userId') userId: string, @Param('serial') serial: string) {
    return this.certificates.renderHtml(serial, userId);
  }

  @Post('admin/:serial/revoke')
  @ApiBearerAuth()
  @Roles(Role.ADMIN)
  revoke(@Param('serial') serial: string, @Body() dto: RevokeDto) {
    return this.certificates.revoke(serial, dto.reason);
  }
}
