export interface Config {
  databaseUrl: string;
  adminToken: string;
  host: string;
  port: number;
  poolMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  const adminToken = env.ADMIN_TOKEN;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!adminToken || adminToken.length < 8) throw new Error('ADMIN_TOKEN is required (min 8 characters)');
  return {
    databaseUrl,
    adminToken,
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    poolMax: Number(env.DB_POOL_MAX ?? 20),
  };
}
