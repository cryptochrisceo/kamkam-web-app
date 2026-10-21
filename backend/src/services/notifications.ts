import { NotificationType } from '@prisma/client';
import { prisma, Tx } from '../utils/prisma';

export interface NotifyInput {
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  amountLabel?: string | null;
  postId?: string | null;
}

/** Creates a notification. Self-notifications (actor === recipient) are skipped. */
export async function notify(i: NotifyInput, tx: Tx = prisma) {
  if (i.actorId && i.actorId === i.userId) return null;
  return tx.notification.create({
    data: {
      userId: i.userId,
      actorId: i.actorId ?? null,
      type: i.type,
      title: i.title,
      body: i.body,
      amountLabel: i.amountLabel ?? null,
      postId: i.postId ?? null,
    },
  });
}
