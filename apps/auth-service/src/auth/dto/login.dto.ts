import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class LoginDto {
  @ApiProperty({ example: 'student@example.com' })
  @IsEmail()
  @Transform(({ value }) => String(value ?? '').trim().toLowerCase())
  email!: string;

  @ApiProperty({ example: 'Correct-Horse-9' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
