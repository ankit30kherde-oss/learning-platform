import { IsOptional, IsString, Length } from 'class-validator';

export class RefundPaymentDto {
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}
