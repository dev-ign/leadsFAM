import { AutomationDatabase } from '../../packages/database/dist/index.js';
import { processCommunication } from '../../apps/api/dist/modules/communications/dispatch.js';
const db = new AutomationDatabase(process.env.WORKER_DATABASE_URL, 'worker');
await db.start();
const claim = await db.claimCommunication();
if (process.env.PHASE04_WORKER_MODE === 'reconcile') {
  await processCommunication(db, claim);
  process.send({ claim });
  await db.close();
  process.disconnect();
} else {
  await db.prepareCommunication(claim.id, claim.token, claim.generation);
  process.send({ claim });
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
}
