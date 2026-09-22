import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Body, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsUUID, ArrayMaxSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { InternalApiGuard } from './guards/internal.guard';
import { PrismaService } from '../prisma/prisma.service';

export class BulkUsersDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  userIds!: string[];
}

/**
 * Service-to-service reads of the user record.
 *
 * auth-service owns identity, so certificate-service and notification-service
 * ask here for a name and an email rather than caching their own copy and
 * slowly drifting out of date. The guard requires the internal API key, and
 * this controller is never exposed through the public gateway routes.
 */
@ApiTags('users-internal')
@Controller('internal/users')
@UseGuards(InternalApiGuard)
export class UsersInternalController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Minimal user record for another service' })
  async byId(@Param('id', ParseUUIDPipe) id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      // Never the password hash, never the token tables.
      select: { id: true, email: true, fullName: true, status: true, roles: true, createdAt: true },
    });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Resolve many users at once (notification fan-out)' })
  bulk(@Body() dto: BulkUsersDto) {
    return this.prisma.user.findMany({
      where: { id: { in: dto.userIds } },
      select: { id: true, email: true, fullName: true, status: true },
    });
  }
}
