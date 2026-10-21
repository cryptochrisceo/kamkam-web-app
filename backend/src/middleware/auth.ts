import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { unauthorized } from '../utils/errors';

export interface AuthPayload { sub: string; username: string }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthPayload }
  }
}

export function signToken(p: AuthPayload) {
  return jwt.sign(p, config.jwtSecret, { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
}

function readToken(req: Request): string | null {
  const cookie = req.cookies?.[config.authCookie];
  if (cookie) return cookie;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function verify(token: string): AuthPayload | null {
  try {
    const p = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    if (typeof p.sub !== 'string') return null;
    return { sub: p.sub, username: String(p.username) };
  } catch {
    return null;
  }
}

/** Attaches req.user when a valid session exists; never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const t = readToken(req);
  if (t) {
    const p = verify(t);
    if (p) req.user = p;
  }
  next();
}

/** Rejects with 401 unless the request carries a valid session. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const t = readToken(req);
  const p = t ? verify(t) : null;
  if (!p) return next(unauthorized());
  req.user = p;
  next();
}

export const uid = (req: Request) => {
  if (!req.user) throw unauthorized();
  return req.user.sub;
};
