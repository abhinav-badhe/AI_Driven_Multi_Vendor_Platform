import { loadConfig } from './config/index.js';
import { buildApp } from './app.js';

export async function startServer() {
  const config = loadConfig();
  const app = buildApp({ config });

  try {
    await app.listen({ port: config.app.port, host: config.app.host });
    console.log(`[notifications-service] Server listening on port ${config.app.port}`);
  } catch (err) {
    console.error('[notifications-service] Failed to start server:', err);
    process.exit(1);
  }
}

// Only auto-start when executed as direct entry point
if (process.env.START_NOTIFICATIONS_SERVICE === 'true') {
  void startServer();
}
