// Local synthetic fixture transport only. No credentials or customer content in output.
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { localIdentity } from './local-identity.mjs';
import { deriveMockInboundCredential } from '../apps/api/dist/modules/automation/routes.js';
import { inboundMessageInput, inboundResultSchema } from '../packages/shared/dist/index.js';
const [file, integration, generation] = process.argv.slice(2);
if (
  !file ||
  !/^[a-f0-9-]{36}$/.test(integration ?? '') ||
  !/^[1-9][0-9]{0,8}$/.test(generation ?? '')
)
  throw new Error(
    'Use: node scripts/mock-inbound.mjs <synthetic-event.json> <integration-id> <credential-generation>',
  );
const input = inboundMessageInput.parse(JSON.parse(await readFile(file, 'utf8')));
const local = await localIdentity(),
  key = deriveMockInboundCredential(local.mockWebhookSecret, integration, Number(generation));
const raw = JSON.stringify(input),
  timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', Buffer.from(key.slice(7), 'base64url'))
  .update(`${timestamp}.`)
  .update(raw)
  .digest('hex');
const response = await fetch('http://127.0.0.1:3001/webhooks/mock/inbound', {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(10000),
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    'x-mock-timestamp': timestamp,
    'x-mock-signature': signature,
  },
  body: raw,
});
if (!response.ok)
  throw new Error(
    `Synthetic ingress rejected (${response.status}); check connector status and generation.`,
  );
console.log(JSON.stringify(inboundResultSchema.parse(await response.json())));
