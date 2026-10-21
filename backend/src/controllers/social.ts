import type { Request, Response } from 'express';
import { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { badRequest } from '../utils/errors';
import { uid } from '../middleware/auth';
import { authorSelect, HASHTAG_RE, postInclude, publicUser, serializePosts, trendingScore } from '../services/posts';

export async function search(req: Request, res: Response) {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.json({ q, users: [], posts: [] });
  const term = q.replace(/^@/, '');
  const [users, posts] = await Promise.all([
    prisma.user.findMany({
      where: { OR: [{ username: { contains: term, mode: 'insensitive' } }, { displayName: { contains: term, mode: 'insensitive' } }] },
      select: authorSelect, take: 10,
    }),
    prisma.post.findMany({ where: { text: { contains: q, mode: 'insensitive' } }, include: postInclude, orderBy: { createdAt: 'desc' }, take: 30 }),
  ]);
  const viewer = req.user?.sub;
  const following = viewer ? new Set((await prisma.follow.findMany({ where: { followerId: viewer, followingId: { in: users.map(u => u.id) } }, select: { followingId: true } })).map(f => f.followingId)) : new Set<string>();
  res.json({
    q,
    users: users.map(u => ({ ...publicUser(u), isFollowing: following.has(u.id), isMe: u.id === viewer })),
    posts: await serializePosts(posts, viewer),
  });
}

export async function trending(req: Request, res: Response) {
  const since = new Date(Date.now() - 14 * 24 * 3600_000);
  const dayAgo = Date.now() - 24 * 3600_000;
  const recent = await prisma.post.findMany({ where: { createdAt: { gte: since } }, select: { text: true, createdAt: true }, take: 2000 });
  const tags = new Map<string, { total: number; today: number }>();
  for (const p of recent) {
    const seen = new Set((p.text.match(HASHTAG_RE) || []).map(t => t.toLowerCase()));
    for (const t of seen) {
      const e = tags.get(t) || { total: 0, today: 0 };
      e.total++; if (p.createdAt.getTime() > dayAgo) e.today++;
      tags.set(t, e);
    }
  }
  const top = [...tags.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, Number(req.query.limit) || 5);
  // Keep the author's original casing from any post
  const topics = top.map(([t, e]) => {
    const orig = recent.map(p => (p.text.match(HASHTAG_RE) || []).find(x => x.toLowerCase() === t)).find(Boolean) || t;
    return { tag: orig, count: e.total, rise: e.total ? `+${Math.round((e.today / e.total) * 100)}%` : '' };
  });
  const pool = await prisma.post.findMany({ where: { createdAt: { gte: since } }, include: postInclude, take: 300, orderBy: { createdAt: 'desc' } });
  pool.sort((a, b) => trendingScore(b) - trendingScore(a));
  res.json({ topics, posts: await serializePosts(pool.slice(0, 6), req.user?.sub) });
}

const FILTERS: Record<string, Prisma.NotificationWhereInput> = {
  gifts: { type: NotificationType.GIFT_RECEIVED },
  likes: { type: { in: [NotificationType.LIKE, NotificationType.REPOST] } },
  comments: { type: NotificationType.COMMENT },
  followers: { type: NotificationType.FOLLOW },
  messages: { type: NotificationType.MESSAGE },
  wallet: { type: { in: [NotificationType.WITHDRAWAL_COMPLETED, NotificationType.TRANSACTION_COMPLETED] } },
};

export async function listNotifications(req: Request, res: Response) {
  const me = uid(req);
  const f = String(req.query.filter || 'all').toLowerCase();
  let where: Prisma.NotificationWhereInput = { userId: me };
  if (f === 'mentions') {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: me }, select: { username: true } });
    where = { userId: me, type: NotificationType.COMMENT, body: { contains: '@' + u.username, mode: 'insensitive' } };
  } else if (FILTERS[f]) where = { userId: me, ...FILTERS[f] };
  const rows = await prisma.notification.findMany({ where, include: { actor: { select: authorSelect } }, orderBy: { createdAt: 'desc' }, take: 100 });
  const unread = await prisma.notification.count({ where: { userId: me, read: false } });
  res.json({
    unread,
    notifications: rows.map(n => ({
      id: n.id, type: n.type, title: n.title, body: n.body, amountLabel: n.amountLabel, postId: n.postId, read: n.read, createdAt: n.createdAt,
      actor: n.actor ? publicUser(n.actor) : null,
    })),
  });
}

export async function markNotificationsRead(req: Request, res: Response) {
  const me = uid(req);
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : null;
  await prisma.notification.updateMany({ where: { userId: me, read: false, ...(ids ? { id: { in: ids } } : {}) }, data: { read: true } });
  res.json({ ok: true });
}

export async function uploadFiles(req: Request, res: Response) {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw badRequest('No file uploaded. Use form field "files".', 'UPLOAD');
  res.status(201).json({
    files: files.map(f => ({ url: '/uploads/' + f.filename, type: f.mimetype.startsWith('video/') ? 'VIDEO' : 'IMAGE', size: f.size })),
  });
}
