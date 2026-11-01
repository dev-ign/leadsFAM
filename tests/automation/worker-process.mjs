import { AutomationDatabase } from '../../packages/database/dist/index.js';
const db = new AutomationDatabase(process.env.WORKER_DATABASE_URL, 'worker');
await db.start();
const claim = await db.claim();
if (process.env.PHASE03_WORKER_MODE === 'execute') {
  const result = await db.execute(claim.id, claim.token, claim.generation);
  process.send({ event: 'executed', claim, result });
  await db.close();
  process.disconnect();
} else {
  process.send({ event: 'claimed', claim });
  // A real crash before execution: the parent SIGKILLs this synthetic worker.
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
}
