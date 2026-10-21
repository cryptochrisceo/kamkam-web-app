import type { NextFunction, Request, Response, RequestHandler } from 'express';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, code = 'BAD_REQUEST', details?: unknown) => new HttpError(400, msg, code, details);
export const unauthorized = (msg = 'You need to log in to do that.') => new HttpError(401, msg, 'UNAUTHENTICATED');
export const forbidden = (msg = 'You are not allowed to do that.') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'Not found.', code = 'NOT_FOUND') => new HttpError(404, msg, code);
export const conflict = (msg: string, code = 'CONFLICT') => new HttpError(409, msg, code);
export const insufficient = (msg: string) => new HttpError(422, msg, 'INSUFFICIENT_BALANCE');

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const ah = (fn: AsyncFn): RequestHandler => (req, res, next) => {
  fn(req, res, next).catch(next);
};
