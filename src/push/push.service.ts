import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import webpush from 'web-push';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';

export interface PushPayload {
  title: string;
  body: string;
  chatId: string;
  avatarUrl?: string | null;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private configured = false;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
  ) {}

  onModuleInit(): void {
    const pub = this.config.vapidPublicKey;
    const priv = this.config.vapidPrivateKey;
    if (!pub || !priv) {
      this.logger.warn(
        'VAPID keys not set — web push is disabled. Generate with `npx web-push generate-vapid-keys`.',
      );
      return;
    }
    webpush.setVapidDetails(this.config.vapidSubject, pub, priv);
    this.configured = true;
  }

  getPublicKey(): string {
    return this.config.vapidPublicKey;
  }

  async subscribe(
    userId: string,
    endpoint: string,
    p256dh: string,
    auth: string,
  ): Promise<void> {
    await this.db.query(
      `
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, endpoint) DO UPDATE
        SET p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            updated_at = NOW()
      `,
      [userId, endpoint, p256dh, auth],
    );
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.db.query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [userId, endpoint],
    );
  }

  /**
   * Dispatch a push to every device subscribed for `userId`.
   * Fire-and-forget — never throws to the caller. Subscriptions returning
   * 404/410 are pruned automatically.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!this.configured) return;

    const result = await this.db.query<SubscriptionRow>(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
      [userId],
    );

    if (result.rows.length === 0) return;

    const body = JSON.stringify(payload);

    await Promise.all(
      result.rows.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: 60 * 60 * 24 },
          );
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // Gone — delete the stale subscription.
            await this.db
              .query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id])
              .catch(() => {});
            this.logger.log(`Pruned stale push subscription ${sub.id}`);
          } else {
            this.logger.warn(
              `Push send failed for subscription ${sub.id}: ${(err as Error).message ?? status}`,
            );
          }
        }
      }),
    );
  }
}
