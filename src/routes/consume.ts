import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { consume } from '../services/consume';

export const MAX_UNITS = 1_000_000_000;

const body = z.object({
  userId: z.string().min(1).max(200),
  units: z.number().int().min(1).max(MAX_UNITS),
  requestId: z.string().min(1).max(200),
});

export function consumeRoutes(app: FastifyInstance, pool: Pool, now: () => Date) {
  // 200 for both outcomes; the decision is in `accepted`. Errors (4xx) never record anything.
  app.post('/consume', async (req) => {
    const b = body.parse(req.body);
    return consume(pool, now(), { accountId: req.accountId, ...b });
  });
}
