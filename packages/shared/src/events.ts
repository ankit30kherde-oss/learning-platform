/**
 * Every asynchronous message in the platform.
 *
 * Dev/Codespaces : Redis Pub/Sub (see event-bus.ts) - zero AWS credentials needed.
 * Production     : Amazon EventBridge (routing) -> SQS queues (per consumer).
 *                  The publish()/subscribe() interface below is deliberately
 *                  thin so only event-bus.ts changes when you switch.
 */
export const EVENTS = {
  USER_REGISTERED: 'user.registered',
  USER_VERIFIED: 'user.verified',
  USER_PASSWORD_RESET: 'user.password_reset_requested',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',
  ENROLLMENT_CREATED: 'enrollment.created',
  LESSON_COMPLETED: 'progress.lesson_completed',
  COURSE_COMPLETED: 'progress.course_completed',
  QUIZ_PASSED: 'quiz.passed',
  CERTIFICATE_ISSUED: 'certificate.issued',
  LAB_SESSION_STARTED: 'lab.session_started',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface EventEnvelope<T = unknown> {
  /** Unique id of this message. Consumers use it for idempotency. */
  id: string;
  name: EventName;
  /** ISO-8601 */
  occurredAt: string;
  correlationId?: string;
  /** Service that produced the event. */
  source: string;
  version: 1;
  data: T;
}

export interface UserRegisteredEvent {
  userId: string;
  email: string;
  fullName: string;
}

export interface PaymentCompletedEvent {
  paymentId: string;
  orderId: string;
  userId: string;
  courseId: string;
  amountMinor: number;
  currency: string;
  razorpayPaymentId: string;
}

export interface PaymentFailedEvent {
  orderId: string;
  userId: string;
  courseId: string;
  reason: string;
}

export interface EnrollmentCreatedEvent {
  enrollmentId: string;
  userId: string;
  courseId: string;
  source: 'PAYMENT' | 'ADMIN' | 'FREE';
}

export interface LessonCompletedEvent {
  userId: string;
  courseId: string;
  lessonId: string;
  completedAt: string;
}

export interface CourseCompletedEvent {
  userId: string;
  courseId: string;
  completedAt: string;
}

export interface QuizPassedEvent {
  userId: string;
  courseId: string;
  lessonId: string | null;
  quizId: string;
  attemptId: string;
  scorePercent: number;
}

export interface CertificateIssuedEvent {
  certificateId: string;
  userId: string;
  courseId: string;
  serial: string;
  issuedAt: string;
}
