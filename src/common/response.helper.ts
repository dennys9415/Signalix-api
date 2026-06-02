import type { ApiResponse, ApiError } from '@signalix/contracts';

export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

export function fail(error: ApiError): ApiResponse<never> {
  return { success: false, error };
}
