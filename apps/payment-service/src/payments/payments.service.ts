import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';
import { PrismaService } from '../prisma/prisma.module';
import { EventBus, EVENTS, EventEnvelope } from '@lp/shared';
import { CreateOrderDto } from './dto/create-order.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';

interface CoursePricing {
  id: string;
  slug: string;
  title: string;
  priceMinor: number;
  currency: string;
  isFree: boolean;
  status: string;
}

interface CouponValidation {
  valid: boolean;
  reason?: string;
  code?: string;
  discountType?: string;
  discountValue?: number;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly razorpay: Razorpay;

  private readonly courseServiceUrl =
    process.env.COURSE_SERVICE_URL ?? 'http://localhost:4002';

  private readonly internalApiKey =
    process.env.INTERNAL_API_KEY ?? 'dev_internal_key_change_me';

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {
    this.razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID ?? '',
      key_secret: process.env.RAZORPAY_KEY_SECRET ?? '',
    });
  }

  private headers() {
    return {
      'x-internal-key': this.internalApiKey,
    };
  }

  private calculateDiscount(
    pricing: CoursePricing,
    coupon: CouponValidation,
  ): number {
    if (!coupon.valid || !coupon.discountType || coupon.discountValue == null) {
      return 0;
    }

    if (coupon.discountType === 'PERCENTAGE') {
      return Math.min(
        pricing.priceMinor,
        Math.floor(
          (pricing.priceMinor * coupon.discountValue) / 100,
        ),
      );
    }

    if (coupon.discountType === 'FIXED') {
      return Math.min(pricing.priceMinor, coupon.discountValue);
    }

    return 0;
  }

  async createOrder(userId: string, dto: CreateOrderDto) {
    if (!userId) {
      throw new BadRequestException('Authenticated user is required.');
    }

    const pricingResponse = await axios.get<CoursePricing>(
      `${this.courseServiceUrl}/internal/courses/${dto.courseId}/pricing`,
      {
        headers: this.headers(),
        timeout: 5000,
      },
    );

    const pricing = pricingResponse.data;

    if (pricing.isFree || pricing.priceMinor <= 0) {
      throw new BadRequestException(
        'This course does not require a payment.',
      );
    }

    let coupon: CouponValidation = { valid: false };

    if (dto.couponCode) {
      const response = await axios.get<CouponValidation>(
        `${this.courseServiceUrl}/internal/coupons/${encodeURIComponent(
          dto.couponCode,
        )}`,
        {
          params: { courseId: dto.courseId },
          headers: this.headers(),
          timeout: 5000,
        },
      );

      coupon = response.data;

      if (!coupon.valid) {
        throw new BadRequestException(
          `Coupon is not valid: ${coupon.reason ?? 'unknown reason'}.`,
        );
      }
    }

    const discountMinor = this.calculateDiscount(pricing, coupon);
    const amountMinor = pricing.priceMinor - discountMinor;

    if (amountMinor <= 0) {
      throw new BadRequestException(
        'The final payable amount must be greater than zero.',
      );
    }

    const idempotencyKey = crypto.randomUUID();

    const existing = await this.prisma.payment.findUnique({
      where: { idempotencyKey },
    });

    if (existing) {
      return existing;
    }

    const razorpayOrder = await this.razorpay.orders.create({
      amount: amountMinor,
      currency: pricing.currency,
      receipt: `lp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      notes: {
        userId,
        courseId: dto.courseId,
      },
    });

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        courseId: dto.courseId,
        orderId: razorpayOrder.id,
        amountMinor,
        originalAmountMinor: pricing.priceMinor,
        discountMinor,
        currency: pricing.currency,
        couponCode: coupon.code,
        status: 'PENDING',
        idempotencyKey,
      },
    });

    return {
      paymentId: payment.id,
      orderId: razorpayOrder.id,
      amountMinor,
      currency: pricing.currency,
      courseId: dto.courseId,
      courseTitle: pricing.title,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    };
  }

  async verifyPayment(userId: string, dto: VerifyPaymentDto) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: dto.paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found.');
    }

    if (payment.userId !== userId) {
      throw new BadRequestException('Payment does not belong to this user.');
    }

    if (payment.orderId !== dto.razorpayOrderId) {
      throw new BadRequestException('Razorpay order ID mismatch.');
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET ?? '')
      .update(`${dto.razorpayOrderId}|${dto.razorpayPaymentId}`)
      .digest('hex');

    if (
      !crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(dto.razorpaySignature),
      )
    ) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          failureReason: 'Invalid Razorpay signature',
        },
      });

      throw new BadRequestException('Invalid Razorpay payment signature.');
    }

    if (
      payment.status === 'COMPLETED' &&
      payment.razorpayPaymentId === dto.razorpayPaymentId
    ) {
      return {
        success: true,
        paymentId: payment.id,
        status: payment.status,
      };
    }

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        razorpayPaymentId: dto.razorpayPaymentId,
        razorpaySignature: dto.razorpaySignature,
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    await this.publishPaymentCompleted(updated);

    if (updated.couponCode) {
      try {
        await axios.post(
          `${this.courseServiceUrl}/internal/coupons/${encodeURIComponent(
            updated.couponCode,
          )}/redeem`,
          {},
          {
            headers: this.headers(),
            timeout: 5000,
          },
        );
      } catch (error) {
        this.logger.error(
          `Coupon redemption update failed for ${updated.couponCode}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    return {
      success: true,
      paymentId: updated.id,
      status: updated.status,
    };
  }

  async createRefund(
    userId: string,
    paymentId: string,
    dto: RefundPaymentDto,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found.');
    }

    if (payment.userId !== userId) {
      throw new BadRequestException('Payment does not belong to this user.');
    }

    if (payment.status !== 'COMPLETED') {
      throw new ConflictException(
        'Only completed payments can be refunded.',
      );
    }

    if (!payment.razorpayPaymentId) {
      throw new ConflictException(
        'Razorpay payment ID is missing.',
      );
    }

    const refund = await this.razorpay.payments.refund(
      payment.razorpayPaymentId,
      {
        amount: payment.amountMinor,
        notes: {
          reason: dto.reason ?? 'customer_requested',
          courseId: payment.courseId,
          userId: payment.userId,
        },
      },
    );

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'REFUNDED',
        refundedAt: new Date(),
      },
    });

    await this.publishPaymentRefunded(payment);

    return {
      success: true,
      paymentId: payment.id,
      refundId: refund.id,
      status: 'REFUNDED',
    };
  }

  async handleWebhook(rawBody: Buffer, signature: string) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    if (
      !crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature),
      )
    ) {
      throw new BadRequestException('Invalid webhook signature.');
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    switch (event.event) {
      case 'payment.captured':
        await this.handlePaymentCapturedWebhook(event);
        break;

      case 'payment.failed':
        await this.handlePaymentFailedWebhook(event);
        break;

      case 'refund.processed':
        await this.handleRefundProcessedWebhook(event);
        break;

      default:
        this.logger.debug(`Ignoring Razorpay event: ${event.event}`);
    }

    return { received: true };
  }

  private async handlePaymentCapturedWebhook(event: any) {
    const razorpayPaymentId = event.payload?.payment?.entity?.id;
    const razorpayOrderId = event.payload?.payment?.entity?.order_id;

    if (!razorpayPaymentId || !razorpayOrderId) {
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { orderId: razorpayOrderId },
    });

    if (!payment || payment.status === 'COMPLETED') {
      return;
    }

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        razorpayPaymentId,
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    await this.publishPaymentCompleted(updated);
  }

  private async handlePaymentFailedWebhook(event: any) {
    const entity = event.payload?.payment?.entity;

    const razorpayOrderId = entity?.order_id;
    const reason =
      entity?.error_description ??
      entity?.error_reason ??
      'Razorpay payment failed';

    if (!razorpayOrderId) {
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { orderId: razorpayOrderId },
    });

    if (!payment || payment.status === 'COMPLETED') {
      return;
    }

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'FAILED',
        failureReason: reason,
      },
    });

    const eventEnvelope: EventEnvelope = {
      id: crypto.randomUUID(),
      name: EVENTS.PAYMENT_FAILED,
      occurredAt: new Date().toISOString(),
      source: 'payment-service',
      version: 1,
      data: {
        orderId: updated.orderId,
        userId: updated.userId,
        courseId: updated.courseId,
        reason,
      },
    };

    await this.eventBus.publish(eventEnvelope.name, eventEnvelope.data);
  }

  private async handleRefundProcessedWebhook(event: any) {
    const entity = event.payload?.refund?.entity;

    const paymentId = entity?.payment_id;

    if (!paymentId) {
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { razorpayPaymentId: paymentId },
    });

    if (!payment || payment.status === 'REFUNDED') {
      return;
    }

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'REFUNDED',
        refundedAt: new Date(),
      },
    });

    await this.publishPaymentRefunded(updated);
  }

  private async publishPaymentCompleted(payment: {
    id: string;
    orderId: string;
    userId: string;
    courseId: string;
    amountMinor: number;
    currency: string;
    razorpayPaymentId: string | null;
  }) {
    if (!payment.razorpayPaymentId) {
      return;
    }

    const event: EventEnvelope = {
      id: crypto.randomUUID(),
      name: EVENTS.PAYMENT_COMPLETED,
      occurredAt: new Date().toISOString(),
      source: 'payment-service',
      version: 1,
      data: {
        paymentId: payment.id,
        orderId: payment.orderId,
        userId: payment.userId,
        courseId: payment.courseId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        razorpayPaymentId: payment.razorpayPaymentId,
      },
    };

    await this.eventBus.publish(event.name, event.data);
  }

  private async publishPaymentRefunded(payment: {
    id: string;
    userId: string;
    courseId: string;
  }) {
    const event: EventEnvelope = {
      id: crypto.randomUUID(),
      name: EVENTS.PAYMENT_REFUNDED,
      occurredAt: new Date().toISOString(),
      source: 'payment-service',
      version: 1,
      data: {
        paymentId: payment.id,
        userId: payment.userId,
        courseId: payment.courseId,
      },
    };

    await this.eventBus.publish(event.name, event.data);
  }
}
