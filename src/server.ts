import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool, migrate } from './db';

async function main() {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl, cfg.poolMax);
  await migrate(pool);
  const app = buildApp({ pool, adminToken: cfg.adminToken, logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.listen({ host: cfg.host, port: cfg.port });

  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
