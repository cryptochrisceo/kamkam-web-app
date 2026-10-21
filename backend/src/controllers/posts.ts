import type { Request, Response } from 'express';
import { MediaType, NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { parse, z } from '../utils/validate';
import { uid } from '../middleware/auth';
import { notify } from '../services/notifications';
import { authorSelect, forYouScore, postInclude, publicUser, serializePost, serializePosts, trendingScore } from '../services/posts';

const excerpt = (t: string, n = 70) => (t.length > n ? t.slice(0, n) + '…' : t);

async function getPostOr404(id: string) {
  const p = await prisma.post.findUnique({ where: { id }, include: postInclude });
  if (!p) throw notFound('Post not found.', 'POST_NOT_FOUND');
  return p;
}

export async function listPosts(req: Request, res: Response) {
  const viewer = req.user?.sub;
  const tab = String(req.query.tab || 'foryou').toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  let posts;
  if (tab === 'following') {
    if (!viewer) return res.json({ posts: [], nextOffset: null });
    const ids = (await prisma.follow.findMany({ where: { followerId: viewer }, select: { followingId: true } })).map(f => f.followingId);
    posts = await prisma.post.findMany({ where: { authorId: { in: [...ids, viewer] } }, include: postInclude, orderBy: { createdAt: 'desc' }, skip: offset, take: limit });
  } else {
    // Rank a recent window in memory (fine for a local MVP)
    const since = tab === 'trending' ? new Date(Date.now() - 14 * 24 * 3600_000) : undefined;
    const pool = await prisma.post.findMany({ where: since ? { createdAt: { gte: since } } : {}, include: postInclude, orderBy: { createdAt: 'desc' }, take: 400 });
    pool.sort((a, b) => (tab === 'trending' ? trendingScore(b) - trendingScore(a) : forYouScore(b) - forYouScore(a)));
    posts = pool.slice(offset, offset + limit);
  }
  res.json({ posts: await serializePosts(posts, viewer), nextOffset: posts.length === limit ? offset + limit : null });
}

export async function getPost(req: Request, res: Response) {
  const p = await getPostOr404(String(req.params.id));
  res.json({ post: await serializePost(p, req.user?.sub) });
}

const createSchema = z.object({
  text: z.string().trim().max(1000, 'Posts are limited to 1000 characters').default(''),
  mediaUrls: z.array(z.string().regex(/^\/uploads\/[\w.-]+$/, 'Invalid media path')).max(4).default([]),
  mediaType: z.nativeEnum(MediaType).optional(),
  replyPolicy: z.enum(['Everyone', 'Followers', 'Mentioned']).default('Everyone'),
});

export async function createPost(req: Request, res: Response) {
  const me = uid(req);
  const b = parse(createSchema, req.body);
  if (!b.text && b.mediaUrls.length === 0) throw badRequest('Write something or attach media.', 'EMPTY_POST');
  const mediaType = b.mediaUrls.length ? (b.mediaType ?? (b.mediaUrls.some(u => /\.(mp4|webm|mov)$/i.test(u)) ? MediaType.VIDEO : MediaType.IMAGE)) : null;
  const p = await prisma.post.create({ data: { authorId: me, text: b.text, mediaUrls: b.mediaUrls, mediaType, replyPolicy: b.replyPolicy }, include: postInclude });
  res.status(201).json({ post: await serializePost(p, me) });
}

export async function deletePost(req: Request, res: Response) {
  const me = uid(req);
  const p = await getPostOr404(String(req.params.id));
  if (p.authorId !== me) throw forbidden('You can only delete your own posts.');
  // Gifts keep their financial records (postId set to NULL by the relation).
  await prisma.post.delete({ where: { id: p.id } });
  res.json({ ok: true });
}

async function counts(postId: string) {
  const p = await prisma.post.findUniqueOrThrow({ where: { id: postId }, select: { likeCount: true, repostCount: true, commentCount: true, giftCount: true, superLikeCount: true } });
  return p;
}

export async function like(req: Request, res: Response) {
  const me = uid(req);
  const p = await getPostOr404(String(req.params.id));
  const created = await prisma.$transaction(async tx => {
    const exists = await tx.like.findUnique({ where: { userId_postId: { userId: me, postId: p.id } } });
    if (exists) return false;
    await tx.like.create({ data: { userId: me, postId: p.id } });
    await tx.post.update({ where: { id: p.id }, data: { likeCount: { increment: 1 } } });
    return true;
  });
  if (created) {
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: me }, select: { displayName: true } });
    await notify({ userId: p.authorId, actorId: me, type: NotificationType.LIKE, postId: p.id, title: `${actor.displayName} liked your post`, body: `"${excerpt(p.text)}"` });
  }
  res.json({ liked: true, ...(await counts(p.id)) });
}

export async function unlike(req: Request, res: Response) {
  const me = uid(req);
  const p = await getPostOr404(String(req.params.id));
  await prisma.$transaction(async tx => {
    const l = await tx.like.findUnique({ where: { userId_postId: { userId: me, postId: p.id } } });
    if (!l) return;
    await tx.like.delete({ where: { id: l.id } });
    await tx.post.update({ where: { id: p.id }, data: { likeCount: { decrement: 1 }, superLikeCount: l.superLike ? { decrement: 1 } : undefined } });
  });
  res.json({ liked: false, superLiked: false, ...(await counts(p.id)) });
}

export async function repost(req: Request, res: Response) {
  const me = uid(req);
  const p = await getPostOr404(String(req.params.id));
  const created = await prisma.$transaction(async tx => {
    const ex = await tx.repost.findUnique({ where: { userId_postId: { userId: me, postId: p.id } } });
    if (ex) return false;
    await tx.repost.create({ data: { userId: me, postId: p.id } });
    await tx.post.update({ where: { id: p.id }, data: { repostCount: { increment: 1 } } });
    return true;
  });
  if (created) {
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: me }, select: { displayName: true } });
    await notify({ userId: p.authorId, actorId: me, type: NotificationType.REPOST, postId: p.id, title: `${actor.displayName} reposted your post`, body: `"${excerpt(p.text)}"` });
  }
  res.json({ reposted: true, ...(await counts(p.id)) });
}

export async function unrepost(req: Request, res: Response) {
  const me = uid(req);
  const p = await getPostOr404(String(req.params.id));
  await prisma.$transaction(async tx => {
    const r = await tx.repost.deleteMany({ where: { userId: me, postId: p.id } });
    if (r.count) await tx.post.update({ where: { id: p.id }, data: { repostCount: { decrement: 1 } } });
  });
  res.json({ reposted: false, ...(await counts(p.id)) });
}

export async function bookmark(req: Request, res: Response) {
  const me = uid(req);
  const p = await getPostOr404(String(req.params.id));
  try { await prisma.bookmark.create({ data: { userId: me, postId: p.id } }); }
  catch (e) { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; }
  res.json({ bookmarked: true });
}

export async function unbookmark(req: Request, res: Response) {
  const me = uid(req);
  await prisma.bookmark.deleteMany({ where: { userId: me, postId: String(req.params.id) } });
  res.json({ bookmarked: false });
}

export async function listBookmarks(req: Request, res: Response) {
  const me = uid(req);
  const rows = await prisma.bookmark.findMany({ where: { userId: me }, include: { post: { include: postInclude } }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ posts: await serializePosts(rows.map(r => r.post), me) });
}

const commentSchema = z.object({
  text: z.string().trim().min(1, 'Reply is empty').max(1000),
  parentId: z.string().min(1).optional(),
});

export async function comment(req: Request, res: Response) {
  const me = uid(req);
  const p = await getPostOr404(String(req.params.id));
  const b = parse(commentSchema, req.body);
  // Reply policy
  if (p.authorId !== me && p.replyPolicy === 'Followers') {
    const f = await prisma.follow.count({ where: { followerId: me, followingId: p.authorId } });
    if (!f) throw forbidden('Only followers of this creator can reply to this post.');
  }
  let parent: { id: string; authorId: string } | null = null;
  if (b.parentId) {
    parent = await prisma.comment.findFirst({ where: { id: b.parentId, postId: p.id }, select: { id: true, authorId: true } });
    if (!parent) throw notFound('The comment you are replying to no longer exists.');
  }
  const [c] = await prisma.$transaction([
    prisma.comment.create({ data: { postId: p.id, authorId: me, text: b.text, parentId: parent?.id ?? null }, include: { author: { select: authorSelect } } }),
    prisma.post.update({ where: { id: p.id }, data: { commentCount: { increment: 1 } } }),
  ]);
  const actor = c.author.displayName;
  await notify({ userId: p.authorId, actorId: me, type: NotificationType.COMMENT, postId: p.id, title: `${actor} replied to your post`, body: `"${excerpt(b.text)}"` });
  if (parent && parent.authorId !== p.authorId) {
    await notify({ userId: parent.authorId, actorId: me, type: NotificationType.COMMENT, postId: p.id, title: `${actor} replied to your comment`, body: `"${excerpt(b.text)}"` });
  }
  res.status(201).json({ comment: { id: c.id, text: c.text, createdAt: c.createdAt, parentId: c.parentId, author: publicUser(c.author), replies: [] }, ...(await counts(p.id)) });
}

export async function listComments(req: Request, res: Response) {
  const postId = String(req.params.id);
  const all = await prisma.comment.findMany({ where: { postId }, include: { author: { select: authorSelect } }, orderBy: { createdAt: 'asc' }, take: 500 });
  type C = { id: string; text: string; createdAt: Date; parentId: string | null; author: ReturnType<typeof publicUser>; replies: C[] };
  const byId = new Map<string, C>();
  all.forEach(c => byId.set(c.id, { id: c.id, text: c.text, createdAt: c.createdAt, parentId: c.parentId, author: publicUser(c.author), replies: [] }));
  const roots: C[] = [];
  byId.forEach(c => {
    const parent = c.parentId ? byId.get(c.parentId) : null;
    if (parent) parent.replies.push(c); else roots.push(c);
  });
  res.json({ comments: roots });
}
