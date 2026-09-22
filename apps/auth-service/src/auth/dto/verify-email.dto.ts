import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'Raw token from the verification email link' })
  @IsString()
  @Length(20, 200)
  token!: string;
}
