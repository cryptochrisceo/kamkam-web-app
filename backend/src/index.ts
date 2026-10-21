import { config } from './config';
import { createApp } from './app';
import { prisma } from './utils/prisma';
import { startSettlementWorker, stopSettlementWorker } from './services/settlementWorker';

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    console.error('\n[kamkam] Could not connect to PostgreSQL.');
    console.error('         Check DATABASE_URL in backend/.env and that PostgreSQL is running.');
    console.error('         Details:', (e as Error).message.split('\n').slice(-2).join(' '), '\n');
    process.exit(1);
  }
  const [{ enc }] = await prisma.$queryRaw<{ enc: string }[]>`SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()`;
  if (enc !== 'UTF8') {
    console.warn(`[kamkam] WARNING: database encoding is ${enc}, not UTF8. ₦ symbols and emoji will fail to save.`);
    console.warn("         Recreate it with: CREATE DATABASE kamkam WITH ENCODING 'UTF8' TEMPLATE template0;");
  }
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[kamkam] API ready on http://localhost:${config.port}  (CORS: ${config.corsOrigins.join(', ')})`);
  });
  startSettlementWorker();

  const shutdown = async () => {
    stopSettlementWorker();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
