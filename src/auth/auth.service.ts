import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import type { PoolClient } from 'pg';
import type { AuthSessionDTO, ForgotPasswordResponse } from '@signalix/contracts';
import { ErrorCode, MAX_ACTIVE_DEVICES_PER_USER } from '@signalix/contracts';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { EmailService } from '../email/email.service';
import type { RegisterDto } from './dto/register.dto';
import type { LoginDto } from './dto/login.dto';

interface UserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string;
  expires_at: Date;
}

interface CreateSessionOpts {
  deviceId?: string;   // if set, reuse existing device instead of inserting new one
  deviceName?: string;
  ip?: string;
  userAgent?: string;
}

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  error?: string;
}

interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
}

interface GitHubProfile {
  id: number;
  login: string;
  name?: string;
  avatar_url?: string;
  email?: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
}

interface AppleTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  id_token: string;
  error?: string;
  error_description?: string;
}

interface AppleIdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {}

  async register(dto: RegisterDto, ip?: string): Promise<AuthSessionDTO> {
    const passwordHash = await bcrypt.hash(dto.password, 12);
    let registeredUserId = '';

    const session = await this.db.transaction(async (client) => {
      let userId: string;

      try {
        const result = await client.query<{ id: string }>(`
          INSERT INTO users (email, username, password_hash, display_name)
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `, [
          dto.email.toLowerCase(),
          dto.username.toLowerCase(),
          passwordHash,
          dto.displayName ?? dto.username,
        ]);
        userId = result.rows[0].id;
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          const detail = (err as { detail?: string }).detail ?? '';
          if (detail.includes('username')) {
            throw new ConflictException({
              code: ErrorCode.USERNAME_TAKEN,
              message: 'Username is already taken.',
            });
          }
          throw new ConflictException({
            code: ErrorCode.CONFLICT,
            message: 'Email is already registered.',
          });
        }
        throw err;
      }

      await client.query(`
        INSERT INTO auth_providers (user_id, provider, provider_user_id)
        VALUES ($1, 'local', $2)
      `, [userId, userId]);

      registeredUserId = userId;
      return this.createDeviceSession(client, userId, {
        deviceName: dto.deviceName,
        ip,
        userAgent: dto.userAgent,
      });
    });

    // Send verification email outside the transaction; a failed email must not roll back registration.
    void this.sendVerificationEmail(registeredUserId, dto.email.toLowerCase()).catch((err) =>
      console.error('[Auth] Failed to send verification email:', err),
    );

    return session;
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = hashToken(token);

    const tokenResult = await this.db.query<{ id: string; user_id: string }>(
      `SELECT id, user_id
       FROM email_verification_tokens
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash],
    );

    const tokenRow = tokenResult.rows[0];
    if (!tokenRow) {
      throw new BadRequestException({
        code: ErrorCode.INVALID_VERIFICATION_TOKEN,
        message: 'Invalid or expired verification link.',
      });
    }

    await this.db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET is_verified = true, updated_at = NOW() WHERE id = $1',
        [tokenRow.user_id],
      );
      await client.query(
        'UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1',
        [tokenRow.id],
      );
    });
  }

  async resendVerification(email: string): Promise<void> {
    const userResult = await this.db.query<{ id: string; is_verified: boolean }>(
      'SELECT id, is_verified FROM users WHERE email = $1 LIMIT 1',
      [email.toLowerCase()],
    );

    const user = userResult.rows[0];

    // Always return without error — prevents email enumeration.
    if (!user || user.is_verified) return;

    void this.sendVerificationEmail(user.id, email.toLowerCase()).catch((err) =>
      console.error('[Auth] Failed to resend verification email:', err),
    );
  }

  async login(dto: LoginDto, ip?: string): Promise<AuthSessionDTO> {
    const identifier = dto.identifier.toLowerCase();

    const userResult = await this.db.query<UserRow>(`
      SELECT id, email, username, password_hash
      FROM users
      WHERE email = $1 OR username = $1
      LIMIT 1
    `, [identifier]);

    const user = userResult.rows[0];

    if (!user?.password_hash) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid credentials.',
      });
    }

    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid credentials.',
      });
    }

    return this.db.transaction(async (client) => {
      // If the client sends a user_agent, look for an existing active session from
      // the same browser. If found, revoke it and reuse the device so that repeated
      // logins from the same browser do not consume additional device slots.
      let reuseDeviceId: string | undefined;

      if (dto.userAgent) {
        const existing = await client.query<{ id: string; device_id: string }>(`
          SELECT id, device_id
          FROM device_sessions
          WHERE user_id    = $1
            AND user_agent = $2
            AND revoked    = false
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
        `, [user.id, dto.userAgent]);

        if (existing.rows[0]) {
          await client.query(
            'UPDATE device_sessions SET revoked = true, updated_at = NOW() WHERE id = $1',
            [existing.rows[0].id],
          );
          reuseDeviceId = existing.rows[0].device_id;
        }
      }

      // Only enforce the device cap when we are not reusing an existing slot.
      if (!reuseDeviceId) {
        const countResult = await client.query<{ count: string }>(`
          SELECT COUNT(*) AS count
          FROM device_sessions
          WHERE user_id = $1 AND revoked = false AND expires_at > NOW()
        `, [user.id]);

        if (parseInt(countResult.rows[0].count, 10) >= MAX_ACTIVE_DEVICES_PER_USER) {
          throw new ForbiddenException({
            code: ErrorCode.DEVICE_LIMIT_REACHED,
            message: 'Maximum active device limit reached.',
          });
        }
      }

      return this.createDeviceSession(client, user.id, {
        deviceId: reuseDeviceId,
        deviceName: dto.deviceName,
        ip,
        userAgent: dto.userAgent,
      });
    });
  }

  async refresh(refreshToken: string): Promise<AuthSessionDTO> {
    const tokenHash = hashToken(refreshToken);

    const sessionResult = await this.db.query<SessionRow>(`
      SELECT id, user_id, device_id, expires_at
      FROM device_sessions
      WHERE refresh_token_hash = $1
        AND revoked = false
        AND expires_at > NOW()
    `, [tokenHash]);

    const session = sessionResult.rows[0];
    if (!session) {
      throw new UnauthorizedException({
        code: ErrorCode.SESSION_REVOKED,
        message: 'Invalid or expired refresh token.',
      });
    }

    await this.db.query(`
      UPDATE device_sessions
      SET last_seen = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [session.id]);

    const { accessToken, accessTokenExpiresAt } = this.buildAccessToken(
      session.user_id,
      session.device_id,
    );

    return {
      userId: session.user_id,
      deviceId: session.device_id,
      accessToken,
      refreshToken,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: session.expires_at.toISOString(),
    };
  }

  async forgotPassword(email: string): Promise<ForgotPasswordResponse> {
    const result = await this.db.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [email.toLowerCase()],
    );

    // Always return the same message to prevent email enumeration.
    const message = 'If an account with that email exists, a reset link has been sent.';

    if (!result.rows[0]) {
      return { message };
    }

    const userId = result.rows[0].id;
    const tokenRaw = randomBytes(32).toString('hex');
    const tokenHash = hashToken(tokenRaw);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // One active reset token per user — delete any existing ones.
    await this.db.query(
      'DELETE FROM password_reset_tokens WHERE user_id = $1',
      [userId],
    );

    await this.db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );

    const resetUrl = `${this.config.frontendUrl}/reset-password?token=${tokenRaw}`;
    await this.email.sendPasswordReset(email.toLowerCase(), resetUrl);

    return { message };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(token);

    const tokenResult = await this.db.query<{ id: string; user_id: string }>(
      `SELECT id, user_id
       FROM password_reset_tokens
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash],
    );

    const tokenRow = tokenResult.rows[0];
    if (!tokenRow) {
      throw new BadRequestException({
        code: ErrorCode.INVALID_RESET_TOKEN,
        message: 'Invalid or expired reset token.',
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await this.db.transaction(async (client) => {
      await client.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [passwordHash, tokenRow.user_id],
      );

      // One-time use — mark the token consumed.
      await client.query(
        'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
        [tokenRow.id],
      );

      // Revoke all active sessions so every device must re-authenticate.
      await client.query(
        'UPDATE device_sessions SET revoked = true, updated_at = NOW() WHERE user_id = $1',
        [tokenRow.user_id],
      );
    });
  }

  getGoogleAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: this.config.googleClientId,
      redirect_uri: this.config.googleCallbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async loginWithGoogle(
    code: string,
    userAgent?: string,
    ip?: string,
  ): Promise<AuthSessionDTO> {
    const tokens = await this.exchangeGoogleCode(code);
    const profile = await this.getGoogleUserInfo(tokens.access_token);

    if (!profile.email || !profile.sub) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'Google profile missing required fields.',
      });
    }

    const email = profile.email.toLowerCase();

    return this.db.transaction(async (client) => {
      // 1. Check if this Google account is already linked.
      const byProvider = await client.query<{ user_id: string }>(`
        SELECT user_id FROM auth_providers
        WHERE provider = 'google' AND provider_user_id = $1
      `, [profile.sub]);

      let userId: string;

      if (byProvider.rows[0]) {
        userId = byProvider.rows[0].user_id;
      } else {
        // 2. Check if the email belongs to an existing local user — link if so.
        const byEmail = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE email = $1 LIMIT 1',
          [email],
        );

        if (byEmail.rows[0]) {
          userId = byEmail.rows[0].id;
          await client.query(`
            INSERT INTO auth_providers (user_id, provider, provider_user_id, provider_email)
            VALUES ($1, 'google', $2, $3)
          `, [userId, profile.sub, email]);
          // Google verifies email ownership — mark the local account as verified.
          await client.query(
            'UPDATE users SET is_verified = true, updated_at = NOW() WHERE id = $1 AND is_verified = false',
            [userId],
          );
        } else {
          // 3. Brand-new user — create from Google profile.
          const username = await this.generateUniqueUsername(
            client,
            email.split('@')[0],
          );

          const inserted = await client.query<{ id: string }>(`
            INSERT INTO users (email, username, display_name, avatar_url, is_verified)
            VALUES ($1, $2, $3, $4, true)
            RETURNING id
          `, [
            email,
            username,
            profile.name ?? username,
            profile.picture ?? null,
          ]);

          userId = inserted.rows[0].id;

          await client.query(`
            INSERT INTO auth_providers (user_id, provider, provider_user_id, provider_email)
            VALUES ($1, 'google', $2, $3)
          `, [userId, profile.sub, email]);
        }
      }

      // Reuse existing browser device slot if available (same logic as local login).
      let reuseDeviceId: string | undefined;

      if (userAgent) {
        const existing = await client.query<{ id: string; device_id: string }>(`
          SELECT id, device_id
          FROM device_sessions
          WHERE user_id    = $1
            AND user_agent = $2
            AND revoked    = false
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
        `, [userId, userAgent]);

        if (existing.rows[0]) {
          await client.query(
            'UPDATE device_sessions SET revoked = true, updated_at = NOW() WHERE id = $1',
            [existing.rows[0].id],
          );
          reuseDeviceId = existing.rows[0].device_id;
        }
      }

      if (!reuseDeviceId) {
        const countResult = await client.query<{ count: string }>(`
          SELECT COUNT(*) AS count
          FROM device_sessions
          WHERE user_id = $1 AND revoked = false AND expires_at > NOW()
        `, [userId]);

        if (parseInt(countResult.rows[0].count, 10) >= MAX_ACTIVE_DEVICES_PER_USER) {
          throw new ForbiddenException({
            code: ErrorCode.DEVICE_LIMIT_REACHED,
            message: 'Maximum active device limit reached.',
          });
        }
      }

      return this.createDeviceSession(client, userId, {
        deviceId: reuseDeviceId,
        ip,
        userAgent,
      });
    });
  }

  getGitHubAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: this.config.githubClientId,
      redirect_uri: this.config.githubCallbackUrl,
      scope: 'read:user user:email',
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async loginWithGitHub(
    code: string,
    userAgent?: string,
    ip?: string,
  ): Promise<AuthSessionDTO> {
    const tokens = await this.exchangeGitHubCode(code);
    const profile = await this.getGitHubUserInfo(tokens.access_token);

    // GitHub users may have a null public email — fall back to fetching the primary verified one.
    let email: string | null = profile.email ?? null;
    if (!email) {
      email = await this.getGitHubPrimaryEmail(tokens.access_token);
    }

    if (!email) {
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHORIZED,
        message: 'GitHub account has no verified email address.',
      });
    }

    email = email.toLowerCase();
    const providerUserId = String(profile.id);

    return this.db.transaction(async (client) => {
      // 1. Check if this GitHub account is already linked.
      const byProvider = await client.query<{ user_id: string }>(`
        SELECT user_id FROM auth_providers
        WHERE provider = 'github' AND provider_user_id = $1
      `, [providerUserId]);

      let userId: string;

      if (byProvider.rows[0]) {
        userId = byProvider.rows[0].user_id;
      } else {
        // 2. Check if the email belongs to an existing local user — link if so.
        const byEmail = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE email = $1 LIMIT 1',
          [email],
        );

        if (byEmail.rows[0]) {
          userId = byEmail.rows[0].id;
          await client.query(`
            INSERT INTO auth_providers (user_id, provider, provider_user_id, provider_email)
            VALUES ($1, 'github', $2, $3)
          `, [userId, providerUserId, email]);
          // GitHub guarantees a verified email — mark the local account as verified.
          await client.query(
            'UPDATE users SET is_verified = true, updated_at = NOW() WHERE id = $1 AND is_verified = false',
            [userId],
          );
        } else {
          // 3. Brand-new user — create from GitHub profile.
          const username = await this.generateUniqueUsername(
            client,
            profile.login,
          );

          const inserted = await client.query<{ id: string }>(`
            INSERT INTO users (email, username, display_name, avatar_url, is_verified)
            VALUES ($1, $2, $3, $4, true)
            RETURNING id
          `, [
            email,
            username,
            profile.name ?? username,
            profile.avatar_url ?? null,
          ]);

          userId = inserted.rows[0].id;

          await client.query(`
            INSERT INTO auth_providers (user_id, provider, provider_user_id, provider_email)
            VALUES ($1, 'github', $2, $3)
          `, [userId, providerUserId, email]);
        }
      }

      // Reuse existing browser device slot if available (same logic as local login).
      let reuseDeviceId: string | undefined;

      if (userAgent) {
        const existing = await client.query<{ id: string; device_id: string }>(`
          SELECT id, device_id
          FROM device_sessions
          WHERE user_id    = $1
            AND user_agent = $2
            AND revoked    = false
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
        `, [userId, userAgent]);

        if (existing.rows[0]) {
          await client.query(
            'UPDATE device_sessions SET revoked = true, updated_at = NOW() WHERE id = $1',
            [existing.rows[0].id],
          );
          reuseDeviceId = existing.rows[0].device_id;
        }
      }

      if (!reuseDeviceId) {
        const countResult = await client.query<{ count: string }>(`
          SELECT COUNT(*) AS count
          FROM device_sessions
          WHERE user_id = $1 AND revoked = false AND expires_at > NOW()
        `, [userId]);

        if (parseInt(countResult.rows[0].count, 10) >= MAX_ACTIVE_DEVICES_PER_USER) {
          throw new ForbiddenException({
            code: ErrorCode.DEVICE_LIMIT_REACHED,
            message: 'Maximum active device limit reached.',
          });
        }
      }

      return this.createDeviceSession(client, userId, {
        deviceId: reuseDeviceId,
        ip,
        userAgent,
      });
    });
  }

  getAppleAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: this.config.appleClientId,
      redirect_uri: this.config.appleCallbackUrl,
      response_type: 'code',
      response_mode: 'form_post',
      scope: 'name email',
    });
    return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
  }

  async loginWithApple(
    code: string,
    userJson?: string,
    userAgent?: string,
    ip?: string,
  ): Promise<AuthSessionDTO> {
    const clientSecret = this.buildAppleClientSecret();
    const tokens = await this.exchangeAppleCode(code, clientSecret);
    const claims = this.decodeAppleIdToken(tokens.id_token);

    const providerUserId = claims.sub;

    // Apple email: present in ID token claims (possibly a private relay address).
    // Falls back to the user JSON sent only on the very first authorization.
    let email = claims.email?.toLowerCase() ?? null;
    if (!email && userJson) {
      try {
        const parsed = JSON.parse(userJson) as { email?: string };
        if (parsed.email) email = parsed.email.toLowerCase();
      } catch {
        // non-fatal — user JSON parse failure is not a sign-in blocker
      }
    }

    return this.db.transaction(async (client) => {
      // 1. Check if this Apple account is already linked.
      const byProvider = await client.query<{ user_id: string }>(`
        SELECT user_id FROM auth_providers
        WHERE provider = 'apple' AND provider_user_id = $1
      `, [providerUserId]);

      let userId: string;

      if (byProvider.rows[0]) {
        userId = byProvider.rows[0].user_id;
      } else if (email) {
        // 2. Check if the email belongs to an existing user — link if so.
        const byEmail = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE email = $1 LIMIT 1',
          [email],
        );

        if (byEmail.rows[0]) {
          userId = byEmail.rows[0].id;
          await client.query(`
            INSERT INTO auth_providers (user_id, provider, provider_user_id, provider_email)
            VALUES ($1, 'apple', $2, $3)
          `, [userId, providerUserId, email]);
          // Apple IDs have verified emails — mark the local account as verified.
          await client.query(
            'UPDATE users SET is_verified = true, updated_at = NOW() WHERE id = $1 AND is_verified = false',
            [userId],
          );
        } else {
          // 3. Brand-new user — create from Apple data.
          userId = await this.createAppleUser(client, providerUserId, email, userJson);
        }
      } else {
        // Apple account with no accessible email — cannot create or link.
        throw new UnauthorizedException({
          code: ErrorCode.UNAUTHORIZED,
          message: 'Apple account has no accessible email address.',
        });
      }

      // Reuse existing browser device slot if available (same logic as local login).
      let reuseDeviceId: string | undefined;

      if (userAgent) {
        const existing = await client.query<{ id: string; device_id: string }>(`
          SELECT id, device_id
          FROM device_sessions
          WHERE user_id    = $1
            AND user_agent = $2
            AND revoked    = false
            AND expires_at > NOW()
          ORDER BY created_at DESC
          LIMIT 1
        `, [userId, userAgent]);

        if (existing.rows[0]) {
          await client.query(
            'UPDATE device_sessions SET revoked = true, updated_at = NOW() WHERE id = $1',
            [existing.rows[0].id],
          );
          reuseDeviceId = existing.rows[0].device_id;
        }
      }

      if (!reuseDeviceId) {
        const countResult = await client.query<{ count: string }>(`
          SELECT COUNT(*) AS count
          FROM device_sessions
          WHERE user_id = $1 AND revoked = false AND expires_at > NOW()
        `, [userId]);

        if (parseInt(countResult.rows[0].count, 10) >= MAX_ACTIVE_DEVICES_PER_USER) {
          throw new ForbiddenException({
            code: ErrorCode.DEVICE_LIMIT_REACHED,
            message: 'Maximum active device limit reached.',
          });
        }
      }

      return this.createDeviceSession(client, userId, {
        deviceId: reuseDeviceId,
        ip,
        userAgent,
      });
    });
  }

  private async exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        redirect_uri: this.config.googleCallbackUrl,
        grant_type: 'authorization_code',
      }).toString(),
    });

    const data = await res.json() as GoogleTokenResponse;

    if (!res.ok || data.error) {
      throw new Error(`Google token exchange failed: ${data.error ?? res.status}`);
    }

    return data;
  }

  private async getGoogleUserInfo(accessToken: string): Promise<GoogleProfile> {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch Google user info: ${res.status}`);
    }

    return res.json() as Promise<GoogleProfile>;
  }

  private async exchangeGitHubCode(code: string): Promise<GitHubTokenResponse> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        code,
        client_id: this.config.githubClientId,
        client_secret: this.config.githubClientSecret,
        redirect_uri: this.config.githubCallbackUrl,
      }).toString(),
    });

    const data = await res.json() as GitHubTokenResponse;

    if (!res.ok || data.error) {
      throw new Error(`GitHub token exchange failed: ${data.error ?? res.status}`);
    }

    return data;
  }

  private async getGitHubUserInfo(accessToken: string): Promise<GitHubProfile> {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch GitHub user info: ${res.status}`);
    }

    return res.json() as Promise<GitHubProfile>;
  }

  private async getGitHubPrimaryEmail(accessToken: string): Promise<string | null> {
    const res = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!res.ok) return null;

    const emails = await res.json() as GitHubEmail[];
    const primary = emails.find((e) => e.primary && e.verified);
    return primary?.email ?? null;
  }

  private async sendVerificationEmail(userId: string, email: string): Promise<void> {
    const tokenRaw = randomBytes(32).toString('hex');
    const tokenHash = hashToken(tokenRaw);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // One active token per user — delete any existing unused ones.
    await this.db.query(
      'DELETE FROM email_verification_tokens WHERE user_id = $1',
      [userId],
    );

    await this.db.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );

    const verificationUrl = `${this.config.frontendUrl}/verify-email?token=${tokenRaw}`;

    if (this.config.nodeEnv !== 'production') {
      console.log(`[Email Verification] ${verificationUrl}`);
    }

    await this.email.sendEmailVerification(email, verificationUrl);
  }

  private buildAppleClientSecret(): string {
    // Apple requires a short-lived JWT signed with ES256 as the OAuth client secret.
    // The private key is a PKCS#8 PEM (.p8); newlines may be stored as literal \n in env.
    const privateKey = this.config.applePrivateKey.replace(/\\n/g, '\n');

    return this.jwtService.sign({}, {
      algorithm: 'ES256',
      privateKey,
      keyid: this.config.appleKeyId,
      issuer: this.config.appleTeamId,
      audience: 'https://appleid.apple.com',
      subject: this.config.appleClientId,
      expiresIn: 300,
    } as Parameters<typeof this.jwtService.sign>[1]);
  }

  private async exchangeAppleCode(
    code: string,
    clientSecret: string,
  ): Promise<AppleTokenResponse> {
    const res = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.appleClientId,
        client_secret: clientSecret,
        redirect_uri: this.config.appleCallbackUrl,
        grant_type: 'authorization_code',
      }).toString(),
    });

    const data = await res.json() as AppleTokenResponse;

    if (!res.ok || data.error) {
      throw new Error(`Apple token exchange failed: ${data.error ?? res.status}`);
    }

    return data;
  }

  private decodeAppleIdToken(idToken: string): AppleIdTokenClaims {
    // The ID token is a JWT; we decode the payload without verifying the signature
    // since it was returned directly by Apple's token endpoint.
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid Apple ID token format.');
    }
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(payload) as AppleIdTokenClaims;
    if (!claims.sub) {
      throw new Error('Apple ID token missing sub claim.');
    }
    return claims;
  }

  private async createAppleUser(
    client: PoolClient,
    providerUserId: string,
    email: string,
    userJson?: string,
  ): Promise<string> {
    // Apple sends the user's name only on the very first authorization.
    let displayName: string | undefined;
    if (userJson) {
      try {
        const info = JSON.parse(userJson) as {
          name?: { firstName?: string; lastName?: string };
        };
        const { firstName, lastName } = info.name ?? {};
        if (firstName || lastName) {
          displayName = [firstName, lastName].filter(Boolean).join(' ');
        }
      } catch {
        // non-fatal
      }
    }

    const username = await this.generateUniqueUsername(client, email.split('@')[0]);

    const inserted = await client.query<{ id: string }>(`
      INSERT INTO users (email, username, display_name, is_verified)
      VALUES ($1, $2, $3, true)
      RETURNING id
    `, [email, username, displayName ?? username]);

    const userId = inserted.rows[0].id;

    await client.query(`
      INSERT INTO auth_providers (user_id, provider, provider_user_id, provider_email)
      VALUES ($1, 'apple', $2, $3)
    `, [userId, providerUserId, email]);

    return userId;
  }

  private async generateUniqueUsername(client: PoolClient, base: string): Promise<string> {
    // Sanitize: lowercase, keep only alphanumeric + underscore, enforce 3–50 char limits.
    const sanitized = base.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'user';
    const padded = sanitized.length >= 3 ? sanitized : sanitized.padEnd(3, '0');

    for (let i = 0; i < 50; i++) {
      const candidate = (i === 0 ? padded : `${padded}_${i}`).slice(0, 50);
      const { rows } = await client.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM users WHERE username = $1',
        [candidate],
      );
      if (parseInt(rows[0].count, 10) === 0) return candidate;
    }

    return `user_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  private async createDeviceSession(
    client: PoolClient,
    userId: string,
    opts: CreateSessionOpts,
  ): Promise<AuthSessionDTO> {
    const deviceId = opts.deviceId ?? randomUUID();
    const sessionId = randomUUID();
    const refreshTokenRaw = randomBytes(32).toString('hex');
    const refreshTokenHash = hashToken(refreshTokenRaw);
    const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    if (opts.deviceId) {
      // Reusing an existing device — just bump last_seen.
      await client.query(
        'UPDATE devices SET last_seen = NOW() WHERE id = $1',
        [deviceId],
      );
    } else {
      await client.query(`
        INSERT INTO devices (id, user_id, device_name, device_type, last_seen)
        VALUES ($1, $2, $3, 'web', NOW())
      `, [deviceId, userId, opts.deviceName ?? null]);
    }

    await client.query(`
      INSERT INTO device_sessions
        (id, user_id, device_id, refresh_token_hash, ip, user_agent, last_seen, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
    `, [sessionId, userId, deviceId, refreshTokenHash, opts.ip ?? null, opts.userAgent ?? null, refreshExpiresAt]);

    const { accessToken, accessTokenExpiresAt } = this.buildAccessToken(userId, deviceId);

    return {
      userId,
      deviceId,
      accessToken,
      refreshToken: refreshTokenRaw,
      accessTokenExpiresAt: accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  private buildAccessToken(
    userId: string,
    deviceId: string,
  ): { accessToken: string; accessTokenExpiresAt: Date } {
    const accessTokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const accessToken = this.jwtService.sign({ sub: userId, deviceId, type: 'access' });
    return { accessToken, accessTokenExpiresAt };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}
