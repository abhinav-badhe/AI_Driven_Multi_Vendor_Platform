import { getConfig } from './config/index.js';
import { buildApp } from './app.js';
import { JsonLogger } from './observability/logger.js';

async function start() {
  const config = getConfig();

  const logger = new JsonLogger({
    serviceName: config.observability.serviceName,
    level: config.app.logLevel,
    pretty: config.observability.logPretty,
    redactKeys: config.observability.redactKeys,
  });

  try {
    let dbConnection;
    let skipMigrations = false;

    // Check if we're using placeholder credentials and should boot in-memory database
    if (config.postgres.password === 'placeholder_postgres_password' || !config.postgres.password) {
      logger.info('Using in-memory PostgreSQL (pg-mem) for functional verification...');
      // Dynamic import to avoid runtime dependency failure in production
      const { createMigratedTestDatabase } = await import('./infra/database/in-memory-db.js');
      const { seedDemoData } = await import('./infra/database/seed.js');
      dbConnection = await createMigratedTestDatabase();
      await seedDemoData(dbConnection, logger);
      skipMigrations = true;
    }

    const app = await buildApp({
      config,
      logger,
      dbConnection,
      skipMigrations,
    });
    await app.listen({ port: config.app.port, host: config.app.host });
    logger.info(`Server listening on http://${config.app.host}:${config.app.port}`, {
      environment: config.app.nodeEnv,
      port: config.app.port,
    });
  } catch (err) {
    logger.fatal('Failed to start HTTP server', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  }
}

// Always execute entrypoint
start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
