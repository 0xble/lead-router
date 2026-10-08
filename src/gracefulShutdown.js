'use strict';

function createInFlightTracker() {
  let inFlight = 0;
  let draining = false;
  const drainWaiters = new Set();

  function notifyIfDrained() {
    if (inFlight !== 0) return;
    for (const resolve of drainWaiters) resolve(true);
    drainWaiters.clear();
  }

  return {
    accept() {
      if (draining) return null;
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
        notifyIfDrained();
      };
    },
    beginDraining() {
      draining = true;
      notifyIfDrained();
    },
    getCount() {
      return inFlight;
    },
    waitForDrain(timeoutMs) {
      if (inFlight === 0) return Promise.resolve(true);
      return new Promise(resolve => {
        let settled = false;
        const finish = drained => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          drainWaiters.delete(onDrain);
          resolve(drained);
        };
        const onDrain = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        drainWaiters.add(onDrain);
      });
    },
  };
}

function createGracefulShutdown({ server, tracker, timeoutMs = 25_000, forceExit = code => process.exit(code), log = console }) {
  let shutdownPromise;

  return function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      tracker.beginDraining();
      log.log(`[shutdown] ${signal} received; draining ${tracker.getCount()} transcript task(s)`);

      try {
        server.close();
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      } catch (err) {
        log.error('[shutdown] Failed to stop accepting connections:', err.message);
      }

      const drained = await tracker.waitForDrain(timeoutMs);
      if (drained) {
        log.log('[shutdown] Transcript tasks drained');
        return { drained: true, forced: false };
      }

      log.error(`[shutdown] Transcript drain exceeded ${timeoutMs}ms; forcing exit`);
      forceExit(1);
      return { drained: false, forced: true };
    })();

    return shutdownPromise;
  };
}

module.exports = { createInFlightTracker, createGracefulShutdown };
