import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'student@example.com' })
  @IsEmail()
  @Transform(({ value }) => String(value ?? '').trim().toLowerCase())
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @Length(20, 200)
  token!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  @Matches(/[a-z]/, { message: 'Password must contain a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'Password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'Password must contain a number' })
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  newPassword!: string;
}
