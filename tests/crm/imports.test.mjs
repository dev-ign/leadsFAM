import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { parseEnv } from '../../apps/api/dist/config/env.js';
import { harness } from './fixture.mjs';
import { importContract } from './import-contract.mjs';
const h = await harness();
after(h.cleanup);
async function setup() {
  const person = await h.account(),
    org = await h.organization(person),
    base = `/organizations/${org}`;
  const response = await person.client.request(`${base}/contacts`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: { kind: 'person', displayName: 'Synthetic import recipient' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const contact = response.json();
  const intake = (title) => ({
    contact: { mode: 'existing', id: contact.id },
    lead: { title, priority: title === 'INVALID' ? 'invalid' : 'normal' },
    attribution: {},
  });
  return { person, org, base, contact, intake };
}

test('authenticated HTTP import passes the same pre-implementation retry contract', async (t) => {
  const f = await setup();
  const adapter = () => ({
    async execute(jobId, attemptId, rows) {
      const response = await f.person.client.request(`${f.base}/lead-imports`, {
        method: 'POST',
        body: {
          jobId,
          attemptId,
          rows: rows.map(({ value, ...row }) => ({ ...row, intake: f.intake(value) })),
        },
      });
      if (response.statusCode !== 200)
        throw Object.assign(new Error('Import failed'), { code: response.json().error.code });
      return response.json();
    },
    count: async () =>
      (
        await h.admin.query('select count(*)::int n from public.leads where organization_id=$1', [
          f.org,
        ])
      ).rows[0].n,
    reconnect: adapter,
    async loseResponse(...args) {
      await this.execute(...args);
      throw Object.assign(new Error('Lost response'), { code: 'SIMULATED_RESPONSE_LOSS' });
    },
  });
  await importContract(t, adapter());
});

test('CSV preview is stateless, detects duplicates and preserves the server delivery manifest', async () => {
  const f = await setup(),
    csv =
      'displayName,title,email\nSame prospect,First,same@example.test\nSame prospect,Second,same@example.test';
  const preview = await f.person.client.request(`${f.base}/lead-imports/preview`, {
    method: 'POST',
    body: { csv },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  const data = preview.json();
  assert.deepEqual(
    data.rows.map((r) => r.duplicateRows),
    [[2], [1]],
  );
  assert.equal(
    (
      await h.admin.query(
        'select count(*)::int n from private.lead_import_jobs where organization_id=$1',
        [f.org],
      )
    ).rows[0].n,
    0,
  );
  const body = {
    jobId: data.jobId,
    attemptId: randomUUID(),
    rows: data.rows.map((r) => ({
      deliveryId: r.deliveryId,
      rowNumber: r.rowNumber,
      intake: r.intake,
    })),
  };
  const unresolved = await f.person.client.request(`${f.base}/lead-imports`, {
    method: 'POST',
    body,
  });
  assert.equal(unresolved.statusCode, 200, unresolved.body);
  assert.ok(unresolved.json().rows.every((r) => r.code === 'DUPLICATE_REVIEW_REQUIRED'));
  const again = await f.person.client.request(`${f.base}/lead-imports/preview`, {
    method: 'POST',
    body: { csv, jobId: data.jobId },
  });
  assert.deepEqual(
    again.json().rows.map((r) => r.deliveryId),
    data.rows.map((r) => r.deliveryId),
  );
  const resolved = await f.person.client.request(`${f.base}/lead-imports`, {
    method: 'POST',
    body: {
      ...body,
      attemptId: randomUUID(),
      rows: body.rows.map((r) => ({
        ...r,
        intake: {
          ...r.intake,
          contact: {
            mode: 'create',
            data: { ...r.intake.contact.data, duplicateResolution: 'create_distinct' },
          },
        },
      })),
    },
  });
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.ok(resolved.json().rows.every((r) => r.status === 'succeeded'));
});

test('import authority precedes CSV parsing; results are scoped and attribution URLs are sanitized', async () => {
  const f = await setup(),
    member = await h.account();
  await h.admin.query(
    "insert into public.organization_memberships(organization_id,user_id,role) values($1,$2,'member')",
    [f.org, member.user],
  );
  assert.equal(
    (
      await member.client.request(`${f.base}/lead-imports/preview`, {
        method: 'POST',
        body: { csv: 'broken"csv' },
      })
    ).statusCode,
    403,
  );
  const manual = await f.person.client.request(`${f.base}/leads`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: {
      ...f.intake('Sanitized attribution'),
      attribution: {
        landingUrl: 'http://user:password@127.0.0.1:9/landing?secret=private#fragment',
      },
    },
  });
  assert.equal(manual.statusCode, 200, manual.body);
  assert.equal(manual.json().attribution.landing_url, 'http://127.0.0.1:9/landing');
  const jobId = randomUUID(),
    attemptId = randomUUID(),
    body = {
      jobId,
      attemptId,
      rows: [{ deliveryId: randomUUID(), rowNumber: 1, intake: f.intake('Safe results') }],
    };
  assert.equal(
    (await f.person.client.request(`${f.base}/lead-imports`, { method: 'POST', body })).statusCode,
    200,
  );
  const status = await f.person.client.request(`${f.base}/lead-imports/${jobId}`);
  assert.equal(status.statusCode, 200);
  assert.doesNotMatch(status.body, /Safe results|example.test|landing|password/);
  const another = await h.organization(f.person);
  assert.equal(
    (await f.person.client.request(`/organizations/${another}/lead-imports/${jobId}`)).statusCode,
    404,
  );
});

async function server() {
  const child = fork(new URL('./server-worker.mjs', import.meta.url), {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
  });
  const ready = once(child, 'message', { signal: AbortSignal.timeout(10000) });
  child.send({
    ...parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    identity: h.identity,
    crmCursorKey: h.identity.cursorKey,
  });
  const [result] = await ready;
  assert.ok(result.port, 'Real local server started');
  return {
    port: result.port,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}
test('a committed request survives a discarded response and an actual API process restart', async () => {
  const f = await setup(),
    jobId = randomUUID(),
    attemptId = randomUUID();
  const body = JSON.stringify({
    jobId,
    attemptId,
    rows: [{ deliveryId: randomUUID(), rowNumber: 1, intake: f.intake('Restart proof') }],
  });
  let running = await server(),
    socket;
  try {
    socket = connect({ host: '127.0.0.1', port: running.port });
    socket.on('error', () => {});
    await once(socket, 'connect');
    const headers = f.person.client.credentials;
    socket.write(
      `POST /v1${f.base}/lead-imports HTTP/1.1\r\nHost: 127.0.0.1:${running.port}\r\nOrigin: ${headers.origin}\r\nCookie: ${headers.cookie}\r\nX-CSRF-Token: ${headers['x-csrf-token']}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    let saved;
    for (let i = 0; i < 100 && !saved; i++) {
      saved = (
        await h.admin.query(
          'select result from private.lead_import_attempts where organization_id=$1 and job_id=$2 and id=$3',
          [f.org, jobId, attemptId],
        )
      ).rows[0]?.result;
      if (!saved) await setTimeout(30);
    }
    assert.ok(saved, 'Attempt committed before the response is read');
    socket.destroy();
    await running.stop();
    running = await server();
    const replay = await fetch(`http://127.0.0.1:${running.port}/v1${f.base}/lead-imports`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).rows, saved);
    assert.equal(
      (
        await h.admin.query('select count(*)::int n from public.leads where organization_id=$1', [
          f.org,
        ])
      ).rows[0].n,
      1,
    );
  } finally {
    socket?.destroy();
    await running.stop();
  }
});
