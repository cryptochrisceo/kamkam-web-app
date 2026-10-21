import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';

export const authorSelect = {
  id: true, username: true, displayName: true, avatar: true, avatarColor: true, verified: true,
  _count: { select: { followers: true } },
} satisfies Prisma.UserSelect;

export const postInclude = { author: { select: authorSelect } } satisfies Prisma.PostInclude;
export type PostWithAuthor = Prisma.PostGetPayload<{ include: typeof postInclude }>;

export function publicUser(u: { id: string; username: string; displayName: string; avatar: string | null; avatarColor: string; verified: boolean; _count?: { followers: number } }) {
  return {
    id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, avatarColor: u.avatarColor, verified: u.verified,
    followers: u._count?.followers,
  };
}

/** Batch-load the viewer's relationship to a set of posts. */
async function viewerState(viewerId: string | undefined, postIds: string[]) {
  if (!viewerId || postIds.length === 0) return null;
  const [likes, reposts, bookmarks, gifts] = await Promise.all([
    prisma.like.findMany({ where: { userId: viewerId, postId: { in: postIds } }, select: { postId: true, superLike: true } }),
    prisma.repost.findMany({ where: { userId: viewerId, postId: { in: postIds } }, select: { postId: true } }),
    prisma.bookmark.findMany({ where: { userId: viewerId, postId: { in: postIds } }, select: { postId: true } }),
    prisma.gift.groupBy({ by: ['postId'], where: { senderId: viewerId, postId: { in: postIds } }, _count: { _all: true } }),
  ]);
  return {
    likes: new Map(likes.map(l => [l.postId, l.superLike])),
    reposts: new Set(reposts.map(r => r.postId)),
    bookmarks: new Set(bookmarks.map(b => b.postId)),
    gifted: new Set(gifts.map(g => g.postId as string)),
  };
}

export async function serializePosts(posts: PostWithAuthor[], viewerId?: string) {
  const vs = await viewerState(viewerId, posts.map(p => p.id));
  const now = Date.now();
  return posts.map(p => ({
    id: p.id,
    text: p.text,
    mediaUrls: p.mediaUrls,
    mediaType: p.mediaType,
    replyPolicy: p.replyPolicy,
    createdAt: p.createdAt,
    author: publicUser(p.author),
    likeCount: p.likeCount,
    commentCount: p.commentCount,
    repostCount: p.repostCount,
    giftCount: p.giftCount,
    superLikeCount: p.superLikeCount,
    earnedNgn: p.earnedNgn.toString(),
    boosted: p.boosted && (!p.boostedUntil || p.boostedUntil.getTime() > now),
    liked: vs ? vs.likes.has(p.id) : false,
    superLiked: vs ? vs.likes.get(p.id) === true : false,
    reposted: vs ? vs.reposts.has(p.id) : false,
    bookmarked: vs ? vs.bookmarks.has(p.id) : false,
    gifted: vs ? vs.gifted.has(p.id) : false,
    isMine: viewerId === p.authorId,
  }));
}

export async function serializePost(p: PostWithAuthor, viewerId?: string) {
  return (await serializePosts([p], viewerId))[0];
}

/** Ranking used by the For You feed: recency, plus an active gift boost. */
export function forYouScore(p: { createdAt: Date; boosted: boolean; boostedUntil: Date | null; giftCount: number; likeCount: number }) {
  const boostActive = p.boosted && (!p.boostedUntil || p.boostedUntil.getTime() > Date.now());
  return p.createdAt.getTime()
    + (boostActive ? 6 * 3600_000 : 0)
    + Math.min(p.giftCount, 30) * 15 * 60_000
    + Math.min(p.likeCount, 500) * 20_000;
}

export function trendingScore(p: { giftCount: number; likeCount: number; repostCount: number; commentCount: number }) {
  return p.giftCount * 6 + p.likeCount + p.repostCount * 2 + p.commentCount * 2;
}

export const HASHTAG_RE = /#[\p{L}\p{N}_]{2,40}/gu;
