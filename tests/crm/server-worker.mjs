import { createApp } from '../../apps/api/dist/app/create-app.js';
let app;
process.once('message', async (config) => {
  try {
    app = createApp(config);
    await app.listen({ host: '127.0.0.1', port: 0 });
    process.send({ port: app.server.address().port });
  } catch {
    process.send({ failed: true });
    process.exitCode = 1;
  }
});
process.once('SIGTERM', async () => {
  await app?.close();
  process.exit(0);
});
