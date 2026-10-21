import { PrismaClient, Prisma } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

export type Tx = Prisma.TransactionClient;
export { Prisma };
