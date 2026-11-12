import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SchemaObject } from '@nestjs/swagger';

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super({ code, message, ...(fields && { fields }) }, status);
  }
}

export interface ApiRequest {
  url: string;
  headers: { authorization?: string };
  socket: { remoteAddress?: string };
  requestId?: string;
}

export function requestId(request: ApiRequest) {
  return request.requestId ??= randomUUID();
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<ApiRequest>();
    const response = http.getResponse();
    if (!/^\/api\/v1(?:\/|\?|$)/.test(request.url) && error instanceof HttpException) {
      const status = error.getStatus();
      const body = error.getResponse();
      return response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
    }

    const id = requestId(request);
    const pgCode = (error as { code?: string } | null)?.code;
    let mapped: HttpException;
    if (error instanceof HttpException) mapped = error;
    else if (pgCode === '23505') mapped = new ApiError(409, 'DUPLICATE', 'A record with that key already exists.');
    else if (pgCode === '23503' || pgCode === '23514') mapped = new ApiError(400, 'INVALID_REFERENCE', 'Invalid value or reference.');
    else if (['40001', '40P01'].includes(pgCode ?? '')) mapped = new ApiError(409, 'CONCURRENT_UPDATE', 'Reload and retry the change.');
    else if (['EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', '57P01', '53300'].includes(pgCode ?? '') || pgCode?.startsWith('08')) {
      mapped = new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database unavailable.');
    } else {
      this.logger.error(`Request ${id} failed${pgCode && /^[A-Z0-9_]+$/.test(pgCode) ? ` (${pgCode})` : ''}.`);
      mapped = new ApiError(500, 'INTERNAL_ERROR', 'An internal error occurred.');
    }

    const status = mapped.getStatus();
    const body = mapped instanceof ApiError ? mapped.getResponse() : {
      code: `HTTP_${status}`,
      message: mapped.message,
    };
    response.setHeader('X-Request-Id', id);
    return response.status(status).json({ ...(body as object), requestId: id });
  }
}

export function invalid(field: string, message: string): never {
  throw new ApiError(400, 'INVALID_INPUT', 'Some fields are invalid.', { [field]: message });
}

export function missing(): never {
  throw new ApiError(404, 'NOT_FOUND', 'Resource not found.');
}

export function stale(): never {
  throw new ApiError(409, 'STALE_VERSION', 'The record changed. Reload it before saving.');
}

export function bodyOf(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('body', 'Expected a JSON object.');
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) invalid(key, 'Unknown field.');
  }
  return body;
}

export function uuid(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    invalid(field, 'Expected a UUID.');
  }
  return value.toLowerCase();
}

export function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    invalid('version', 'Expected a positive integer.');
  }
  return value;
}

export function text(value: unknown, field: string, max: number, min = 1): string {
  if (typeof value !== 'string') invalid(field, 'Expected text.');
  const result = value.trim();
  if (result.length < min || result.length > max || result.includes('\0')) invalid(field, `Expected ${min}–${max} characters.`);
  return result;
}

export function choice<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(field, `Allowed values: ${values.join(', ')}.`);
  return value as T;
}

export function pagination(pageValue: unknown, pageSizeValue: unknown) {
  function positive(value: unknown, field: string, fallback: number, maximum: number) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) invalid(field, 'Expected a positive integer.');
    const number = Number(value);
    if (number < 1 || number > maximum) invalid(field, `Expected a value between 1 and ${maximum}.`);
    return number;
  }
  const page = positive(pageValue, 'page', 1, 999_999_999);
  const pageSize = positive(pageSizeValue, 'pageSize', 25, 100);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export interface PageRow {
  items: unknown[];
  total: number;
}

export function paged(row: PageRow, page: number, pageSize: number) {
  return { items: row.items, page, pageSize, total: Number(row.total) };
}

export function pageSchema(item: SchemaObject): SchemaObject {
  return { type: 'object', required: ['items', 'page', 'pageSize', 'total'], properties: {
    items: { type: 'array', items: item }, page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' },
  } };
}
