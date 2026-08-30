import type { FastifyReply } from 'fastify';

/** Stable machine error codes returned as `{ error: { code, message, details? } }` (§8). */
export type ErrorCode =
  | 'RANK_GAP'
  | 'RANK_OUT_OF_RANGE'
  | 'TOO_MANY_ENTRIES'
  | 'OFFHAND_BLOCKED_BY_TWOHAND'
  | 'DUPLICATE_SLOT'
  | 'DUPLICATE_ITEM_IN_LIST'
  | 'SPEC_NOT_ALLOWED_IN_LIST'
  | 'ITEM_NOT_IN_PHASE'
  | 'ITEM_SLOT_MISMATCH'
  | 'CHARACTER_NOT_OWNED'
  | 'SUBMISSION_LOCKED'
  | 'PHASE_CLOSED'
  | 'LIST_NOT_FULL'
  | 'INVITE_EXPIRED'
  | 'INVITE_REVOKED'
  | 'INVITE_EXHAUSTED'
  | 'GUILD_SUSPENDED'
  | 'GUILD_LISTS_LOCKED'
  | 'GUILD_MISMATCH'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Cross-tenant misses are 404, never 403 (§3A.2) — a 403 confirms the
 * resource exists and leaks tenant membership. Always raise this, never a
 * bespoke "forbidden" error, when a resource belongs to another guild.
 */
export function notFound(message = 'Not found.'): ApiError {
  return new ApiError(404, 'NOT_FOUND', message);
}

export function unauthorized(message = 'Unauthorized.'): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', message);
}

export function sendError(reply: FastifyReply, err: ApiError): void {
  reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
}
