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
    const app = await buildApp({ config, logger });
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

// Execute when run directly
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  start();
}
