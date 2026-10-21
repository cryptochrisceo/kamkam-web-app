import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { prisma } from '../utils/prisma';
import { conflict, unauthorized, notFound } from '../utils/errors';
import { parse, z } from '../utils/validate';
import { signToken, uid } from '../middleware/auth';
import { ensureWallet } from '../services/ledger';
import { colorFor, grantStarter, STARTER_NGN } from '../services/accounts';
import { countUnreadMessages } from './messages';

const registerSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,20}$/, 'Username must be 3–20 letters, numbers or underscores'),
  displayName: z.string().trim().min(1, 'Enter your name').max(50),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

const loginSchema = z.object({
  identifier: z.string().trim().toLowerCase().min(1, 'Enter your email or username'),
  password: z.string().min(1, 'Enter your password'),
});

function setSession(res: Response, user: { id: string; username: string }) {
  const token = signToken({ sub: user.id, username: user.username });
  res.cookie(config.authCookie, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  });
  return token;
}

export async function loadMe(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      profile: true,
      wallet: { select: { cryptoActivated: true } },
      _count: { select: { followers: true, following: true, posts: true } },
    },
  });
  if (!u) return null;
  const unread = await prisma.notification.count({ where: { userId, read: false } });
  const unreadMessages = await countUnreadMessages(userId);
  return {
    id: u.id, username: u.username, displayName: u.displayName, email: u.email, avatar: u.avatar, avatarColor: u.avatarColor,
    bio: u.bio, verified: u.verified, createdAt: u.createdAt,
    location: u.profile?.location ?? null, website: u.profile?.website ?? null, settings: u.profile?.settings ?? {},
    followers: u._count.followers, following: u._count.following, posts: u._count.posts,
    walletActivated: u.wallet?.cryptoActivated ?? false,
    unreadNotifications: unread,
    unreadMessages,
  };
}

export async function register(req: Request, res: Response) {
  const b = parse(registerSchema, req.body);
  const clash = await prisma.user.findFirst({ where: { OR: [{ username: b.username }, { email: b.email }] }, select: { username: true } });
  if (clash) throw conflict(clash.username === b.username ? 'That username is taken.' : 'An account with that email already exists.', 'ACCOUNT_EXISTS');
  const passwordHash = await bcrypt.hash(b.password, 11);
  const user = await prisma.$transaction(async tx => {
    const u = await tx.user.create({
      data: { username: b.username, displayName: b.displayName, email: b.email, passwordHash, avatarColor: colorFor(b.username), profile: { create: {} } },
    });
    await ensureWallet(tx, u.id);
    await grantStarter(tx, u.id, { NGN: String(STARTER_NGN) });
    return u;
  });
  const token = setSession(res, user);
  res.status(201).json({ user: await loadMe(user.id), token });
}

export async function login(req: Request, res: Response) {
  const b = parse(loginSchema, req.body);
  const user = await prisma.user.findFirst({ where: { OR: [{ email: b.identifier }, { username: b.identifier.replace(/^@/, '') }] } });
  // Same message for unknown user / wrong password (no account enumeration)
  if (!user || !(await bcrypt.compare(b.password, user.passwordHash))) throw unauthorized('Incorrect email/username or password.');
  const token = setSession(res, user);
  res.json({ user: await loadMe(user.id), token });
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie(config.authCookie, { path: '/' });
  res.json({ ok: true });
}

export async function me(req: Request, res: Response) {
  const u = await loadMe(uid(req));
  if (!u) throw notFound('Account no longer exists.', 'USER_NOT_FOUND');
  res.json({ user: u });
}
