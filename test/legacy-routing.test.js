const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

async function start(t, flag) {
  // Keep dotenv away from any developer .env, including the absent-flag case.
  const cwd = mkdtempSync(path.join(tmpdir(), 'legacy-routing-test-'));
  const env = { PATH: process.env.PATH, PORT: '0', ADMIN_KEY: 'synthetic-admin',
    AIRTABLE_TOKEN: 'synthetic', AIRTABLE_BASE_ID: 'synthetic-base',
    META_ACCESS_TOKEN: 'synthetic', META_AD_ACCOUNT_ID: 'synthetic',
    RESEND_API_KEY: 'synthetic', ALERT_EMAIL: 'alerts@example.com',
    ZOOM_WEBHOOK_SECRET_TOKEN: 'synthetic', RENDER_GIT_COMMIT: 'synthetic-release' };
  if (flag !== undefined) env.LEGACY_ROUTING_ENABLED = flag;
  const child = fork(path.join(__dirname, 'fixtures/server.cjs'), [], {
    env, cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    rmSync(cwd, { recursive: true });
  });
  const [{ port }] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  return {
    async request(route, body = {}, method = 'POST', auth = true) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method, headers: { 'Content-Type': 'application/json', ...(auth ? { 'X-Admin-Key': 'synthetic-admin' } : {}) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
    },
    async calls() {
      const response = once(child, 'message', { signal: AbortSignal.timeout(5000) });
      child.send('calls');
      return (await response)[0].calls;
    },
  };
}

test('disabled routing refuses before provider reads, alerts or writes', async t => {
  const app = await start(t, '0');
  const result = await app.request('/route-lead', { state: 'Oregon' });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'LEGACY_ROUTING_DISABLED');
  assert.deepEqual(await app.calls(), []);
});

const mutations = [
  ['/advisors', { name: 'New advisor', calendarUrl: 'https://example.com/book' }],
  ['/advisors/update', { id: 'recSynthetic', name: 'Updated' }],
  ['/advisors/set-counts', { id: 'recSynthetic', appointmentsDeliveredThisMonth: 3 }],
  ['/advisors/toggle-active', { id: 'recSynthetic', isActive: false }],
  ['/advisors/recSynthetic', {}, 'DELETE'],
];

test('disabled advisor mutations retain admin authentication and make zero provider calls', async t => {
  const app = await start(t, '0');
  for (const [route, body, method] of mutations) {
    assert.equal((await app.request(route, body, method, false)).status, 401);
    const result = await app.request(route, body, method);
    assert.equal(result.status, 503, route);
    assert.equal(result.body.code, 'LEGACY_ROUTING_DISABLED');
  }
  assert.deepEqual(await app.calls(), []);
});

test('health identifies disabled routing and the adopted Render release', async t => {
  const app = await start(t, '0');
  assert.deepEqual(await app.request('/health', {}, 'GET', false), {
    status: 200, body: { status: 'ok', legacyRoutingEnabled: false, renderGitCommit: 'synthetic-release', inFlightTranscriptWork: 0 },
  });
  assert.deepEqual(await app.calls(), []);
});

for (const flag of [undefined, '1']) {
  test(`routing and advisor mutations preserve active behavior with flag ${String(flag)}`, async t => {
    const app = await start(t, flag);
    const result = await app.request('/route-lead', { state: 'Oregon' });
    assert.equal(result.status, 200);
    assert.equal(result.body.assignedAdvisor, 'Synthetic advisor');
    assert.equal(result.body.calendarUrl, 'https://example.com/book');
    const calls = await app.calls();
    assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH']);
    assert.deepEqual(JSON.parse(calls[1].body).fields, { 'Appointments This Month': 3, 'Appointments This Week': 2 });
    for (const [route, body, method] of mutations) {
      const mutation = await app.request(route, body, method);
      assert.equal(mutation.status, route === '/advisors' ? 201 : 200, route);
    }
    assert.deepEqual((await app.calls()).map(c => c.method), ['POST', 'PATCH', 'PATCH', 'PATCH', 'GET', 'DELETE']);
    assert.equal((await app.request('/health', {}, 'GET')).body.legacyRoutingEnabled, true);
    assert.equal((await app.request('/route-lead', {})).status, 400);
    assert.deepEqual(await app.calls(), []);
  });
}

for (const flag of ['', 'false', 'true', ' 1', '1 ', 'invalid']) {
  test(`invalid routing flag ${JSON.stringify(flag)} refuses new work`, async t => {
    const app = await start(t, flag);
    // Even missing state or advisor fields must not reach validation or provider calls.
    for (const [route, , method] of [['/route-lead'], ...mutations]) {
      assert.equal((await app.request(route, {}, method)).status, 503, route);
    }
    assert.equal((await app.request('/health', {}, 'GET')).body.legacyRoutingEnabled, false);
    assert.deepEqual(await app.calls(), []);
  });
}

test('disabled routing leaves advisor reads, shared jobs, Zoom and static routes intact', async t => {
  const app = await start(t, '0');
  assert.equal((await app.request('/advisors', {}, 'GET', false)).status, 401);
  const advisors = await app.request('/advisors', {}, 'GET');
  assert.equal(advisors.status, 200);
  assert.equal(advisors.body[0].name, 'Synthetic advisor');
  assert.deepEqual((await app.calls()).map(c => c.method), ['GET']);
  for (const route of ['/admin/sync-meta-ads', '/admin/sync-meta-spend', '/admin/sync-metrics']) {
    assert.equal((await app.request(route, {}, 'POST', false)).status, 401);
    assert.equal((await app.request(route)).status, 200, route);
  }
  const sharedCalls = await app.calls();
  assert.ok(sharedCalls.some(c => c.url.includes('graph.facebook.com')));
  assert.ok(sharedCalls.some(c => c.url.includes('api.airtable.com')));
  assert.ok(sharedCalls.every(c => !c.url.includes('/Advisors')));
  assert.deepEqual(await app.request('/zoom-webhook', { event: 'ignored.synthetic' }), { status: 200, body: { status: 'ignored' } });
  const validation = await app.request('/zoom-webhook', { event: 'endpoint.url_validation', payload: { plainToken: 'synthetic-token' } });
  assert.equal(validation.status, 200);
  assert.equal(validation.body.plainToken, 'synthetic-token');
  assert.equal(validation.body.encryptedToken, require('node:crypto').createHmac('sha256', 'synthetic').update('synthetic-token').digest('hex'));
  for (const route of ['/admin', '/ghl-embed.js']) {
    const result = await app.request(route, {}, 'GET', false);
    assert.equal(result.status, 200);
    assert.ok(result.body.length > 0);
  }
  assert.deepEqual(await app.calls(), []);
});
