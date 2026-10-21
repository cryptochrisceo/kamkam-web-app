import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}. Copy backend/.env.example to backend/.env`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: required('DATABASE_URL'),
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map(s => s.trim()).filter(Boolean),
  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  isProduction: process.env.NODE_ENV === 'production',
  demoStarterBalances: (process.env.DEMO_STARTER_BALANCES ?? 'true') !== 'false',
  simProcessingMs: Number(process.env.SIM_PROCESSING_MS || 4000),
  simCompleteMs: Number(process.env.SIM_COMPLETE_MS || 6000),
  authCookie: 'kk_session',
};

if (config.jwtSecret === 'dev-only-insecure-secret' || config.jwtSecret === 'change-me-to-a-long-random-string') {
  console.warn('[kamkam] Using a default JWT_SECRET. Fine for a local demo — change it in backend/.env for anything else.');
}
