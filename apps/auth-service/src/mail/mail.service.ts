import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Dev: MailHog on localhost:1025 - open http://localhost:8025 to read mail.
 * Prod: Amazon SES SMTP endpoint, credentials from Secrets Manager. Long term
 * this moves behind notification-service via the notification.* events.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('SMTP_HOST') ?? 'localhost',
      port: Number(this.config.get('SMTP_PORT') ?? 1025),
      secure: false,
      ignoreTLS: true,
      auth: this.config.get<string>('SMTP_USER')
        ? {
            user: this.config.get<string>('SMTP_USER'),
            pass: this.config.get<string>('SMTP_PASS'),
          }
        : undefined,
    });
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.config.get<string>('MAIL_FROM') ?? 'no-reply@devopsacademy.local',
        to,
        subject,
        html,
      });
      this.logger.log(`sent "${subject}" to ${maskEmail(to)}`);
    } catch (err) {
      // Never fail the request because mail is down; the user can re-request.
      this.logger.error(`mail send failed to ${maskEmail(to)}: ${(err as Error).message}`);
    }
  }

  sendVerificationEmail(to: string, name: string, link: string) {
    return this.send(
      to,
      'Confirm your email address',
      layout(
        `Hi ${escapeHtml(name)},`,
        'Confirm your email to finish setting up your DevOps Academy account.',
        link,
        'Confirm email',
        'This link works for 24 hours.',
      ),
    );
  }

  sendPasswordResetEmail(to: string, name: string, link: string) {
    return this.send(
      to,
      'Reset your password',
      layout(
        `Hi ${escapeHtml(name)},`,
        'Use the button below to choose a new password.',
        link,
        'Reset password',
        'This link works for 1 hour. If you did not ask for it, ignore this email.',
      ),
    );
  }
}

function layout(greeting: string, body: string, link: string, cta: string, footer: string): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:auto;color:#12181f">
    <h2 style="font-weight:600">DevOps Academy</h2>
    <p>${greeting}</p>
    <p>${body}</p>
    <p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${cta}</a></p>
    <p style="font-size:13px;color:#5b6572">${footer}</p>
    <p style="font-size:12px;color:#8a929c;word-break:break-all">${link}</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function maskEmail(email: string): string {
  const [u, d] = email.split('@');
  return `${u.slice(0, 2)}***@${d}`;
}
