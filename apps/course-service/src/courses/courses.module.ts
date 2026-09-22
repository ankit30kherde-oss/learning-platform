import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import {
  CouponsInternalController,
  CoursesAdminController,
  CoursesController,
  CoursesInternalController,
} from './courses.controller';
import { CoursesService } from './courses.service';

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  controllers: [
    CoursesController,
    CoursesInternalController,
    CouponsInternalController,
    CoursesAdminController,
  ],
  providers: [CoursesService],
  exports: [CoursesService],
})
export class CoursesModule {}
