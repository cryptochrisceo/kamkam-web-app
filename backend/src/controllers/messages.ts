import type { Request, Response } from 'express';
import { NotificationType } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { parse, z } from '../utils/validate';
import { uid } from '../middleware/auth';
import { notify } from '../services/notifications';
import { publicUser, authorSelect } from '../services/posts';

export async function countUnreadMessages(userId: string) {
  const memberships = await prisma.conversationMember.findMany({ where: { userId }, select: { conversationId: true, lastReadAt: true } });
  if (memberships.length === 0) return 0;
  const counts = await Promise.all(memberships.map(m => prisma.message.count({
    where: { conversationId: m.conversationId, senderId: { not: userId }, createdAt: { gt: m.lastReadAt } },
  })));
  return counts.reduce((a, b) => a + b, 0);
}

async function assertMember(conversationId: string, userId: string) {
  const m = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
  if (!m) {
    const exists = await prisma.conversation.count({ where: { id: conversationId } });
    if (!exists) throw notFound('Conversation not found.');
    throw forbidden('You are not part of this conversation.');
  }
  return m;
}

export async function listConversations(req: Request, res: Response) {
  const me = uid(req);
  const convs = await prisma.conversation.findMany({
    where: { members: { some: { userId: me } } },
    orderBy: { updatedAt: 'desc' },
    include: {
      members: { include: { user: { select: authorSelect } } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    take: 50,
  });
  const out = await Promise.all(convs.map(async c => {
    const mine = c.members.find(m => m.userId === me)!;
    const other = c.members.find(m => m.userId !== me) ?? mine;
    const unread = await prisma.message.count({ where: { conversationId: c.id, senderId: { not: me }, createdAt: { gt: mine.lastReadAt } } });
    const last = c.messages[0];
    return {
      id: c.id,
      user: publicUser(other.user),
      lastMessage: last ? { text: last.text, kind: last.kind, createdAt: last.createdAt, mine: last.senderId === me } : null,
      unread,
      updatedAt: c.updatedAt,
    };
  }));
  res.json({ conversations: out });
}

export async function createConversation(req: Request, res: Response) {
  const me = uid(req);
  const { userId } = parse(z.object({ userId: z.string().min(1) }), req.body);
  if (userId === me) throw badRequest('You cannot message yourself.');
  const other = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!other) throw notFound('User not found.', 'USER_NOT_FOUND');
  const existing = await prisma.conversation.findFirst({
    where: { AND: [{ members: { some: { userId: me } } }, { members: { some: { userId } } }] },
    select: { id: true },
  });
  if (existing) return res.json({ id: existing.id, created: false });
  const c = await prisma.conversation.create({ data: { members: { create: [{ userId: me }, { userId }] } } });
  res.status(201).json({ id: c.id, created: true });
}

export async function getMessages(req: Request, res: Response) {
  const me = uid(req);
  const id = String(req.params.id);
  await assertMember(id, me);
  const [messages, members] = await Promise.all([
    prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' }, take: 300 }),
    prisma.conversationMember.findMany({ where: { conversationId: id }, include: { user: { select: authorSelect } } }),
  ]);
  const other = members.find(m => m.userId !== me);
  res.json({
    id,
    user: other ? publicUser(other.user) : null,
    messages: messages.map(m => ({
      id: m.id, text: m.text, kind: m.kind, meta: m.meta, createdAt: m.createdAt,
      mine: m.senderId === me,
      read: m.senderId === me && !!other && other.lastReadAt >= m.createdAt,
    })),
  });
}

export async function sendMessage(req: Request, res: Response) {
  const me = uid(req);
  const id = String(req.params.id);
  await assertMember(id, me);
  const { text } = parse(z.object({ text: z.string().trim().min(1, 'Message is empty').max(2000) }), req.body);
  const [msg] = await prisma.$transaction([
    prisma.message.create({ data: { conversationId: id, senderId: me, text } }),
    prisma.conversation.update({ where: { id }, data: { updatedAt: new Date() } }),
    prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: me } }, data: { lastReadAt: new Date() } }),
  ]);
  // One unread "message" notification per sender at a time (avoid spam)
  const others = await prisma.conversationMember.findMany({ where: { conversationId: id, userId: { not: me } }, select: { userId: true } });
  const sender = await prisma.user.findUniqueOrThrow({ where: { id: me }, select: { displayName: true } });
  for (const o of others) {
    const pending = await prisma.notification.count({ where: { userId: o.userId, actorId: me, type: NotificationType.MESSAGE, read: false } });
    if (!pending) await notify({ userId: o.userId, actorId: me, type: NotificationType.MESSAGE, title: `New message from ${sender.displayName}`, body: `"${text.slice(0, 120)}"` });
  }
  res.status(201).json({ message: { id: msg.id, text: msg.text, kind: msg.kind, createdAt: msg.createdAt, mine: true, read: false } });
}

export async function markRead(req: Request, res: Response) {
  const me = uid(req);
  const id = String(req.params.id);
  await assertMember(id, me);
  await prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: me } }, data: { lastReadAt: new Date() } });
  res.json({ ok: true });
}
