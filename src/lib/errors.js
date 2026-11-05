'use strict';

/** A business error that is safe to show to users and to Claude. */
class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.status = STATUS[code] || 400;
  }
}

const STATUS = {
  VALIDATION: 400,
  INVALID_STATE: 409,
  CONFLICT: 409,
  NOT_FOUND: 404,
  AMBIGUOUS: 409,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
};

const E = {
  validation: (msg, details) => new AppError('VALIDATION', msg, details),
  notFound: (msg) => new AppError('NOT_FOUND', msg),
  forbidden: (msg = 'You do not have permission to do that.') => new AppError('FORBIDDEN', msg),
  conflict: (msg, details) => new AppError('CONFLICT', msg, details),
  state: (msg, details) => new AppError('INVALID_STATE', msg, details),
  ambiguous: (msg, details) => new AppError('AMBIGUOUS', msg, details),
  unauthorized: (msg = 'Authentication required.') => new AppError('UNAUTHORIZED', msg),
  rateLimited: (msg = 'Too many requests. Please slow down.') => new AppError('RATE_LIMITED', msg),
};

/** Convert SQLite constraint errors into friendly messages; never leak SQL. */
function fromDbError(err) {
  if (err instanceof AppError) return err;
  const m = String(err && err.message || '');
  if (/UNIQUE constraint failed/i.test(m)) return E.conflict('A record with the same unique value already exists.');
  if (/CHECK constraint failed/i.test(m)) return E.validation('A value is outside the allowed set.');
  if (/FOREIGN KEY constraint failed/i.test(m)) return E.validation('A referenced record does not exist.');
  return null;
}

module.exports = { AppError, E, fromDbError };
