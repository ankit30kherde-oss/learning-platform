import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class CreateOrderDto {
  @IsUUID()
  courseId!: string;

  @IsOptional()
  @IsString()
  @Length(2, 50)
  @Matches(/^[A-Za-z0-9_-]+$/)
  couponCode?: string;
}
