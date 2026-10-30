import { createApp } from './app/create-app.js';
import { parseEnv } from './config/env.js';

async function main() {
  const config = parseEnv(process.env);
  const app = createApp(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    app.log.fatal('API startup failed');
    await app.close();
    process.exitCode = 1;
  }
}
void main().catch((error: unknown) => {
  // Configuration errors contain field names only; never dump process.env or raw errors.
  console.error(
    error instanceof Error && error.message.startsWith('Invalid server configuration:')
      ? error.message
      : 'API startup failed',
  );
  process.exitCode = 1;
});
