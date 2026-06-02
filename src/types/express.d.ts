import type { JwtPayload } from '../auth/guards/jwt-auth.guard';

declare module 'express' {
  interface Request {
    user?: JwtPayload;
  }
}
