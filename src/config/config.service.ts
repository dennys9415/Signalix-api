import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfigService {
  private require(key: string, fallback?: string): string {
    const value = process.env[key] ?? fallback;
    if (value === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }

  get port(): number {
    return parseInt(this.require('PORT', '3000'), 10);
  }

  get nodeEnv(): string {
    return this.require('NODE_ENV', 'development');
  }

  get databaseUrl(): string {
    return this.require('DATABASE_URL');
  }

  get jwtSecret(): string {
    return this.require('JWT_SECRET');
  }

  get jwtAccessExpiresIn(): string {
    return this.require('JWT_ACCESS_EXPIRES_IN', '1h');
  }

  get jwtRefreshExpiresIn(): string {
    return this.require('JWT_REFRESH_EXPIRES_IN', '30d');
  }

  get frontendUrl(): string {
    return this.require('FRONTEND_URL', 'http://localhost:3000');
  }

  get googleClientId(): string {
    return this.require('GOOGLE_CLIENT_ID');
  }

  get googleClientSecret(): string {
    return this.require('GOOGLE_CLIENT_SECRET');
  }

  get googleCallbackUrl(): string {
    return this.require('GOOGLE_CALLBACK_URL', 'http://localhost:4000/api/v1/auth/google/callback');
  }

  get githubClientId(): string {
    return this.require('GITHUB_CLIENT_ID');
  }

  get githubClientSecret(): string {
    return this.require('GITHUB_CLIENT_SECRET');
  }

  get githubCallbackUrl(): string {
    return this.require('GITHUB_CALLBACK_URL', 'http://localhost:4000/api/v1/auth/github/callback');
  }

  get appleClientId(): string {
    return this.require('APPLE_CLIENT_ID');
  }

  get appleTeamId(): string {
    return this.require('APPLE_TEAM_ID');
  }

  get appleKeyId(): string {
    return this.require('APPLE_KEY_ID');
  }

  // The .p8 private key content. Store with literal \n for newlines in the env var.
  get applePrivateKey(): string {
    return this.require('APPLE_PRIVATE_KEY');
  }

  get appleCallbackUrl(): string {
    return this.require('APPLE_CALLBACK_URL');
  }

  // Empty-string fallback: EmailService skips sending and falls back to console.
  get resendApiKey(): string {
    return this.require('RESEND_API_KEY', '');
  }

  get emailFrom(): string {
    return this.require('EMAIL_FROM', 'Signalix <onboarding@resend.dev>');
  }

  get minioEndpoint(): string {
    return this.require('MINIO_ENDPOINT', 'http://minio:9000');
  }

  get minioPublicUrl(): string {
    return this.require('MINIO_PUBLIC_URL', 'http://localhost:9000');
  }

  get minioRegion(): string {
    return this.require('MINIO_REGION', 'us-east-1');
  }

  get minioAccessKey(): string {
    return this.require('MINIO_ACCESS_KEY', 'signalix');
  }

  get minioSecretKey(): string {
    return this.require('MINIO_SECRET_KEY', 'signalix_minio_password');
  }

  get minioAvatarsBucket(): string {
    return this.require('MINIO_BUCKET_AVATARS', 'signalix-avatars');
  }

  get minioMediaBucket(): string {
    return this.require('MINIO_BUCKET_MEDIA', 'signalix-media');
  }

  get minioFilesBucket(): string {
    return this.require('MINIO_BUCKET_FILES', 'signalix-files');
  }

  // VAPID — Web Push keys. Generated once via `npx web-push generate-vapid-keys`.
  // Empty fallback lets the app boot without push configured; PushService will
  // log and become a no-op rather than crash. Subject must be a mailto: or URL.
  get vapidPublicKey(): string {
    return this.require('VAPID_PUBLIC_KEY', '');
  }

  get vapidPrivateKey(): string {
    return this.require('VAPID_PRIVATE_KEY', '');
  }

  get vapidSubject(): string {
    return this.require('VAPID_SUBJECT', 'mailto:admin@signalix.local');
  }
}
