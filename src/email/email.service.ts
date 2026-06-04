import { Injectable } from '@nestjs/common';
import { Resend } from 'resend';
import { ConfigService } from '../config/config.service';

@Injectable()
export class EmailService {
  private readonly resend: Resend | null;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.resendApiKey;
    // Skip initialising the client when no key is configured (local dev without Resend).
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  async sendEmailVerification(to: string, verificationUrl: string): Promise<void> {
    const subject = 'Verify your Signalix email';
    const html = buildEmailVerificationHtml(verificationUrl);

    if (!this.resend) {
      console.log(`[Email – no RESEND_API_KEY] Verification link for ${to}: ${verificationUrl}`);
      return;
    }

    const { error } = await this.resend.emails.send({
      from: this.config.emailFrom,
      to,
      subject,
      html,
    });

    if (error) {
      console.error('[Email] Resend delivery failed:', error);
      if (this.config.nodeEnv !== 'production') {
        console.log(`[Email – fallback] Verification link for ${to}: ${verificationUrl}`);
      }
    }
  }

  async sendPasswordReset(to: string, resetUrl: string): Promise<void> {
    const subject = 'Reset your Signalix password';
    const html = buildPasswordResetHtml(resetUrl);

    if (!this.resend) {
      // No API key — fall back to console so local dev can still test the flow.
      console.log(`[Email – no RESEND_API_KEY] Password reset link for ${to}: ${resetUrl}`);
      return;
    }

    const { error } = await this.resend.emails.send({
      from: this.config.emailFrom,
      to,
      subject,
      html,
    });

    if (error) {
      // Log the failure server-side; also print the URL so dev/staging can keep testing.
      console.error('[Email] Resend delivery failed:', error);
      if (this.config.nodeEnv !== 'production') {
        console.log(`[Email – fallback] Password reset link for ${to}: ${resetUrl}`);
      }
    }
  }
}

function buildEmailVerificationHtml(verificationUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify your Signalix email</title>
</head>
<body style="margin:0;padding:32px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" role="presentation"
               style="background:#ffffff;border-radius:8px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
          <tr>
            <td>
              <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#111827;">Signalix</p>
              <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#111827;">
                Verify your email address
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6;">
                Thanks for signing up! Click the button below to verify your email address
                and activate your Signalix account.
                This link expires in <strong>24 hours</strong>.
              </p>
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="border-radius:6px;background:#4f46e5;">
                    <a href="${verificationUrl}"
                       style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">
                      Verify Email
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">
                If you didn't create a Signalix account, you can safely ignore this email.
              </p>
              <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;" />
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                This link will expire 24 hours after it was generated.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildPasswordResetHtml(resetUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your Signalix password</title>
</head>
<body style="margin:0;padding:32px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" role="presentation"
               style="background:#ffffff;border-radius:8px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,.08);">
          <tr>
            <td>
              <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#111827;">Signalix</p>
              <h1 style="margin:0 0 20px;font-size:22px;font-weight:700;color:#111827;">
                Reset your password
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6;">
                Someone requested a password reset for your Signalix account.
                Click the button below to choose a new password.
                This link expires in <strong>15 minutes</strong>.
              </p>
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="border-radius:6px;background:#4f46e5;">
                    <a href="${resetUrl}"
                       style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">
                If you didn't request a password reset, you can safely ignore this email.
                Your password won't change until you click the link above and create a new one.
              </p>
              <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;" />
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                This link will expire 15 minutes after it was generated.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
