import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CourseLevel, CourseStatus, LessonType, ResourceKind } from '@prisma/client';

export class CreateCourseDto {
  @ApiProperty({ example: 'DevOps & SRE Engineering' })
  @IsString() @MinLength(4) @MaxLength(200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(300)
  subtitle?: string;

  @ApiProperty()
  @IsString() @MinLength(20)
  description!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true })
  outcomes?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true })
  prerequisites?: string[];

  @ApiPropertyOptional({ enum: CourseLevel })
  @IsOptional() @IsEnum(CourseLevel)
  level?: CourseLevel;

  @ApiProperty({ description: 'Price in paise. 499900 = Rs 4,999', example: 499900 })
  @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000)
  priceMinor!: number;

  @ApiPropertyOptional({ example: 999900 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  listPriceMinor?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  isFree?: boolean;

  @ApiPropertyOptional()
  @IsOptional() @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(400)
  thumbnailKey?: string;
}

export class UpdateCourseDto extends PartialType(CreateCourseDto) {
  @ApiPropertyOptional({ enum: CourseStatus })
  @IsOptional() @IsEnum(CourseStatus)
  status?: CourseStatus;
}

export class CreateModuleDto {
  @ApiProperty()
  @IsString() @MinLength(3) @MaxLength(200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(1000)
  summary?: string;

  @ApiPropertyOptional({ description: 'Defaults to last position' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  isPreview?: boolean;
}

export class UpdateModuleDto extends PartialType(CreateModuleDto) {}

export class ReorderDto {
  @ApiProperty({ type: [String], description: 'Ids in the new display order' })
  @IsArray() @IsUUID('4', { each: true })
  ids!: string[];
}

export class CreateLessonDto {
  @ApiProperty()
  @IsString() @MinLength(3) @MaxLength(200)
  title!: string;

  @ApiProperty({ enum: LessonType })
  @IsEnum(LessonType)
  type!: LessonType;

  @ApiPropertyOptional()
  @IsOptional() @IsString()
  contentMarkdown?: string;

  @ApiPropertyOptional({ description: 'S3 object key, never a URL' })
  @IsOptional() @IsString() @MaxLength(400)
  videoKey?: string;

  @ApiPropertyOptional()
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  videoDuration?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  isPreview?: boolean;

  @ApiPropertyOptional({ example: 'linux-basics' })
  @IsOptional() @IsString() @MaxLength(80)
  labTemplateId?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsUUID()
  quizId?: string;

  @ApiPropertyOptional()
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  sortOrder?: number;
}

export class UpdateLessonDto extends PartialType(CreateLessonDto) {}

export class CreateResourceDto {
  @ApiProperty({ enum: ResourceKind })
  @IsEnum(ResourceKind)
  kind!: ResourceKind;

  @ApiProperty()
  @IsString() @MaxLength(200)
  title!: string;

  @ApiProperty({ description: 'Private S3 key' })
  @IsString() @MaxLength(400)
  storageKey!: string;

  @ApiPropertyOptional()
  @IsOptional() @Type(() => Number) @IsInt()
  sizeBytes?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(120)
  mimeType?: string;
}

export class ListCoursesQuery {
  @ApiPropertyOptional({ example: 'devops' })
  @IsOptional() @IsString() @MaxLength(80)
  @Transform(({ value }) => String(value ?? '').trim())
  q?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: CourseLevel })
  @IsOptional() @IsEnum(CourseLevel)
  level?: CourseLevel;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 12 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  pageSize?: number = 12;
}
