'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { createInFlightTracker, createGracefulShutdown } = require('../src/gracefulShutdown');
const { createZoomRouter } = require('../src/routes/zoom');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function transcriptEvent() {
  return {
    event: 'recording.transcript_completed',
    download_token: 'synthetic-token',
    payload: {
      object: {
        id: 'meeting-1',
        share_url: 'https://zoom.synthetic/share',
        recording_files: [{ file_type: 'TRANSCRIPT', download_url: 'https://zoom.synthetic/transcript' }],
      },
    },
  };
}

test('acknowledged transcript work drains before graceful shutdown completes', async t => {
  const tracker = createInFlightTracker();
  let releaseTranscript;
  const transcriptReady = new Promise(resolve => { releaseTranscript = resolve; });
  t.mock.method(global, 'fetch', async url => {
    if (String(url) === 'https://zoom.synthetic/transcript') {
      await transcriptReady;
      return new Response('synthetic transcript');
    }
    if (String(url).includes('openai.com')) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({}) } }] });
    }
    return Response.json({ records: [] });
  });
  const app = express();
  app.use(express.json());
  app.use('/zoom-webhook', createZoomRouter({ transcriptTracker: tracker }));
  app.get('/health', (req, res) => res.json({ inFlightTranscriptWork: tracker.getCount() }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => close(server));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/zoom-webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(transcriptEvent()),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'received' });
  assert.equal(tracker.getCount(), 1);

  const shutdown = createGracefulShutdown({ server, tracker, timeoutMs: 100, forceExit: () => assert.fail('shutdown forced exit'), log: { log() {}, error() {} } });
  const draining = shutdown('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracker.getCount(), 1);

  releaseTranscript();
  assert.deepEqual(await draining, { drained: true, forced: false });
  assert.equal(tracker.getCount(), 0);
});

test('graceful shutdown forces exit after its bounded drain timeout', async () => {
  const tracker = createInFlightTracker();
  const release = tracker.accept();
  let forcedCode;
  const server = { close() {}, closeIdleConnections() {} };
  const shutdown = createGracefulShutdown({ server, tracker, timeoutMs: 25, forceExit: code => { forcedCode = code; }, log: { log() {}, error() {} } });

  const started = Date.now();
  assert.deepEqual(await shutdown('SIGTERM'), { drained: false, forced: true });
  const elapsed = Date.now() - started;
  assert.equal(forcedCode, 1);
  assert.ok(elapsed >= 20 && elapsed < 500, `fallback elapsed ${elapsed}ms`);
  release();
});

test('shutdown admission closes before new transcript work is acknowledged', async () => {
  const tracker = createInFlightTracker();
  tracker.beginDraining();
  const app = express();
  app.use(express.json());
  app.use('/zoom-webhook', createZoomRouter({ transcriptTracker: tracker }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/zoom-webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(transcriptEvent()),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'shutting_down' });
  } finally {
    await close(server);
  }
});
