import { AutomationDatabase } from '../../packages/database/dist/index.js';
import { processAi } from '../../apps/api/dist/modules/ai/execute.js';
const db = new AutomationDatabase(process.env.WORKER_DATABASE_URL, 'worker');
await db.start();
const claim = await db.claimAi();
if (process.env.PHASE05_WORKER_MODE === 'execute') {
  await processAi(db, claim, { enabled: false });
  process.send({ claim });
  await db.close();
  process.disconnect();
} else {
  await db.prepareAi(claim.id, claim.token, claim.generation, 'simulation-v1');
  process.send({ claim });
  await new Promise(() => setInterval(() => {}, 1000));
}
