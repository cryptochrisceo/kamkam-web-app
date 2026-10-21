import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { MulterError } from 'multer';
import { HttpError } from '../utils/errors';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code, details: err.details } });
  }
  if (err instanceof MulterError) {
    return res.status(400).json({ error: { message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 25 MB).' : err.message, code: 'UPLOAD' } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(409).json({ error: { message: 'That already exists.', code: 'CONFLICT' } });
    if (err.code === 'P2025') return res.status(404).json({ error: { message: 'Not found.', code: 'NOT_FOUND' } });
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    console.error('[kamkam] Database unavailable:', err.message);
    return res.status(503).json({ error: { message: 'Database unavailable. Is PostgreSQL running?', code: 'DB_UNAVAILABLE' } });
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    return res.status(400).json({ error: { message: 'Malformed JSON body.', code: 'BAD_JSON' } });
  }
  console.error('[kamkam] Unhandled error:', err);
  res.status(500).json({ error: { message: 'Something went wrong on the server.', code: 'INTERNAL' } });
}
