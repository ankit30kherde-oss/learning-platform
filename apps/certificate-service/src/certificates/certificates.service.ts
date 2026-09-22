import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CertificateStatus } from '@prisma/client';
import {
  EVENTS,
  EventBus,
  HEADER_INTERNAL_KEY,
  type CourseCompletedEvent,
  type EventEnvelope,
} from '@lp/shared';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class CertificatesService implements OnModuleInit {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Certificates are issued by an event, not by a button. The student finishing
   * the last lesson is the fact; the certificate is a consequence of it.
   */
  async onModuleInit() {
    await this.bus
      .subscribe([EVENTS.COURSE_COMPLETED], async (evt: EventEnvelope<CourseCompletedEvent>) => {
        await this.issue(evt.data.userId, evt.data.courseId, evt.correlationId).catch((err) =>
          this.logger.error(`auto-issue failed for ${evt.data.userId}: ${err.message}`),
        );
      })
      .catch((err) => this.logger.warn(`event subscribe failed: ${err.message}`));
  }

  // ------------------------------------------------------------------ issue

  async issue(userId: string, courseId: string, correlationId?: string) {
    // Idempotent by (userId, courseId): a replayed event must not mint a second
    // serial for the same achievement.
    const existing = await this.prisma.certificate.findUnique({
      where: { userId_courseId: { userId, courseId } },
    });
    if (existing) return this.present(existing);

    const progress = await this.fetchProgress(userId, courseId);
    if (progress.percent < 100) {
      throw new BadRequestException('Finish every lesson before claiming a certificate.');
    }

    const [user, course] = await Promise.all([
      this.fetchUser(userId),
      this.fetchCourse(courseId),
    ]);

    const serial = this.newSerial();
    const issuedAt = new Date();

    const certificate = await this.prisma.certificate.create({
      data: {
        serial,
        userId,
        courseId,
        recipientName: user.fullName,
        recipientEmail: user.email,
        courseTitle: course.title,
        instructorName: course.instructorName ?? 'DevOps Academy',
        hoursTotal: Math.round((course.durationMinutes ?? 0) / 60),
        issuedAt,
        signature: this.sign(serial, userId, courseId, issuedAt),
      },
    });

    await this.bus
      .publish(
        EVENTS.CERTIFICATE_ISSUED,
        {
          certificateId: certificate.id,
          userId,
          courseId,
          serial,
          issuedAt: issuedAt.toISOString(),
        },
        correlationId,
      )
      .catch(() => undefined);

    this.logger.log(`issued certificate ${serial} to ${userId}`);
    return this.present(certificate);
  }

  async listMine(userId: string) {
    const rows = await this.prisma.certificate.findMany({
      where: { userId },
      orderBy: { issuedAt: 'desc' },
    });
    return rows.map((r) => this.present(r));
  }

  // ----------------------------------------------------------------- verify

  /**
   * Public. No auth, deliberately: an employer checking a serial has no
   * account. It returns only what a certificate already displays, never the
   * email address or the user id.
   */
  async verify(serial: string, ip?: string, userAgent?: string) {
    const cert = await this.prisma.certificate.findUnique({
      where: { serial: serial.toUpperCase().trim() },
    });
    if (!cert) return { valid: false, reason: 'No certificate with that serial.' };

    await this.prisma.certificateVerification
      .create({
        data: {
          certificateId: cert.id,
          ipAddress: ip?.slice(0, 64),
          userAgent: userAgent?.slice(0, 400),
        },
      })
      .catch(() => undefined);

    if (cert.status === CertificateStatus.REVOKED) {
      return { valid: false, reason: 'This certificate was revoked.', revokedAt: cert.revokedAt };
    }

    const expected = this.sign(cert.serial, cert.userId, cert.courseId, cert.issuedAt);
    if (!safeEqual(expected, cert.signature)) {
      // A mismatch means the row was edited outside the application. Loud.
      this.logger.error(`signature mismatch on certificate ${cert.serial}`);
      return { valid: false, reason: 'Signature mismatch.' };
    }

    return {
      valid: true,
      serial: cert.serial,
      recipientName: cert.recipientName,
      courseTitle: cert.courseTitle,
      instructorName: cert.instructorName,
      hoursTotal: cert.hoursTotal,
      issuedAt: cert.issuedAt,
    };
  }

  async revoke(serial: string, reason: string) {
    const cert = await this.prisma.certificate.findUnique({ where: { serial } });
    if (!cert) throw new NotFoundException('Certificate not found.');
    return this.prisma.certificate.update({
      where: { serial },
      data: { status: CertificateStatus.REVOKED, revokedAt: new Date(), revokeReason: reason },
    });
  }

  // ---------------------------------------------------------------- render

  /**
   * Printable HTML rather than a generated PDF binary. Browsers print to PDF
   * perfectly well, and this avoids shipping a headless Chromium into every
   * container image for one feature.
   */
  async renderHtml(serial: string, requesterId?: string): Promise<string> {
    const cert = await this.prisma.certificate.findUnique({ where: { serial } });
    if (!cert) throw new NotFoundException('Certificate not found.');
    if (requesterId && cert.userId !== requesterId) throw new ForbiddenException('Not your certificate.');

    const verifyUrl = `${this.config.get('APP_PUBLIC_URL') ?? 'http://localhost:3000'}/verify/${cert.serial}`;
    const issued = cert.issuedAt.toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Certificate ${escapeHtml(cert.serial)}</title>
<style>
  @page { size: A4 landscape; margin: 0; }
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; color:#14202b;
         background:#f5f7f6; display:grid; place-items:center; min-height:100vh; }
  .sheet { width:1060px; height:740px; background:#fff; border:1px solid #dfe4e2;
           padding:64px 72px; position:relative; }
  .rule { height:4px; width:96px; background:#0f766e; }
  h1 { font-size:14px; letter-spacing:.18em; text-transform:uppercase; color:#3c4a57; margin:28px 0 0; }
  .name { font-size:52px; margin:18px 0 6px; letter-spacing:-.02em; }
  .course { font-size:26px; color:#0b5c55; margin:22px 0 0; }
  .meta { margin-top:44px; display:flex; gap:64px; font-size:13px; color:#3c4a57; }
  .serial { font-family: ui-monospace, Menlo, monospace; }
  footer { position:absolute; bottom:56px; left:72px; right:72px; display:flex;
           justify-content:space-between; align-items:end; font-size:12px; color:#3c4a57; }
  @media print { body { background:#fff; } .sheet { border:none; } }
</style></head>
<body><div class="sheet">
  <div class="rule"></div>
  <h1>Certificate of completion</h1>
  <p style="margin:34px 0 0;font-size:13px;color:#3c4a57">This certifies that</p>
  <div class="name">${escapeHtml(cert.recipientName)}</div>
  <p style="margin:0;font-size:13px;color:#3c4a57">has completed</p>
  <div class="course">${escapeHtml(cert.courseTitle)}</div>
  <div class="meta">
    <div><strong>Issued</strong><br>${issued}</div>
    <div><strong>Duration</strong><br>${cert.hoursTotal} hours</div>
    <div><strong>Instructor</strong><br>${escapeHtml(cert.instructorName)}</div>
  </div>
  <footer>
    <div>Verify at <strong>${escapeHtml(verifyUrl)}</strong></div>
    <div class="serial">${escapeHtml(cert.serial)}</div>
  </footer>
</div></body></html>`;
  }

  // ---------------------------------------------------------------- helpers

  private present(cert: {
    id: string;
    serial: string;
    courseId: string;
    courseTitle: string;
    recipientName: string;
    issuedAt: Date;
    status: CertificateStatus;
    hoursTotal: number;
  }) {
    const base = this.config.get('APP_PUBLIC_URL') ?? 'http://localhost:3000';
    return {
      id: cert.id,
      serial: cert.serial,
      courseId: cert.courseId,
      courseTitle: cert.courseTitle,
      recipientName: cert.recipientName,
      hoursTotal: cert.hoursTotal,
      issuedAt: cert.issuedAt,
      status: cert.status,
      verifyUrl: `${base}/verify/${cert.serial}`,
      printUrl: `/api/certificates/${cert.serial}/print`,
    };
  }

  /** Readable, unambiguous, and not sequential - serials must not be guessable. */
  private newSerial(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
    const bytes = randomBytes(12);
    const body = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    return `DA-${new Date().getFullYear()}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
  }

  private sign(serial: string, userId: string, courseId: string, issuedAt: Date): string {
    const secret = this.config.getOrThrow<string>('CERTIFICATE_SIGNING_SECRET');
    return createHmac('sha256', secret)
      .update(`${serial}|${userId}|${courseId}|${issuedAt.toISOString()}`)
      .digest('hex');
  }

  private internal() {
    return { [HEADER_INTERNAL_KEY]: this.config.getOrThrow<string>('INTERNAL_API_KEY') };
  }

  private async fetchProgress(userId: string, courseId: string) {
    const url = `${this.config.getOrThrow('ENROLLMENT_SERVICE_URL')}/internal/enrollments/check`;
    const { data } = await axios.get(url, {
      params: { userId, courseId, withProgress: true },
      headers: this.internal(),
      timeout: 4000,
    });
    if (!data?.entitled) throw new ForbiddenException('You are not enrolled in this course.');
    return { percent: data.progressPercent ?? 0 };
  }

  private async fetchUser(userId: string) {
    const url = `${this.config.getOrThrow('AUTH_SERVICE_URL')}/internal/users/${userId}`;
    const { data } = await axios.get(url, { headers: this.internal(), timeout: 4000 });
    return data as { fullName: string; email: string };
  }

  private async fetchCourse(courseId: string) {
    const url = `${this.config.getOrThrow('COURSE_SERVICE_URL')}/internal/courses/${courseId}/summary`;
    const { data } = await axios.get(url, { headers: this.internal(), timeout: 4000 });
    return data as { title: string; instructorName?: string; durationMinutes?: number };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
