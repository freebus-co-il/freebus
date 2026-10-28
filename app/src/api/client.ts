import { API_BASE_URL } from '@/config/env';

import type { ApiErrorBody } from './types';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.statusCode = body.statusCode;
    this.code = body.code;
    this.requestId = body.requestId;
    this.details = body.details;
  }
}

function buildQueryString(params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const url = `${API_BASE_URL}${path}${buildQueryString(params)}`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (body) throw new ApiError(body);
    throw new ApiError({
      statusCode: response.status,
      code: 'unknown_error',
      message: `Request to ${path} failed with status ${response.status}`,
    });
  }

  return (await response.json()) as T;
}
