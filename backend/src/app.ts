import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { api } from './routes';
import { apiLimiter } from './middleware/rateLimit';
import { UPLOAD_DIR } from './middleware/upload';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: (origin, cb) => {
      // Allow same-machine tools (curl, no Origin) and configured localhost origins.
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: false }));
  app.use('/api', apiLimiter, api);
  app.get('/', (_req, res) => res.json({ name: 'KAMKAM API', docs: 'See README.md', health: '/api/health' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
