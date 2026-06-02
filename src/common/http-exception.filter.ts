import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ErrorCode, type ApiResponse } from '@signalix/contracts';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();

      let code = this.statusToCode(status);
      let message = 'An error occurred.';

      if (typeof raw === 'string') {
        message = raw;
      } else if (typeof raw === 'object' && raw !== null) {
        const r = raw as Record<string, unknown>;

        if (typeof r['code'] === 'string') {
          code = r['code'] as ErrorCode;
        }

        if (typeof r['message'] === 'string') {
          message = r['message'];
        } else if (Array.isArray(r['message'])) {
          code = ErrorCode.VALIDATION_ERROR;
          message = (r['message'] as string[]).join('; ');
        }
      }

      const body: ApiResponse<never> = { success: false, error: { code, message } };
      response.status(status).json(body);
    } else {
      this.logger.error('Unhandled exception', exception);
      const body: ApiResponse<never> = {
        success: false,
        error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred.' },
      };
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
    }
  }

  private statusToCode(status: number): ErrorCode {
    switch (status) {
      case 400: return ErrorCode.VALIDATION_ERROR;
      case 401: return ErrorCode.UNAUTHORIZED;
      case 403: return ErrorCode.FORBIDDEN;
      case 404: return ErrorCode.NOT_FOUND;
      case 409: return ErrorCode.CONFLICT;
      case 429: return ErrorCode.RATE_LIMITED;
      default:  return ErrorCode.INTERNAL_ERROR;
    }
  }
}
