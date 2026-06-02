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
}
