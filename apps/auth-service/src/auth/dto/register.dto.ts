import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class RegisterDto {
  @ApiProperty({ example: 'student@example.com' })
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(255)
  @Transform(({ value }) => String(value ?? '').trim().toLowerCase())
  email!: string;

  @ApiProperty({ example: 'Correct-Horse-9', minLength: 10 })
  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @MaxLength(128)
  @Matches(/[a-z]/, { message: 'Password must contain a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'Password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'Password must contain a number' })
  password!: string;

  @ApiProperty({ example: 'Asha Kulkarni' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => String(value ?? '').trim())
  fullName!: string;

  @ApiProperty({ required: false, example: '+919812345678' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
