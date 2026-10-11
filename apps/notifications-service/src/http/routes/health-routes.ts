import { FastifyInstance } from 'fastify';
import { DatabaseConnection } from '../../infra/database/connection.js';

export function registerHealthRoutes(app: FastifyInstance, db: DatabaseConnection) {
  app.get('/health', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      service: 'notifications-service',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return reply.status(200).send({
        status: 'ready',
        service: 'notifications-service',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return reply.status(503).send({
        status: 'not_ready',
        service: 'notifications-service',
        database: 'disconnected',
        error: (err as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  });
}
