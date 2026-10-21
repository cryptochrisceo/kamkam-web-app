import type { Request, Response } from 'express';
import { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { badRequest, notFound } from '../utils/errors';
import { parse, z } from '../utils/validate';
import { uid } from '../middleware/auth';
import { notify } from '../services/notifications';
import { authorSelect, postInclude, publicUser, serializePosts } from '../services/posts';
import { fmtNgn } from '../services/format';
import { loadMe } from './auth';

async function findUser(idOrUsername: string) {
  const key = idOrUsername.replace(/^@/, '');
  return prisma.user.findFirst({ where: { OR: [{ id: key }, { username: key.toLowerCase() }] }, include: { profile: true } });
}

export async function getProfile(req: Request, res: Response) {
  const u = await findUser(String(req.params.id));
  if (!u) throw notFound('User not found.', 'USER_NOT_FOUND');
  const viewer = req.user?.sub;
  const [posts, followers, following, giftsReceived, isFollowing, followsYou] = await Promise.all([
    prisma.post.count({ where: { authorId: u.id } }),
    prisma.follow.count({ where: { followingId: u.id } }),
    prisma.follow.count({ where: { followerId: u.id } }),
    prisma.gift.count({ where: { recipientId: u.id } }),
    viewer ? prisma.follow.count({ where: { followerId: viewer, followingId: u.id } }) : 0,
    viewer ? prisma.follow.count({ where: { followerId: u.id, followingId: viewer } }) : 0,
  ]);
  res.json({
    user: {
      id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, avatarColor: u.avatarColor, bio: u.bio,
      verified: u.verified, createdAt: u.createdAt, location: u.profile?.location ?? null, website: u.profile?.website ?? null,
      coverImage: u.profile?.coverImage ?? null,
      stats: { posts, followers, following, giftsReceived },
      isFollowing: !!isFollowing, followsYou: !!followsYou, isMe: viewer === u.id,
    },
  });
}

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  bio: z.string().trim().max(280).nullable().optional(),
  avatar: z.string().regex(/^\/uploads\/[\w.-]+$/).nullable().optional(),
  location: z.string().trim().max(60).nullable().optional(),
  website: z.string().trim().max(100).nullable().optional(),
  coverImage: z.string().regex(/^\/uploads\/[\w.-]+$/).nullable().optional(),
  settings: z.record(z.boolean()).optional(),
});

export async function updateMe(req: Request, res: Response) {
  const me = uid(req);
  const b = parse(updateSchema, req.body);
  await prisma.user.update({
    where: { id: me },
    data: {
      displayName: b.displayName, bio: b.bio, avatar: b.avatar,
      profile: {
        upsert: {
          create: { location: b.location ?? null, website: b.website ?? null, coverImage: b.coverImage ?? null, settings: b.settings ?? {} },
          update: { location: b.location, website: b.website, coverImage: b.coverImage, settings: b.settings },
        },
      },
    },
  });
  res.json({ user: await loadMe(me) });
}

export async function follow(req: Request, res: Response) {
  const me = uid(req);
  const target = await findUser(String(req.params.id));
  if (!target) throw notFound('User not found.', 'USER_NOT_FOUND');
  if (target.id === me) throw badRequest('You cannot follow yourself.');
  try {
    await prisma.follow.create({ data: { followerId: me, followingId: target.id } });
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: me }, select: { displayName: true } });
    const mutuals = await prisma.follow.count({ where: { followerId: target.id, following: { followers: { some: { followerId: me } } } } });
    await notify({ userId: target.id, actorId: me, type: NotificationType.FOLLOW, title: `${actor.displayName} followed you`, body: mutuals ? `You have ${mutuals} mutual connection${mutuals === 1 ? '' : 's'}.` : 'Say hello or follow back.' });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; // already following → idempotent
  }
  const followers = await prisma.follow.count({ where: { followingId: target.id } });
  res.json({ following: true, followers });
}

export async function unfollow(req: Request, res: Response) {
  const me = uid(req);
  const target = await findUser(String(req.params.id));
  if (!target) throw notFound('User not found.', 'USER_NOT_FOUND');
  await prisma.follow.deleteMany({ where: { followerId: me, followingId: target.id } });
  const followers = await prisma.follow.count({ where: { followingId: target.id } });
  res.json({ following: false, followers });
}

async function listFollow(req: Request, res: Response, dir: 'followers' | 'following') {
  const u = await findUser(String(req.params.id));
  if (!u) throw notFound('User not found.', 'USER_NOT_FOUND');
  const rows = await prisma.follow.findMany({
    where: dir === 'followers' ? { followingId: u.id } : { followerId: u.id },
    include: { follower: { select: authorSelect }, following: { select: authorSelect } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const people = rows.map(r => publicUser(dir === 'followers' ? r.follower : r.following));
  const viewer = req.user?.sub;
  const mine = viewer ? new Set((await prisma.follow.findMany({ where: { followerId: viewer, followingId: { in: people.map(p => p.id) } }, select: { followingId: true } })).map(f => f.followingId)) : new Set<string>();
  res.json({ users: people.map(p => ({ ...p, isFollowing: mine.has(p.id), isMe: p.id === viewer })) });
}
export const followers = (req: Request, res: Response) => listFollow(req, res, 'followers');
export const following = (req: Request, res: Response) => listFollow(req, res, 'following');

export async function suggested(req: Request, res: Response) {
  const me = req.user?.sub;
  const exclude = me ? [me, ...(await prisma.follow.findMany({ where: { followerId: me }, select: { followingId: true } })).map(f => f.followingId)] : [];
  const limit = Math.min(Number(req.query.limit) || 4, 20);
  const users = await prisma.user.findMany({
    where: { id: { notIn: exclude } },
    select: authorSelect,
    orderBy: [{ followers: { _count: 'desc' } }, { createdAt: 'desc' }],
    take: limit,
  });
  res.json({ users: users.map(u => ({ ...publicUser(u), isFollowing: false })) });
}

export async function userPosts(req: Request, res: Response) {
  const u = await findUser(String(req.params.id));
  if (!u) throw notFound('User not found.', 'USER_NOT_FOUND');
  const tab = String(req.query.tab || 'posts');
  if (tab === 'replies') {
    const comments = await prisma.comment.findMany({
      where: { authorId: u.id },
      include: { author: { select: authorSelect }, post: { select: { id: true, text: true, author: { select: { username: true } } } } },
      orderBy: { createdAt: 'desc' }, take: 50,
    });
    return res.json({
      replies: comments.map(c => ({ id: c.id, text: c.text, createdAt: c.createdAt, author: publicUser(c.author), post: { id: c.post.id, text: c.post.text, username: c.post.author.username } })),
    });
  }
  const posts = await prisma.post.findMany({
    where: { authorId: u.id, ...(tab === 'media' ? { mediaUrls: { isEmpty: false } } : {}) },
    include: postInclude, orderBy: { createdAt: 'desc' }, take: 50,
  });
  res.json({ posts: await serializePosts(posts, req.user?.sub) });
}

/** Public supporter wall for a profile (Gifts tab). */
export async function giftWall(req: Request, res: Response) {
  const u = await findUser(String(req.params.id));
  if (!u) throw notFound('User not found.', 'USER_NOT_FOUND');
  const gifts = await prisma.gift.findMany({
    where: { recipientId: u.id },
    include: { sender: { select: authorSelect }, post: { select: { text: true } } },
    orderBy: { createdAt: 'desc' }, take: 30,
  });
  res.json({
    gifts: gifts.map(g => ({
      id: g.id, sender: publicUser(g.sender), createdAt: g.createdAt, tier: fmtNgn(g.amountNgn),
      note: g.post ? `on "${g.post.text.slice(0, 32)}${g.post.text.length > 32 ? '…' : ''}"` : 'Profile gift',
    })),
  });
}
