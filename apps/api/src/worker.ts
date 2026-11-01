import { setTimeout as delay } from 'node:timers/promises';
import { AutomationDatabase } from '@leadops/database';
import { claimedJobSchema } from '@leadops/shared';
import { processCommunication } from './modules/communications/dispatch.js';
import { parseWorkerEnv } from './config/env.js';
import { executeClaimedJob } from './modules/automation/tools.js';

const connection = parseWorkerEnv(process.env);
const db = new AutomationDatabase(connection, 'worker');
let stopping = false;
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stopping = true;
    stop.abort();
  });
try {
  await db.start();
  while (!stopping) {
    try {
      const communication = await db.claimCommunication();
      if (communication) {
        await processCommunication(db, communication);
        console.info(JSON.stringify({ event: 'communication_job_processed' }));
      }
      const claim = claimedJobSchema.nullable().parse(await db.claim());
      if (claim) {
        const result = await executeClaimedJob(db, claim);
        console.info(
          JSON.stringify({
            event: 'automation_job_processed',
            jobId: claim.id,
            jobType: claim.type,
            generation: claim.generation,
            ...result,
          }),
        );
        continue;
      }
      if (communication) continue;
    } catch {
      // No database message, credentials, job payload or contact content.
      console.error(JSON.stringify({ event: 'automation_worker_unavailable' }));
    }
    await delay(1500, undefined, { signal: stop.signal }).catch(() => {});
  }
} catch {
  console.error(JSON.stringify({ event: 'automation_worker_start_failed' }));
  process.exitCode = 1;
} finally {
  await db.close();
}
