import rateLimit from 'express-rate-limit';

const json = (message: string) => ({ error: { message, code: 'RATE_LIMITED' } });

/** Login / register brute-force protection. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json('Too many attempts. Try again in a few minutes.'),
});

/** Money-moving endpoints. */
export const financeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json('Too many wallet actions. Slow down a little.'),
});

/** General API ceiling (generous — this runs on localhost). */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: json('Too many requests.'),
});
