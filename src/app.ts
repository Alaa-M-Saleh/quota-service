import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { AppError } from './errors';
import { accountRoutes, adminRoutes, hashKey } from './routes/accounts';
import { consumeRoutes } from './routes/consume';
import { planRoutes } from './routes/plans';
import { usageRoutes } from './routes/usage';
import { userRoutes } from './routes/users';

declare module 'fastify' {
  interface FastifyRequest {
    accountId: string;
  }
}

export interface AppDeps {
  pool: Pool;
  adminToken: string;
  now?: () => Date; // injectable clock (tests)
  logger?: boolean | { level: string };
}

export function buildApp({ pool, adminToken, now = () => new Date(), logger = false }: AppDeps): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });
  app.decorateRequest('accountId', '');

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  adminRoutes(app, pool, adminToken);

  // Everything under /v1 requires a valid API key; the key determines the account.
  app.register(async (v1) => {
    v1.addHook('onRequest', async (req) => {
      const key = req.headers['x-api-key'];
      if (typeof key !== 'string' || !key) throw new AppError(401, 'API_KEY_MISSING', 'X-Api-Key header is required');
      const r = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE api_key_hash = $1', [hashKey(key)]);
      if (!r.rowCount) throw new AppError(401, 'API_KEY_INVALID', 'Invalid API key');
      req.accountId = r.rows[0].id;
    });
    accountRoutes(v1, pool);
    planRoutes(v1, pool);
    userRoutes(v1, pool);
    consumeRoutes(v1, pool, now);
    usageRoutes(v1, pool, now);
  }, { prefix: '/v1' });

  return app;
}
